// 隧道帧协议：在 WebSocket 上传输的二进制帧。
// 该 TS 版本供 Worker（Relay）使用；ESP32 端在 ESP32_WOL_Tunnel.ino 中以等价字节布局实现。
//
// 帧布局（所有帧首字节为类型，随后为 channel 或 MAC）：
//   OPEN    0x01 + channel(1B) + ip(4B)      + port(2B)   用户->ESP32
//   OPEN_OK 0x02 + channel(1B)                            ESP32->用户
//   DATA    0x03 + channel(1B) + payload                  双向
//   CLOSE   0x04 + channel(1B)                            双向
//   WOL     0x05 + mac(6B)                                用户->ESP32
//     mac 全 0 表示「用 ESP32 固件里的默认 MAC」——手机端一键唤醒时用这个。
//
// ── 控制面（新增，v2）─────────────────────────────────────────────
// 控制消息走 **WebSocket 文本帧（JSON）**，与上面 5 个二进制帧共存互不干扰。
// 为什么不用二进制：CALL 的参数是结构化的（host/path/headers），变长字符串塞进
// 定长帧要自己做 TLV，ESP32 端还得手写解析；而数据体回传仍然复用 DATA 帧，
// 所以大字节流不受 JSON 影响（JSON 只承载"接头暗号"，不承载载荷）。
//
//   call   Worker -> 设备   发起一次工具调用，ch 是结果体回传用的 DATA 通道号
//   result 设备 -> Worker   调用结束（ok/err/meta），随后关闭该通道
//   hello  设备 -> Worker   连上时的自我介绍（型号/固件版本/支持的工具集）
//   hb     设备 -> Worker   周期心跳（heap/rssi/uptime/活跃连接数）
//   ping/pong               探活（当前未启用，留给后续离线判定用）

export const FrameType = {
  OPEN: 0x01,
  OPEN_OK: 0x02,
  DATA: 0x03,
  CLOSE: 0x04,
  WOL: 0x05,
} as const;

export type Frame =
  | { type: 0x01; channel: number; ip: string; port: number }
  | { type: 0x02; channel: number }
  | { type: 0x03; channel: number; payload: Uint8Array }
  | { type: 0x04; channel: number }
  | { type: 0x05; mac: Uint8Array };

function ipToBytes(ip: string): Uint8Array {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`invalid IPv4: ${ip}`);
  }
  return Uint8Array.from(parts);
}

function bytesToIp(b: Uint8Array, offset: number): string {
  return `${b[offset]}.${b[offset + 1]}.${b[offset + 2]}.${b[offset + 3]}`;
}

export function macToBytes(mac: string): Uint8Array {
  const parts = mac.split(/[:-]/).map((h) => parseInt(h, 16));
  if (parts.length !== 6 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`invalid MAC: ${mac}`);
  }
  return Uint8Array.from(parts);
}

export function bytesToMac(b: Uint8Array, offset = 0): string {
  const hex: string[] = [];
  for (let i = 0; i < 6; i++) hex.push(b[offset + i].toString(16).padStart(2, '0').toUpperCase());
  return hex.join(':');
}

export function encodeOpen(channel: number, ip: string, port: number): ArrayBuffer {
  const buf = new Uint8Array(8);
  buf[0] = FrameType.OPEN;
  buf[1] = channel & 0xff;
  buf.set(ipToBytes(ip), 2);
  buf[6] = (port >> 8) & 0xff;
  buf[7] = port & 0xff;
  return buf.buffer;
}

export function encodeOpenOk(channel: number): ArrayBuffer {
  const buf = new Uint8Array(2);
  buf[0] = FrameType.OPEN_OK;
  buf[1] = channel & 0xff;
  return buf.buffer;
}

export function encodeData(channel: number, payload: Uint8Array): ArrayBuffer {
  const buf = new Uint8Array(2 + payload.length);
  buf[0] = FrameType.DATA;
  buf[1] = channel & 0xff;
  buf.set(payload, 2);
  return buf.buffer;
}

export function encodeClose(channel: number): ArrayBuffer {
  const buf = new Uint8Array(2);
  buf[0] = FrameType.CLOSE;
  buf[1] = channel & 0xff;
  return buf.buffer;
}

// mac 省略 → 全 0 帧，ESP32 收到后使用固件里的默认 MAC
export function encodeWol(mac?: string): ArrayBuffer {
  const buf = new Uint8Array(7);
  buf[0] = FrameType.WOL;
  if (mac) buf.set(macToBytes(mac), 1);
  return buf.buffer;
}

export function decode(frame: ArrayBufferLike): Frame {
  const b = new Uint8Array(frame);
  if (b.length < 1) throw new Error('empty frame');
  const type = b[0] as Frame['type'];
  switch (type) {
    case FrameType.OPEN: {
      if (b.length < 8) throw new Error('OPEN frame too short');
      const channel = b[1];
      const ip = bytesToIp(b, 2);
      const port = (b[6] << 8) | b[7];
      return { type, channel, ip, port };
    }
    case FrameType.OPEN_OK:
    case FrameType.CLOSE: {
      const channel = b[1];
      return type === FrameType.OPEN_OK
        ? { type: FrameType.OPEN_OK, channel }
        : { type: FrameType.CLOSE, channel };
    }
    case FrameType.DATA: {
      const channel = b[1];
      const payload = b.slice(2);
      return { type: FrameType.DATA, channel, payload };
    }
    case FrameType.WOL: {
      if (b.length < 7) throw new Error('WOL frame too short');
      const mac = b.slice(1, 7);
      return { type: FrameType.WOL, mac };
    }
    default:
      throw new Error(`unknown frame type: ${type}`);
  }
}

// ─────────────────────────── 控制面消息 ───────────────────────────

/** 工具调用的结果元信息。字段全部可选：不同工具关心的东西不一样。 */
export interface ResultMeta {
  /** 目标站点返回的 HTTP 状态码（有 HTTP 语义的工具才填） */
  status?: number;
  /** 结果体总字节数，由设备核对自身发出的 DATA 字节数 */
  bytes?: number;
  /** 设备侧耗时（毫秒） */
  ms?: number;
  /** 实际连接的目标主机，便于排查 DNS / 跳转 */
  host?: string;
  /** 重定向次数 */
  redirects?: number;
}

export type CtrlMsg =
  | {
      t: 'hello';
      node: string;
      model?: string;
      fw?: string;
      tools?: string[];
      /** 设备自报的并发上限（按自身 heap 预算算，C6 一般 2~3） */
      capacity?: number;
      heap?: number;
      rssi?: number;
      ip?: string;
    }
  | { t: 'hb'; heap?: number; rssi?: number; up?: number; conns?: number; fw?: string }
  | { t: 'result'; id: string; ok: boolean; err?: string; meta?: ResultMeta }
  | { t: 'call'; id: string; tool: string; args: Record<string, unknown>; ch: number }
  | { t: 'ping'; id: string }
  | { t: 'pong'; id: string };

export function encodeCtrl(msg: CtrlMsg): string {
  return JSON.stringify(msg);
}

/**
 * 解析控制消息。任何不合规输入返回 null 而不是抛错 —— 设备端固件版本参差，
 * 上层（Relay）宁可丢掉一条坏消息，也不能让整条隧道因为一个畸形 JSON 崩掉。
 */
export function decodeCtrl(raw: string): CtrlMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.t !== 'string') return null;

  const num = (x: unknown): number | undefined =>
    typeof x === 'number' && Number.isFinite(x) ? x : undefined;
  const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);

  switch (o.t) {
    case 'hello': {
      const node = str(o.node);
      if (!node) return null;
      return {
        t: 'hello',
        node,
        model: str(o.model),
        fw: str(o.fw),
        tools: Array.isArray(o.tools)
          ? o.tools.filter((x): x is string => typeof x === 'string')
          : [],
        capacity: num(o.capacity),
        heap: num(o.heap),
        rssi: num(o.rssi),
        ip: str(o.ip),
      };
    }
    case 'hb':
      return {
        t: 'hb',
        heap: num(o.heap),
        rssi: num(o.rssi),
        up: num(o.up),
        conns: num(o.conns),
        fw: str(o.fw),
      };
    case 'result': {
      const id = str(o.id);
      if (!id) return null;
      const meta = o.meta;
      return {
        t: 'result',
        id,
        ok: o.ok === true,
        err: str(o.err),
        meta: typeof meta === 'object' && meta !== null ? (meta as ResultMeta) : undefined,
      };
    }
    case 'call': {
      const id = str(o.id);
      const tool = str(o.tool);
      const ch = num(o.ch);
      if (!id || !tool || ch === undefined) return null;
      const args = o.args;
      return {
        t: 'call',
        id,
        tool,
        ch,
        args: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
      };
    }
    case 'ping':
    case 'pong': {
      const id = str(o.id);
      if (!id) return null;
      return { t: o.t, id };
    }
    default:
      return null;
  }
}

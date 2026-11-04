// protocol.mjs —— worker/src/protocol.ts 的 JS 镜像，供本地 e2e 验证使用。
// 字节布局必须与 TS 版和 ESP32 固件保持一致。

export const FrameType = {
  OPEN: 0x01,
  OPEN_OK: 0x02,
  DATA: 0x03,
  CLOSE: 0x04,
  WOL: 0x05,
};

function ipToBytes(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`invalid IPv4: ${ip}`);
  }
  return Uint8Array.from(parts);
}

function bytesToIp(b, offset) {
  return `${b[offset]}.${b[offset + 1]}.${b[offset + 2]}.${b[offset + 3]}`;
}

export function macToBytes(mac) {
  const parts = mac.split(/[:-]/).map((h) => parseInt(h, 16));
  if (parts.length !== 6 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`invalid MAC: ${mac}`);
  }
  return Uint8Array.from(parts);
}

export function bytesToMac(b, offset = 0) {
  const hex = [];
  for (let i = 0; i < 6; i++) hex.push(b[offset + i].toString(16).padStart(2, '0').toUpperCase());
  return hex.join(':');
}

export function encodeOpen(channel, ip, port) {
  const buf = new Uint8Array(8);
  buf[0] = FrameType.OPEN;
  buf[1] = channel & 0xff;
  buf.set(ipToBytes(ip), 2);
  buf[6] = (port >> 8) & 0xff;
  buf[7] = port & 0xff;
  return buf;
}

export function encodeOpenOk(channel) {
  return Uint8Array.from([FrameType.OPEN_OK, channel & 0xff]);
}

export function encodeData(channel, payload) {
  const buf = new Uint8Array(2 + payload.length);
  buf[0] = FrameType.DATA;
  buf[1] = channel & 0xff;
  buf.set(payload, 2);
  return buf;
}

export function encodeClose(channel) {
  return Uint8Array.from([FrameType.CLOSE, channel & 0xff]);
}

// mac 省略 → 全 0 帧（ESP32 用固件默认 MAC）
export function encodeWol(mac) {
  const buf = new Uint8Array(7);
  buf[0] = FrameType.WOL;
  if (mac) buf.set(macToBytes(mac), 1);
  return buf;
}

export function decode(frame) {
  const b = new Uint8Array(frame);
  if (b.length < 1) throw new Error('empty frame');
  const type = b[0];
  switch (type) {
    case FrameType.OPEN: {
      if (b.length < 8) throw new Error('OPEN frame too short');
      return { type, channel: b[1], ip: bytesToIp(b, 2), port: (b[6] << 8) | b[7] };
    }
    case FrameType.OPEN_OK:
      return { type, channel: b[1] };
    case FrameType.CLOSE:
      return { type, channel: b[1] };
    case FrameType.DATA:
      return { type, channel: b[1], payload: b.slice(2) };
    case FrameType.WOL: {
      if (b.length < 7) throw new Error('WOL frame too short');
      return { type, mac: b.slice(1, 7) };
    }
    default:
      throw new Error(`unknown frame type: ${type}`);
  }
}

// ── 控制面（JSON 文本帧），与 worker/src/protocol.ts 的 encodeCtrl / decodeCtrl 等价

export function encodeCtrl(msg) {
  return JSON.stringify(msg);
}

export function decodeCtrl(raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  if (typeof v.t !== 'string') return null;
  switch (v.t) {
    case 'hello':
      if (typeof v.node !== 'string' || !v.node) return null;
      return { ...v, tools: Array.isArray(v.tools) ? v.tools : [] };
    case 'hb':
      return v;
    case 'result':
      if (typeof v.id !== 'string' || !v.id) return null;
      return { ...v, ok: v.ok === true };
    case 'call':
      if (typeof v.id !== 'string' || typeof v.tool !== 'string' || typeof v.ch !== 'number') {
        return null;
      }
      return { ...v, args: v.args && typeof v.args === 'object' ? v.args : {} };
    case 'ping':
    case 'pong':
      return typeof v.id === 'string' ? v : null;
    default:
      return null;
  }
}

// tunnel-manager.mjs —— 本地端口 -> 隧道 -> 局域网目标 的运行时管理器。
// 逻辑严格对齐 client/tunnel.mjs（同一套帧协议、同一套「先缓冲、OPEN_OK 后补发」策略），
// 区别是内联在控制台进程里，从而能拿到每个映射的实时连接数 / 上下行字节 / 最近错误。
//
// 每个映射 = 一个 net.Server；每来一个本地 TCP 连接，就向 Worker 开一条 user WS，
// 发 OPEN(channel, targetHost, targetPort)，由局域网内的 ESP32 去拨号并双向转发。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { encodeOpen, encodeData, encodeClose, decode, FrameType } from '../test/protocol.mjs';

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function validPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** 校验并规整一条映射定义；不合法则抛错 */
export function validateDef(d) {
  const localPort = Number(d.localPort);
  const targetPort = Number(d.targetPort);
  const targetHost = String(d.targetHost || '').trim();
  if (!validPort(localPort)) throw new Error('本地端口需为 1-65535');
  if (!validPort(targetPort)) throw new Error('目标端口需为 1-65535');
  if (!IPV4.test(targetHost)) throw new Error('目标 IP 需为合法的 IPv4，如 192.168.1.50');
  const bind = d.bind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  return {
    name: String(d.name || '').trim() || `${localPort}→${targetHost}:${targetPort}`,
    localPort,
    targetHost,
    targetPort,
    bind,
    autostart: d.autostart !== false,
  };
}

export class TunnelManager {
  constructor({ workerBase, tunnel, token, file, onChange }) {
    this.workerBase = String(workerBase || '').replace(/\/+$/, '');
    this.wsBase = this.workerBase.replace(/^http/i, 'ws');
    this.tunnel = tunnel || 'wol';
    this.token = token || '';
    this.file = file;
    this.onChange = onChange || (() => {});
    this.tunnels = new Map();
    this._seq = 0;
    this._load();
  }

  // ---- 持久化（只存定义，不存运行时统计）----
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const d of raw.tunnels || []) {
        try {
          const v = validateDef(d);
          this._create(d.id, v);
        } catch { /* 跳过损坏条目 */ }
      }
    } catch { /* 文件不存在=首次运行 */ }
  }

  _save() {
    const defs = [...this.tunnels.values()].map((t) => ({
      id: t.id, name: t.name, localPort: t.localPort,
      targetHost: t.targetHost, targetPort: t.targetPort,
      bind: t.bind, autostart: t.autostart,
    }));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ tunnels: defs }, null, 2));
    } catch { /* 忽略写入失败 */ }
  }

  _create(id, v) {
    const t = {
      id,
      ...v,
      running: false,
      server: null,
      conns: new Set(),      // 当前活跃连接
      connCount: 0,          // 当前连接数
      totalConns: 0,         // 累计连接数
      bytesUp: 0,            // 本地 -> 远程（用户发出的字节）
      bytesDown: 0,          // 远程 -> 本地（目标回传的字节）
      lastError: '',
      startedAt: 0,
    };
    this.tunnels.set(id, t);
    return t;
  }

  // ---- 对外可序列化视图 ----
  list() {
    return [...this.tunnels.values()].map((t) => ({
      id: t.id, name: t.name,
      localPort: t.localPort, targetHost: t.targetHost, targetPort: t.targetPort,
      bind: t.bind, autostart: t.autostart,
      running: t.running, connCount: t.connCount, totalConns: t.totalConns,
      bytesUp: t.bytesUp, bytesDown: t.bytesDown,
      lastError: t.lastError, startedAt: t.startedAt,
    }));
  }

  get(id) { return this.tunnels.get(id); }

  add(def) {
    const v = validateDef(def);
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const t = this._create(id, v);
    this._save();
    if (def.start !== false) this.start(id);
    this.onChange();
    return t;
  }

  remove(id) {
    const t = this.tunnels.get(id);
    if (!t) return false;
    this.stop(id);
    this.tunnels.delete(id);
    this._save();
    this.onChange();
    return true;
  }

  update(id, patch) {
    const t = this.tunnels.get(id);
    if (!t) return null;
    // 运行中不允许改地址，先停再改
    const wasRunning = t.running;
    const merged = validateDef({
      name: patch.name ?? t.name,
      localPort: patch.localPort ?? t.localPort,
      targetHost: patch.targetHost ?? t.targetHost,
      targetPort: patch.targetPort ?? t.targetPort,
      bind: patch.bind ?? t.bind,
      autostart: patch.autostart ?? t.autostart,
    });
    if (wasRunning) this.stop(id);
    Object.assign(t, merged);
    this._save();
    if (patch.start === true || (wasRunning && patch.start !== false)) this.start(id);
    this.onChange();
    return t;
  }

  _applyError(t, msg) {
    t.lastError = String(msg || '').slice(0, 200);
    this.onChange();
  }

  start(id) {
    const t = this.tunnels.get(id);
    if (!t || t.running) return t;
    t.lastError = '';
    const server = net.createServer((socket) => this._handleConn(t, socket));
    server.on('error', (e) => {
      this._applyError(t, `监听失败: ${e.message}`);
      t.running = false;
    });
    // 立即置为运行中（listen 回调是异步的），失败时由上/下方错误处理回滚
    t.running = true;
    t.startedAt = Date.now();
    try {
      server.listen(t.localPort, t.bind, () => this.onChange());
    } catch (e) {
      this._applyError(t, e.message);
      t.running = false;
      return t;
    }
    t.server = server;
    return t;
  }

  async stop(id) {
    const t = this.tunnels.get(id);
    if (!t) return t;
    if (t.server) {
      const s = t.server;
      t.server = null;
      await new Promise((r) => { try { s.close(() => r()); } catch { r(); } });
    }
    for (const c of t.conns) {
      try { c.ws && c.ws.close(); } catch { /* ignore */ }
      try { c.socket && c.socket.destroy(); } catch { /* ignore */ }
    }
    t.conns.clear();
    t.connCount = 0;
    t.running = false;
    this.onChange();
    return t;
  }

  async stopAll() {
    for (const id of this.tunnels.keys()) await this.stop(id);
  }

  /** 启动所有 autostart 的映射（开机自恢复） */
  startAutostart() {
    for (const t of this.tunnels.values()) {
      if (t.autostart && !t.running) this.start(t.id);
    }
  }

  // ---- 单条本地连接的处理：与 client/tunnel.mjs 等价 ----
  _handleConn(t, socket) {
    const channel = 1 + (this._seq++ % 254);
    const token = this.token;
    const url = `${this.wsBase}/ws/${encodeURIComponent(this.tunnel)}/user` +
      (token ? `?token=${encodeURIComponent(token)}` : '');

    const ws = new WebSocket(
      url,
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
    );
    const conn = { socket, ws, channel };
    t.conns.add(conn);
    t.connCount = t.conns.size;
    t.totalConns++;

    let established = false;
    const pending = []; // OPEN_OK 之前缓冲的本地数据，到达后按序补发

    const cleanup = () => {
      if (t.conns.delete(conn)) { t.connCount = t.conns.size; this.onChange(); }
    };

    ws.on('open', () => ws.send(encodeOpen(channel, t.targetHost, t.targetPort)));

    ws.on('message', (data) => {
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      let f;
      try { f = decode(buf); } catch { return; }
      if (f.type === FrameType.OPEN_OK) {
        established = true;
        for (const c of pending) ws.send(encodeData(channel, new Uint8Array(c)));
        pending.length = 0;
      } else if (f.type === FrameType.DATA) {
        t.bytesDown += f.payload.length;
        socket.write(Buffer.from(f.payload));
      } else if (f.type === FrameType.CLOSE) {
        socket.end();
      }
    });

    socket.on('data', (chunk) => {
      t.bytesUp += chunk.length;
      if (!established) { pending.push(chunk); return; }
      try { ws.send(encodeData(channel, new Uint8Array(chunk))); } catch { /* ignore */ }
    });

    socket.on('close', () => {
      try { ws.send(encodeClose(channel)); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      cleanup();
    });

    socket.on('error', () => {
      try { ws.close(); } catch { /* ignore */ }
    });

    ws.on('close', () => {
      try { socket.end(); } catch { /* ignore */ }
      cleanup();
    });

    ws.on('unexpected-response', (_req, res) => {
      this._applyError(t, `握手被拒 HTTP ${res.statusCode}（token 是否正确？）`);
      try { socket.destroy(); } catch { /* ignore */ }
      cleanup();
    });

    ws.on('error', (e) => {
      this._applyError(t, `WS 错误: ${e.message}`);
      try { socket.destroy(); } catch { /* ignore */ }
      cleanup();
    });
  }
}

// e2e.mjs —— 端到端真实验证：Node 等价中继 + 模拟 ESP32 + 真实 TCP 回显 + 手动 WOL
//          + v2 控制面（hello 注册 / 工具调用 / 心跳 / 离线判定）。
// 用法：node test/e2e.mjs
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { createRelay, setManagerBase } from './relay-node.mjs';
import { createManager } from './manager-node.mjs';
import { startMockEsp32 } from './mock-esp32.mjs';
import { encodeOpen, encodeData, decode, FrameType, bytesToMac } from './protocol.mjs';

const TUNNEL = 'wol';
let BASE = '';
let WSURL = '';

let passed = 0;
let failed = 0;
function ok(name) {
  passed++;
  console.log('  \u2713', name);
}
function fail(name, e) {
  failed++;
  console.log('  \u2717', name, '->', e?.message ?? e);
}

function waitFor(cond, timeoutMs, what) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`超时: ${what}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function connectUser(channel, host, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSURL}/ws/${TUNNEL}/user`);
    const timer = setTimeout(() => reject(new Error('user connect timeout')), 8000);
    ws.on('open', () => ws.send(encodeOpen(channel, host, port)));
    ws.on('message', (data) => {
      const f = decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      if (f.type === FrameType.OPEN_OK) {
        clearTimeout(timer);
        resolve(ws);
      } else if (f.type === FrameType.CLOSE) {
        clearTimeout(timer);
        reject(new Error('OPEN 被拒（通道关闭）'));
      }
    });
    ws.on('error', reject);
  });
}

function sendAndWaitEcho(ws, channel, msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('echo timeout')), 8000);
    const onMsg = (data) => {
      const f = decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      if (f.type === FrameType.DATA) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(Buffer.from(f.payload).toString('utf8'));
      }
    };
    ws.on('message', onMsg);
    ws.send(encodeData(channel, new TextEncoder().encode(msg)));
  });
}

async function main() {
  const relay = createRelay();
  const { server } = relay;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  BASE = `http://127.0.0.1:${PORT}`;
  WSURL = `ws://127.0.0.1:${PORT}`;
  console.log(`[e2e] Node 中继已起 ${BASE}`);

  // 本地回显服务，冒充局域网主机
  const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;

  let esp;
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${BASE}/status/${TUNNEL}`)).ok;
      } catch {
        return false;
      }
    }, 8000, 'relay ready');
    ok('中继就绪 (/status/wol 返回 200)');

    // 模拟局域网主机 10.0.0.99，实际拨号到本地回显服务
    esp = startMockEsp32({
      wsUrl: WSURL,
      tunnel: TUNNEL,
      dialMap: { [`10.0.0.99:${echoPort}`]: { host: '127.0.0.1', port: echoPort } },
    });
    await esp.ready();
    await waitFor(async () => {
      const d = await (await fetch(`${BASE}/status/${TUNNEL}`)).json();
      return d.esp32 === true;
    }, 8000, 'esp32 online');
    ok('模拟 ESP32 已连入中继，/status 显示在线');

    // ---- 隧道双向转发 ----
    const ch = 7;
    const userWs = await connectUser(ch, '10.0.0.99', echoPort);
    ok('用户连接建立并收到 OPEN_OK');

    const echoed = await sendAndWaitEcho(userWs, ch, 'hello-tunnel');
    if (echoed === 'hello-tunnel') ok('双向转发正确 (用户→ESP32→回显→用户)');
    else throw new Error(`回显不匹配: ${echoed}`);

    // ---- 多通道隔离 ----
    const u1 = await connectUser(11, '10.0.0.99', echoPort);
    const u2 = await connectUser(12, '10.0.0.99', echoPort);
    const [r1, r2] = await Promise.all([
      sendAndWaitEcho(u1, 11, 'AAAA'),
      sendAndWaitEcho(u2, 12, 'BBBB'),
    ]);
    if (r1 === 'AAAA' && r2 === 'BBBB') ok('多通道隔离正确 (ch11/ch12 互不串数据)');
    else throw new Error(`多通道串数据: ${r1}/${r2}`);

    // ---- 手动发送 WOL：指定 MAC ----
    const mac = process.argv[2] || 'AA:BB:CC:DD:EE:FF';
    const r = await fetch(`${BASE}/wol/${TUNNEL}/${mac}`);
    const body = await r.text();
    const rec = await esp.waitForWol();
    if (r.status === 200 && rec.mac === mac) ok(`手动 WOL 送达 ESP32，MAC 一致 (${rec.mac}) [HTTP ${r.status}: ${body}]`);
    else throw new Error(`WOL mac 不匹配: 期望 ${mac} 实收 ${rec.mac}`);

    // ---- 手动发送 WOL：不指定 MAC（全 0 帧 = 用固件默认 MAC）----
    const r2w = await fetch(`${BASE}/wol/${TUNNEL}`);
    const body2 = await r2w.text();
    const all = await esp.waitForWolCount(2);
    const rec2 = all[1];
    if (r2w.status === 200 && rec2.allZero) ok(`默认 MAC 手动 WOL 送达（全 0 帧，固件用 TARGET_MAC）[HTTP ${r2w.status}: ${body2}]`);
    else throw new Error(`默认 WOL 帧不是全 0: ${rec2.mac}`);

    // ---- 面板页 ----
    const panel = await fetch(`${BASE}/panel/${TUNNEL}`);
    const html = await panel.text();
    if (panel.status === 200 && html.includes('一键唤醒')) ok('手机操作页 /panel/wol 返回可用 HTML（含一键唤醒按钮）');
    else throw new Error('panel 页面异常');

    // ---- ESP32 离线时的手动发送 ----
    esp.close();
    await waitFor(async () => {
      const d = await (await fetch(`${BASE}/status/${TUNNEL}`)).json();
      return d.esp32 === false;
    }, 8000, 'esp32 offline');
    const off = await fetch(`${BASE}/wol/${TUNNEL}`);
    if (off.status === 503) ok('ESP32 离线时手动 WOL 返回 503（不假装成功）');
    else throw new Error(`离线 WOL 状态码异常: ${off.status}`);

    // ══════════ 控制面 v2：hello 注册 / 工具调用 / 心跳 / 离线判定 ══════════
    // clientKeys 在这里给出，是为了下面能验证「每把 key 独立限额」——
    // 这是给其他项目开放出口时唯一的安全边界，必须被自动化守住。
    const mgr = createManager({
      relayBase: BASE,
      ttl: 6000,
      clientKeys: [
        { name: 'tiny', key: 'sk_tiny', dayCalls: 2 },
        { name: 'tinyBytes', key: 'sk_tiny_bytes', dayBytes: 5000 },
        { name: 'rich', key: 'sk_rich', dayCalls: 999 },
      ],
    });
    await new Promise((r) => mgr.server.listen(0, '127.0.0.1', r));
    const MGR = `http://127.0.0.1:${mgr.server.address().port}`;
    setManagerBase(MGR);
    ok(`Manager 控制面已起 ${MGR}（心跳 TTL 6s）`);

    // 假「目标站点」：内容固定，用于字节级比对（真实固件这一步是 TLS 连目标站）
    const PAGE = Buffer.concat([
      Buffer.from('<html>page-'),
      Buffer.alloc(20000, 0x44),
      Buffer.from('</html>'),
    ]);
    const target = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((r) => target.listen(0, '127.0.0.1', r));
    const targetPort = target.address().port;

    const esp2 = startMockEsp32({
      wsUrl: WSURL,
      tunnel: TUNNEL,
      node: 'c6-01',
      fw: '1.2.0',
      capacity: 2,
      heartbeatMs: 700,
      toolHandlers: {
        https_fetch: async () => {
          const r = await fetch(`http://127.0.0.1:${targetPort}/share/video/1`);
          const ab = await r.arrayBuffer();
          return { ok: true, status: r.status, body: Buffer.from(ab), host: 'v.douyin.com' };
        },
      },
    });
    await esp2.ready();

    await waitFor(async () => {
      const d = await (await fetch(`${MGR}/snapshot`)).json();
      return d.nodes.some((n) => n.nodeId === 'c6-01' && n.online && n.tools.includes('https_fetch'));
    }, 8000, 'hello 注册');
    ok('ESP32 hello 到达 Manager：节点上线，工具表已登记');

    await waitFor(async () => {
      const d = await (await fetch(`${MGR}/snapshot`)).json();
      const n = d.nodes.find((x) => x.nodeId === 'c6-01');
      return !!n && n.heapSeries.length >= 2;
    }, 8000, 'heartbeat series');
    ok('周期心跳被接收，heap 序列已累积（面板曲线的数据来源）');

    const callRes = await fetch(`${MGR}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'https_fetch',
        args: { host: 'v.douyin.com', path: '/share/video/1' },
      }),
    });
    const call = await callRes.json();
    const got = Buffer.from(call.data || '', 'base64');
    if (call.ok && got.length === PAGE.length && Buffer.compare(got, PAGE) === 0) {
      ok(
        `工具调用链路通：${got.length} 字节与原文件逐字节一致（分 ${Math.ceil(got.length / 4096)} 块 DATA 回传）`
      );
    } else {
      throw new Error(
        `工具调用字节不一致 ok=${call.ok} got=${got.length} want=${PAGE.length} err=${call.err}`
      );
    }

    const snap = await (await fetch(`${MGR}/snapshot`)).json();
    if (
      snap.tasks.length === 1 &&
      snap.tasks[0].ok === true &&
      snap.stats.todayOk === 1 &&
      snap.stats.successRate === 100
    ) {
      ok('面板快照记录了任务与统计（tasks=1 / todayOk=1 / 成功率 100%）');
    } else {
      throw new Error(`快照统计异常: ${JSON.stringify(snap.stats)} tasks=${snap.tasks.length}`);
    }

    // ══════════ 配额：这是「给别的项目开放出口」唯一的安全边界 ══════════
    // 场景不是构造出来的：真把 key 发给同学的项目后，唯一能兜住的就是这个。
    const callAs = (clientKey) =>
      fetch(`${MGR}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tool: 'https_fetch',
          args: { host: 'v.douyin.com', path: '/share/video/1' },
          clientKey,
        }),
      });

    const q1 = await callAs('tiny');
    const q2 = await callAs('tiny');
    const q3 = await callAs('tiny');
    ok(
      `调用次数限额生效：前 2 次放行（${q1.status}/${q2.status}），第 3 次被拒（${q3.status}）`,
      q1.status === 200 && q2.status === 200 && q3.status === 429
    );
    const q3body = await q3.json();
    ok(
      `超限返回 quota_calls 并说明原因（${q3body.error}：${q3body.detail}）`,
      q3body.error === 'quota_calls' && !!q3body.detail
    );

    const b1 = await callAs('tinyBytes');
    const b2 = await callAs('tinyBytes');
    ok(
      `流量限额生效：第 1 次放行（${b1.status}），超预算后第 2 次被拒（${b2.status}）`,
      b1.status === 200 && b2.status === 429
    );
    const b2body = await b2.json();
    ok(
      `超流量返回 quota_bytes（${b2body.detail}）`,
      b2body.error === 'quota_bytes'
    );

    const richRes = await callAs('rich');
    ok(
      '限额互相隔离：另一把 key 不受影响（换项目不用跟着停）',
      richRes.status === 200
    );

    const quotaInfo = await (await fetch(`${MGR}/quota?name=tiny`)).json();
    ok(
      `额度查询可读：${quotaInfo.key} 已用 ${quotaInfo.calls}/${quotaInfo.limit.dayCalls}，剩 ${quotaInfo.remaining.dayCalls}`,
      quotaInfo.calls === 2 && quotaInfo.remaining.dayCalls === 0
    );

    // 半开连接：socket 还在（readyState=OPEN），但设备已经 60s 没出声。
    // 这时必须立刻回 503 esp32_stale，而不是让调用方白等 20 秒超时。
    const espWs = relay.tunnels.get('wol')?.esp32;
    if (!espWs) throw new Error('拿不到 esp32 的 ws 引用，无法构造半开场景');
    espWs.lastMsgAt = Date.now() - 60_000;
    const staleCall = await fetch(`${BASE}/_call?tunnel=wol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'net_info', args: {} }),
    });
    const staleBody = await staleCall.json();
    if (staleCall.status === 503 && staleBody.err === 'esp32_stale') {
      ok('半开连接被识别（503 esp32_stale，不在死连接上白等 20 秒）');
    } else {
      throw new Error(`半开连接未识别: ${staleCall.status} ${JSON.stringify(staleBody)}`);
    }
    espWs.lastMsgAt = Date.now(); // 复位，后续用例照常

    esp2.stopHeartbeat();
    const nodeRec = mgr.nodes.get('c6-01');
    nodeRec.lastSeen = Date.now() - 7000;
    const snap2 = await (await fetch(`${MGR}/snapshot`)).json();
    const nv = snap2.nodes.find((x) => x.nodeId === 'c6-01');
    if (nv && !nv.online && snap2.stats.nodesOnline === 0) {
      ok('心跳停止超过 TTL 后判离线（读路径判定，不依赖 alarm）');
    } else {
      throw new Error('离线判定失败');
    }

    const off2 = await fetch(`${MGR}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'c6-01', tool: 'https_fetch', args: { host: 'x' } }),
    });
    if (off2.status === 503) ok('节点离线时下发返回 503（不假装成功）');
    else throw new Error(`离线下发状态码异常: ${off2.status}`);

    nodeRec.lastSeen = Date.now(); // 恢复在线，单独测「工具不支持」这条分支
    const badTool = await fetch(`${MGR}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'c6-01', tool: 'no_such_tool', args: {} }),
    });
    const badBody = await badTool.json();
    if (badTool.status === 400 && badBody.error === 'tool_not_supported') {
      ok('设备不支持的工具被拒（400 tool_not_supported，不是静默失败）');
    } else {
      throw new Error(`不支持工具未被拒: ${badTool.status} ${JSON.stringify(badBody)}`);
    }

    // 同一件事，但这次不指定 nodeId：走的是 Manager 自动选节点。
    // 这时候返回 400 tool_not_supported（而不是 503 no_available_node），
    // 因为在线设备是有的，缺的是「支持这个工具的在线设备」。
    const badAuto = await fetch(`${MGR}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'no_such_tool', args: {} }),
    });
    const badAutoBody = await badAuto.json();
    if (badAuto.status === 400 && badAutoBody.error === 'tool_not_supported') {
      ok('自动选节点时也能区分「工具不支持(400)」与「没有可用节点(503)」');
    } else {
      throw new Error(
        `自动选节点的错误码不对: ${badAuto.status} ${JSON.stringify(badAutoBody)}`
      );
    }

    esp2.close();
    target.close();
    mgr.server.close();

    userWs.close();
    u1.close();
    u2.close();
    ok('全部清理完成');
  } catch (e) {
    fail('用例组', e);
  } finally {
    echo.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();

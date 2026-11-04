/*
 * ESP32 Wake-on-LAN + 内网穿透 融合固件 v3
 * =======================================================
 * 融合两套能力：
 *   A. 本地 WOL 定时唤醒器（原 ESP32_WOL v2）
 *      - 局域网网页 http://<IP>/ 或 http://wol.local/（端口 80）
 *      - NTP 对时 / 每天定时发魔术包 / 网页改时间（存 flash）
 *      - 网页上的「立即唤醒」= 本地手动发送
 *   B. Cloudflare Workers 内网穿透隧道（参考资料库 esp32-workers-tunnel）
 *      - 主动 wss 连到 Worker 的 Durable Object，双向二进制帧隧道
 *      - 可把局域网任意 TCP 服务（RDP 3389 / SSH 22 / Web）暴露到公网
 *      - 收到 WOL 帧 → 广播魔术包 = 公网手动发送（公网也能叫醒电脑）
 *
 * 帧协议（与 worker/src/protocol.ts 字节级一致）：
 *   OPEN    0x01 + channel(1B) + ip(4B) + port(2B)   用户 -> ESP32
 *   OPEN_OK 0x02 + channel(1B)                       ESP32 -> 用户
 *   DATA    0x03 + channel(1B) + payload             双向
 *   CLOSE   0x04 + channel(1B)                       双向
 *   WOL     0x05 + mac(6B)                           用户 -> ESP32
 *     mac 全 0 表示「用固件里的默认 TARGET_MAC」
 *
 * 目标机器：华硕 X550CC 笔记本（MAC AA:BB:CC:DD:EE:FF）
 * 依赖库：WebSockets (Links2004/arduinoWebSockets)
 */

// 注：排查隧道问题时曾临时打开库的 DEBUG_ESP_PORT（改 libraries/WebSockets/src/WebSockets.h），
// 已还原 —— 库的逐帧调试输出会拖慢主循环。要看握手细节可再临时打开。

#include <WiFi.h>
#include <WiFiUdp.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WebSocketsClient.h>
#include <time.h>

// ===================== 配置区 =====================
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// 目标电脑有线网卡 MAC（实测值，别改错）
uint8_t TARGET_MAC[6] = {0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF};

// 出厂默认唤醒时刻（可用网页改）
const int DEFAULT_HOUR   = 8;
const int DEFAULT_MINUTE = 0;

// mDNS 主机名 -> 浏览器访问 http://wol.local/
const char* MDNS_NAME = "wol";

// NTP 对时
const char* NTP_SERVER = "ntp.aliyun.com";
const long  GMT_OFFSET = 8 * 3600;   // 东八区
const int   DST_OFFSET = 0;

// ---------- 隧道配置 ----------
// wrangler deploy 后拿到的域名，例："esp32-wol-tunnel.abc123.workers.dev"
// 留空 = 只跑本地 WOL，不连隧道
const char* WORKER_HOST = "tunnel.example.com";
// 固定格式 /ws/<tunnel>/esp32，tunnel 名要跟用户侧客户端一致
const char* WORKER_PATH = "/ws/wol/esp32";
// 可选：Worker 加了鉴权时填共享 token，留空表示不带
const char* TUNNEL_TOKEN = "YOUR_TUNNEL_TOKEN";
const uint16_t WORKER_PORT = 443;    // wss 用 443；明文 ws 改 80 并把 beginSSL 换成 begin

#define MAX_CHANNELS 8               // 同时可穿透的 TCP 连接数
#define READ_CHUNK   256             // 单帧 DATA 上行分片大小
// =================================================

// 帧类型
#define F_OPEN    0x01
#define F_OPEN_OK 0x02
#define F_DATA    0x03
#define F_CLOSE   0x04
#define F_WOL     0x05

WiFiUDP         udp;
WebServer       server(80);
Preferences     prefs;
WebSocketsClient webSocket;

WiFiClient channelClient[MAX_CHANNELS];
bool       channelActive[MAX_CHANNELS] = {false};

int  wakeHour      = DEFAULT_HOUR;
int  wakeMinute    = DEFAULT_MINUTE;
bool firedToday    = false;
int  lastDaySeen   = -1;
long lastSentEpoch = 0;      // 上次发包含时间 (epoch 秒)
int  packetCount   = 0;
String lastSource  = "never";  // local / remote / schedule

bool     tunnelOn   = false;   // WS 当前是否连着
long     tunnelUpAt = 0;
int      remoteWolCount = 0;

// ---------------- WOL ----------------

uint8_t bcastOctet(uint8_t ip, uint8_t mask) {
  return (uint8_t)(ip | (uint8_t)~mask);
}

// 发魔术包：默认 MAC + 全部广播地址 + 端口 9/7
void sendWOL(const uint8_t* mac, const char* source) {
  uint8_t packet[102];
  memset(packet, 0xFF, 6);
  for (int i = 0; i < 16; i++) {
    memcpy(packet + 6 + i * 6, mac, 6);
  }

  String subnetBcast = "255.255.255.255";
  if (WiFi.status() == WL_CONNECTED) {
    IPAddress ip   = WiFi.localIP();
    IPAddress mask = WiFi.subnetMask();
    subnetBcast = String(bcastOctet(ip[0], mask[0])) + "." +
                  String(bcastOctet(ip[1], mask[1])) + "." +
                  String(bcastOctet(ip[2], mask[2])) + "." +
                  String(bcastOctet(ip[3], mask[3]));
  }

  const String targets[2] = { subnetBcast, String("255.255.255.255") };
  const uint16_t ports[2] = { 9, 7 };

  for (int a = 0; a < 2; a++) {
    for (int b = 0; b < 2; b++) {
      udp.beginPacket(targets[a].c_str(), ports[b]);
      udp.write(packet, sizeof(packet));
      udp.endPacket();
    }
  }

  packetCount++;
  lastSentEpoch = (long)time(nullptr);
  lastSource    = source;
  if (strcmp(source, "remote") == 0) remoteWolCount++;

  Serial.printf("[WOL] magic packet #%d (%s) -> %02X:%02X:%02X:%02X:%02X:%02X via %s\n",
                packetCount, source,
                mac[0], mac[1], mac[2], mac[3], mac[4], mac[5],
                subnetBcast.c_str());
}

String nowString() {
  struct tm t;
  if (!getLocalTime(&t, 50)) return "--";
  char b[32];
  strftime(b, sizeof(b), "%Y-%m-%d %H:%M:%S", &t);
  return String(b);
}

// ---------------- TCP 通道泵 ----------------

void closeChannel(int ch, bool notify) {
  if (ch < 0 || ch >= MAX_CHANNELS) return;
  if (channelActive[ch]) {
    channelClient[ch].stop();
    channelActive[ch] = false;
    Serial.printf("[tunnel] channel %d closed\n", ch);
  }
  if (notify && tunnelOn) {
    uint8_t f[2] = {F_CLOSE, (uint8_t)ch};
    webSocket.sendBIN(f, 2);
  }
}

// ---------------- 帧处理 ----------------

void handleFrame(uint8_t* payload, size_t length) {
  if (length < 2) return;
  uint8_t ftype = payload[0];
  uint8_t ch    = payload[1];

  if (ftype == F_OPEN) {
    if (length < 8 || ch >= MAX_CHANNELS) return;
    IPAddress ip(payload[2], payload[3], payload[4], payload[5]);
    int port = (payload[6] << 8) | payload[7];

    closeChannel(ch, false);
    channelClient[ch].setTimeout(3);
    Serial.printf("[tunnel] OPEN ch%d -> %s:%d\n", ch, ip.toString().c_str(), port);

    if (channelClient[ch].connect(ip, port)) {
      channelActive[ch] = true;
      uint8_t ok[2] = {F_OPEN_OK, ch};
      webSocket.sendBIN(ok, 2);
      Serial.printf("[tunnel] ch%d OPEN_OK\n", ch);
    } else {
      uint8_t cl[2] = {F_CLOSE, ch};
      webSocket.sendBIN(cl, 2);
      Serial.printf("[tunnel] ch%d dial FAILED\n", ch);
    }
  } else if (ftype == F_DATA) {
    if (ch >= MAX_CHANNELS || !channelActive[ch]) return;
    if (length > 2) {
      // write() 不保证一次写完（返回实际写入字节数），必须循环写到干净，
      // 否则大一点的请求（带 body 的 POST 等）会被悄悄截断。
      const uint8_t* p = payload + 2;
      size_t want = length - 2, off = 0;
      unsigned long t0 = millis();
      while (off < want) {
        size_t w = channelClient[ch].write(p + off, want - off);
        if (w > 0) { off += w; continue; }
        if (millis() - t0 > 3000) break;  // 目标不接收，放弃这一帧，别卡死 loop
        delay(1);
      }
    }
  } else if (ftype == F_CLOSE) {
    closeChannel(ch, false);
  } else if (ftype == F_WOL) {
    if (length < 7) return;
    bool allZero = true;
    for (int i = 0; i < 6; i++) if (payload[1 + i]) { allZero = false; break; }
    // 全 0 = 用固件默认 MAC；否则用帧里指定的 MAC（可唤醒任意设备）
    sendWOL(allZero ? TARGET_MAC : (payload + 1), "remote");
  }
}

void pumpChannels() {
  for (int c = 0; c < MAX_CHANNELS; c++) {
    if (!channelActive[c]) continue;
    WiFiClient& cl = channelClient[c];

    // ① 先把 socket 缓冲里能读的全读出来转发。
    //    ⚠️ 顺序很重要：远端优雅关闭时（HTTP "发完即关"就是典型），
    //    connected() 会立刻变 false，但接收缓冲里往往还压着整段响应没读走。
    //    早先的写法先判 connected() 再读，导致响应在读出前就被 stop() 丢掉，
    //    表现为「OPEN_OK 成功、请求发得出去、但一个字节都回不来」。
    int avail = cl.available();
    if (avail > 0) {
      uint8_t buf[READ_CHUNK];
      int n = cl.read(buf, min(avail, READ_CHUNK));
      if (n > 0) {
        uint8_t frame[2 + READ_CHUNK];
        frame[0] = F_DATA;
        frame[1] = (uint8_t)c;
        memcpy(frame + 2, buf, n);
        webSocket.sendBIN(frame, 2 + n);
      }
      continue;  // 本轮读完还有残留，下一轮继续
    }

    // ② 缓冲读空了，且连接确实断了，才收尾
    if (!cl.connected()) {
      closeChannel(c, true);
    }
  }
}

// ---------------- WS 事件 ----------------

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      tunnelOn   = true;
      tunnelUpAt = (long)time(nullptr);
      Serial.printf("[WS] connected to %s%s\n", WORKER_HOST, WORKER_PATH);
      Serial.printf("[WS] heap free=%u largest=%u\n",
                    (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());
      break;

    case WStype_DISCONNECTED:
      tunnelOn = false;
      Serial.printf("[WS] DISCONNECTED type=%d heap=%u largest=%u\n",
                    (int)type, (unsigned)ESP.getFreeHeap(),
                    (unsigned)ESP.getMaxAllocHeap());
      for (int c = 0; c < MAX_CHANNELS; c++) {
        if (channelActive[c]) { channelClient[c].stop(); channelActive[c] = false; }
      }
      break;

    case WStype_ERROR:
      Serial.printf("[WS] ERROR heap=%u largest=%u\n",
                    (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());
      break;

    case WStype_BIN:
    case WStype_TEXT:
      handleFrame(payload, length);
      break;

    default:
      Serial.printf("[WS] event type=%d\n", (int)type);
      break;
  }
}

void startTunnel() {
  if (WORKER_HOST[0] == '\0') {
    Serial.println("[WS] WORKER_HOST empty -> tunnel disabled (local WOL only)");
    return;
  }
  // --- 连之前先体检：DNS 能否解析 + 堆是否够 TLS 握手 ---
  IPAddress rip;
  if (WiFi.hostByName(WORKER_HOST, rip)) {
    Serial.printf("[DNS] %s -> %s\n", WORKER_HOST, rip.toString().c_str());
  } else {
    Serial.printf("[DNS] FAILED to resolve %s\n", WORKER_HOST);
  }
  Serial.printf("[heap] free=%u largest=%u (TLS 握手约需 40KB 连续)\n",
                (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());

  if (WORKER_PORT == 443) {
    webSocket.beginSSL(WORKER_HOST, WORKER_PORT, WORKER_PATH);
  } else {
    webSocket.begin(WORKER_HOST, WORKER_PORT, WORKER_PATH);
  }
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  // ⚠️ 必须启用心跳：Cloudflare 会掐掉长时间无数据的 WebSocket（空闲超时），
  // 没有 ping 保活就会「连上→被掐→重连→再被掐」死循环，且反复重连会耗光 lwIP socket，
  // 最终连 TCP 都建不起来（表现为 [WS-Client] connection ... Failed）。
  webSocket.enableHeartbeat(30000, 3000, 2);  // 30s 发 ping / 3s 等 pong / 2 次失败判死
  if (TUNNEL_TOKEN[0] != '\0') {
    // WebSockets 2.7.2 的 API 是 setExtraHeaders(整个 header 字符串)，
    // 且库内部只保存指针 —— 必须用 static 保证这块内存一直有效。
    static String authHeader;
    authHeader = String("Authorization: Bearer ") + TUNNEL_TOKEN;
    webSocket.setExtraHeaders(authHeader.c_str());
  }
  Serial.printf("[WS] connecting wss://%s%s\n", WORKER_HOST, WORKER_PATH);
}

// ---------------- Web 页面 ----------------

const char PAGE[] PROGMEM = R"HTML(<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 唤醒 + 穿透</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;
 background:#f2f3f5;margin:0;padding:18px;color:#222}
.card{background:#fff;border-radius:12px;padding:18px;margin:0 auto 14px;
 box-shadow:0 1px 4px rgba(0,0,0,.08);max-width:520px}
h2{margin:0 0 14px;font-size:19px}
.row{display:flex;justify-content:space-between;padding:7px 0;
 border-bottom:1px solid #f0f0f0;font-size:15px}
.row:last-child{border:0}
.k{color:#888}.v{font-weight:600;font-variant-numeric:tabular-nums}
.big{font-size:30px;font-weight:700;color:#0066cc;text-align:center;
 padding:12px 0;font-variant-numeric:tabular-nums}
button{font-size:17px;padding:14px;border:0;border-radius:9px;width:100%;
 color:#fff;cursor:pointer;font-weight:600}
.b1{background:#e74c3c}.b2{background:#0066cc}
input[type=number]{width:64px;font-size:17px;padding:8px;text-align:center;
 border:1px solid #ddd;border-radius:8px}
.f{display:flex;align-items:center;gap:9px;justify-content:center;margin:10px 0}
#msg{text-align:center;color:#0a0;font-size:14px;min-height:20px;padding-top:6px}
.ok{color:#0a0}.no{color:#c00}
</style></head><body>

<div class="card">
  <h2>ESP32 定时唤醒器 v3</h2>
  <div class="big" id="left">--:--:--</div>
  <div style="text-align:center;color:#888;font-size:14px">距下次唤醒</div>
</div>

<div class="card">
  <div class="row"><span class="k">当前时间</span><span class="v" id="now">--</span></div>
  <div class="row"><span class="k">下次唤醒</span><span class="v" id="next">--</span></div>
  <div class="row"><span class="k">今日已触发</span><span class="v" id="fired">--</span></div>
  <div class="row"><span class="k">累计发包</span><span class="v" id="cnt">0</span></div>
  <div class="row"><span class="k">最后发包</span><span class="v" id="last">从未</span></div>
  <div class="row"><span class="k">最后来源</span><span class="v" id="src">--</span></div>
  <div class="row"><span class="k">穿透隧道</span><span class="v" id="tun">--</span></div>
  <div class="row"><span class="k">公网唤醒次数</span><span class="v" id="rw">0</span></div>
  <div class="row"><span class="k">ESP32 IP</span><span class="v" id="ip">--</span></div>
  <div class="row"><span class="k">WiFi 信号</span><span class="v" id="rssi">--</span></div>
  <div class="row"><span class="k">目标 MAC</span><span class="v">AA:BB:CC:DD:EE:FF</span></div>
</div>

<div class="card">
  <h2>修改唤醒时间</h2>
  <div class="f">
    <input type="number" id="h" min="0" max="23"> 时
    <input type="number" id="m" min="0" max="59"> 分
    <button class="b2" style="width:auto;padding:9px 20px" onclick="save()">保存</button>
  </div>
  <div id="msg"></div>
</div>

<div class="card">
  <h2>手动发送</h2>
  <button class="b1" onclick="wake()">立即唤醒电脑（本地）</button>
  <div id="msg2" style="text-align:center;color:#888;font-size:14px;padding-top:8px"></div>
</div>

<script>
let D={};
async function load(){
  try{
    const r=await fetch('/status'); D=await r.json();
    document.getElementById('now').textContent = D.now;
    document.getElementById('ip').textContent  = D.ip;
    document.getElementById('rssi').textContent= D.rssi+' dBm';
    document.getElementById('cnt').textContent = D.count;
    document.getElementById('rw').textContent  = D.remote;
    document.getElementById('src').textContent = ({local:'本地',remote:'公网',schedule:'定时',never:'从未'})[D.src]||D.src;
    document.getElementById('last').textContent= D.lastSent ? new Date(D.lastSent*1000).toLocaleString('zh-CN') : '从未';
    document.getElementById('fired').textContent = D.fired ? '是' : '否';
    const t=document.getElementById('tun');
    t.textContent = D.tunnel ? '已连接' : '未连接';
    t.className = 'v ' + (D.tunnel ? 'ok' : 'no');
    if(document.activeElement.id!=='h') document.getElementById('h').value=D.hour;
    if(document.activeElement.id!=='m') document.getElementById('m').value=D.min;
    const nx = new Date(); nx.setHours(D.hour,D.min,0,0);
    let ts = Math.floor(nx.getTime()/1000);
    let dayoff = 0;
    if(D.fired || ts<=D.epoch){ dayoff=1; ts+=86400; }
    const nd = new Date(ts*1000);
    document.getElementById('next').textContent =
      nd.toLocaleString('zh-CN') + (dayoff? ' (明天)' : '');
    let left = ts - D.epoch;
    const hh=Math.floor(left/3600), mm=Math.floor(left%3600/60), ss=left%60;
    document.getElementById('left').textContent =
      String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0')+':'+String(ss).padStart(2,'0');
    setTimeout(load, 1000);
  }catch(e){ setTimeout(load, 3000); }
}
async function save(){
  const h=document.getElementById('h').value, m=document.getElementById('m').value;
  const r=await fetch('/set?h='+h+'&m='+m);
  document.getElementById('msg').textContent = await r.text();
  setTimeout(()=>document.getElementById('msg').textContent='',2500);
  load();
}
async function wake(){
  const r=await fetch('/wake');
  document.getElementById('msg2').textContent = await r.text();
}
load();
</script>
</body></html>
)HTML";

void handleRoot() {
  server.send_P(200, "text/html; charset=utf-8", PAGE);
}

void handleStatus() {
  String j = "{";
  j += "\"now\":\"" + nowString() + "\",";
  j += "\"epoch\":" + String((long)time(nullptr)) + ",";
  j += "\"hour\":" + String(wakeHour) + ",";
  j += "\"min\":" + String(wakeMinute) + ",";
  j += "\"fired\":" + String(firedToday ? "true" : "false") + ",";
  j += "\"count\":" + String(packetCount) + ",";
  j += "\"lastSent\":" + String(lastSentEpoch) + ",";
  j += "\"src\":\"" + lastSource + "\",";
  j += "\"remote\":" + String(remoteWolCount) + ",";
  j += "\"tunnel\":" + String(tunnelOn ? "true" : "false") + ",";
  j += "\"tunnelUpAt\":" + String(tunnelUpAt) + ",";
  j += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  j += "\"rssi\":" + String(WiFi.RSSI());
  j += "}";
  server.send(200, "application/json", j);
}

void handleWake() {
  sendWOL(TARGET_MAC, "local");
  server.send(200, "text/plain; charset=utf-8",
              "已发送魔术包（第 " + String(packetCount) + " 个），等几秒看电脑醒没醒。");
}

void handleSet() {
  if (server.hasArg("h")) wakeHour   = server.arg("h").toInt();
  if (server.hasArg("m")) wakeMinute = server.arg("m").toInt();
  wakeHour   = constrain(wakeHour, 0, 23);
  wakeMinute = constrain(wakeMinute, 0, 59);

  prefs.putInt("h", wakeHour);
  prefs.putInt("m", wakeMinute);

  firedToday = false;   // 改了时间, 重新判定

  char buf[64];
  snprintf(buf, sizeof(buf), "已保存：每天 %02d:%02d 唤醒", wakeHour, wakeMinute);
  server.send(200, "text/plain; charset=utf-8", String(buf));
  Serial.printf("[CFG] wake time set to %02d:%02d\n", wakeHour, wakeMinute);
}

// ---------------- 主流程 ----------------

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("===== ESP32 WOL + Tunnel v3 =====");

  prefs.begin("wolcfg", false);
  wakeHour   = prefs.getInt("h", DEFAULT_HOUR);
  wakeMinute = prefs.getInt("m", DEFAULT_MINUTE);
  Serial.printf("[CFG] loaded wake time %02d:%02d\n", wakeHour, wakeMinute);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[WiFi] connecting to %s", WIFI_SSID);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 60) { delay(500); Serial.print("."); tries++; }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] OK  IP = %s  RSSI = %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());

    if (MDNS.begin(MDNS_NAME)) {
      MDNS.addService("http", "tcp", 80);
      Serial.printf("[mDNS] http://%s.local/\n", MDNS_NAME);
    }

    configTime(GMT_OFFSET, DST_OFFSET, NTP_SERVER);
    Serial.print("[NTP] syncing");
    struct tm t; int n = 0;
    while (!getLocalTime(&t, 1000) && n < 20) { Serial.print("."); n++; }
    Serial.println(n < 20 ? " ok" : " FAILED");
    Serial.printf("[time] %s\n", nowString().c_str());
  } else {
    Serial.println("\n[WiFi] FAILED - check SSID/password");
  }

  udp.begin(9);

  server.on("/",       handleRoot);
  server.on("/status", handleStatus);
  server.on("/wake",   handleWake);
  server.on("/set",    handleSet);
  server.begin();
  Serial.printf("[HTTP] http://%s/  (port 80)\n", WiFi.localIP().toString().c_str());

  startTunnel();

  Serial.printf("[TASK] daily wake at %02d:%02d\n", wakeHour, wakeMinute);
  Serial.println("=================================");
}

void loop() {
  server.handleClient();
  webSocket.loop();

  if (WiFi.status() != WL_CONNECTED) { delay(500); return; }

  pumpChannels();

  struct tm t;
  if (!getLocalTime(&t, 50)) return;

  if (t.tm_mday != lastDaySeen) {
    lastDaySeen = t.tm_mday;
    firedToday = false;
    Serial.printf("[day] new day %04d-%02d-%02d\n",
                  t.tm_year + 1900, t.tm_mon + 1, t.tm_mday);
  }

  if (!firedToday && t.tm_hour == wakeHour && t.tm_min == wakeMinute) {
    Serial.println("[TASK] scheduled wake triggered");
    sendWOL(TARGET_MAC, "schedule");
    firedToday = true;
  }

  yield();   // 喂看门狗
}

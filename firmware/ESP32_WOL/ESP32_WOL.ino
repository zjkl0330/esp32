/*
 * ESP32 Wake-on-LAN 定时唤醒器 v2
 *
 * v2 新增:
 *   - 状态页: 显示当前时间 / 定时设置 / 下次唤醒 / 倒计时 / 发包记录
 *   - 网页改时间: 不用重新编译, 改完存进 flash, 断电不丢
 *   - mDNS: 可用 http://wol.local/ 访问, 不怕 IP 变
 *
 * 目标机器: 华硕 X550CC 笔记本 (MAC AA:BB:CC:DD:EE:FF)
 */

#include <WiFi.h>
#include <WiFiUdp.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
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
// =================================================

WiFiUDP     udp;
WebServer   server(80);
Preferences prefs;

int  wakeHour      = DEFAULT_HOUR;
int  wakeMinute    = DEFAULT_MINUTE;
bool firedToday    = false;
int  lastDaySeen   = -1;
long lastSentEpoch = 0;      // 上次发包含时间 (epoch 秒)
int  packetCount   = 0;

// ---------------- 工具 ----------------

uint8_t bcastOctet(uint8_t ip, uint8_t mask) {
  return (uint8_t)(ip | (uint8_t)~mask);
}

void sendWOL() {
  uint8_t packet[102];
  memset(packet, 0xFF, 6);
  for (int i = 0; i < 16; i++) {
    memcpy(packet + 6 + i * 6, TARGET_MAC, 6);
  }

  IPAddress ip   = WiFi.localIP();
  IPAddress mask = WiFi.subnetMask();
  String subnetBcast = String(bcastOctet(ip[0], mask[0])) + "." +
                       String(bcastOctet(ip[1], mask[1])) + "." +
                       String(bcastOctet(ip[2], mask[2])) + "." +
                       String(bcastOctet(ip[3], mask[3]));

  // 目标: 子网广播 + 全网广播;  端口: 9(discard) + 7(echo)
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

  Serial.printf("[WOL] magic packet #%d -> %02X:%02X:%02X:%02X:%02X:%02X via %s\n",
                packetCount,
                TARGET_MAC[0], TARGET_MAC[1], TARGET_MAC[2],
                TARGET_MAC[3], TARGET_MAC[4], TARGET_MAC[5],
                subnetBcast.c_str());
}

String nowString() {
  struct tm t;
  if (!getLocalTime(&t, 50)) return "--";
  char b[32];
  strftime(b, sizeof(b), "%Y-%m-%d %H:%M:%S", &t);
  return String(b);
}

// ---------------- Web ----------------

const char PAGE[] PROGMEM = R"HTML(<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 定时唤醒</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;
 background:#f2f3f5;margin:0;padding:18px;color:#222}
.card{background:#fff;border-radius:12px;padding:18px;margin-bottom:14px;
 box-shadow:0 1px 4px rgba(0,0,0,.08);max-width:520px;margin:0 auto}
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
</style></head><body>

<div class="card">
  <h2>ESP32 定时唤醒器</h2>
  <div class="big" id="left">--:--:--</div>
  <div style="text-align:center;color:#888;font-size:14px">距下次唤醒</div>
</div>

<div class="card">
  <div class="row"><span class="k">当前时间</span><span class="v" id="now">--</span></div>
  <div class="row"><span class="k">下次唤醒</span><span class="v" id="next">--</span></div>
  <div class="row"><span class="k">今日已触发</span><span class="v" id="fired">--</span></div>
  <div class="row"><span class="k">累计发包</span><span class="v" id="cnt">0</span></div>
  <div class="row"><span class="k">最后发包</span><span class="v" id="last">从未</span></div>
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
  <button class="b1" onclick="wake()">立即唤醒电脑</button>
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
    document.getElementById('last').textContent= D.lastSent ? new Date(D.lastSent*1000).toLocaleString('zh-CN') : '从未';
    document.getElementById('fired').textContent = D.fired ? '是' : '否';
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
  j += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  j += "\"rssi\":" + String(WiFi.RSSI());
  j += "}";
  server.send(200, "application/json", j);
}

void handleWake() {
  sendWOL();
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
  Serial.println("===== ESP32 Wake-on-LAN v2 =====");

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
  Serial.printf("[TASK] daily wake at %02d:%02d\n", wakeHour, wakeMinute);
  Serial.println("===============================");
}

void loop() {
  server.handleClient();

  if (WiFi.status() != WL_CONNECTED) { delay(1000); return; }

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
    sendWOL();
    firedToday = true;
  }
}

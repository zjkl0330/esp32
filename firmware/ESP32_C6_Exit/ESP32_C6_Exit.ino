/*
 * ESP32-C6 住宅出口固件 v2.0.0（M2）
 * ==========================================================================
 * 定位：Worker 的「哑管道」。固件自己不做任何解析逻辑 —— 解析放 Worker，
 *       因为 Worker 可以随时热改，固件刷一次要人跑到板子边上。
 *
 * 与 v3 融合固件（ESP32_WOL_Tunnel）的区别：
 *   v3 = 传输层隧道（把局域网 TCP 服务搬上公网）
 *   v2 = 应用层出口（Worker 下发一条「取这个 URL」的指令，板子只负责把字节拿回来）
 *
 * 为什么是应用层出口而不是 TCP 隧道：
 *   `cloudflare:sockets` 的 startTls() 只能作用于 connect() 返回的本地 socket，
 *   无法作用于 WS 消息流 —— 也就是说 TLS 只能在板子上终结。既然 TLS 必须在板子上，
 *   那"把 raw TCP 搬上去"和"把 HTTP 拿回来"对板子的成本是一样的，
 *   但后者让 Worker 能直接拿到可解析的响应，少一层协议伪装。
 *
 * ── 帧协议（与 worker/src/protocol.ts 字节级一致，一字节未改）──────────────
 *   OPEN    0x01 + ch(1B) + ip(4B) + port(2B)   用户 -> 板子
 *   OPEN_OK 0x02 + ch(1B)                       板子 -> 用户
 *   DATA    0x03 + ch(1B) + payload             双向
 *   CLOSE   0x04 + ch(1B)                       双向
 *   WOL     0x05 + mac(6B)                      用户 -> 板子（全 0 = 用默认 MAC）
 *
 * ── 控制面（v2 新增，走 WS 文本帧 JSON，与上面二进制帧共存）─────────────────
 *   板子 -> Worker : hello / hb / result
 *   Worker -> 板子 : call
 *   工具结果体仍然复用 DATA 帧（通道号由 CALL 里的 ch 指定，Worker 侧分配 192~255），
 *   所以大字节流不受 JSON 编码影响 —— JSON 只承载「接头暗号」。
 *
 * ── 与 v3 的功能差异（写清楚，别让人以为漏了）──────────────────────────────
 *   本固件 **不实现** TCP 隧道（收到 OPEN 一律回 CLOSE）。理由见上：应用层出口才是
 *   这个架构要的东西。v3 的 TCP 隧道功能仍由 ESP32_WOL_Tunnel 承担，两者可并存
 *   （各自一个 tunnel 名，Manager 会当成两个节点）。
 *
 * 分区表：必须 default_8MB（app0/app1 各 3.34MB），否则 8MB flash 只用一半
 * 编译：  FQBN = esp32:esp32:esp32c6:PartitionScheme=default_8MB
 * 上传：  波特率必须 115200（921600 会让 esptool 在 SFDP 阶段挂掉）
 *
 * 依赖库：WebSockets 2.7.2 (Links2004) + ArduinoJson 7.x
 */

// 连 Cloudflare 的 TCP 超时。
//
// 库里的默认值是 WEBSOCKETS_TCP_TIMEOUT = 5000（毫秒），宏在 WebSockets.h 里用
// #ifndef 保护，所以在这里先定义就能覆盖。为什么必须覆盖：
//   国内到 CF anycast 的握手延迟本来就在 1.5~8 秒之间飘（深夜更容易被限速），
//   5 秒的窗口意味着「网络稍微慢一点就永远连不上」，而且库里失败后 5 秒重连一次、
//   每次都卡满 5 秒，看上去就像「设备死了，只有 DISCONNECTED，没有任何原因」。
//   实测证据：预检 TLS 用 8s 预算能成功（5.3s），而库自己 4.9s 就报 DISCONNECTED。
#define WEBSOCKETS_TCP_TIMEOUT 20000

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <time.h>          // configTime / localtime_r：TLS 校验前必须先对时
#include <Preferences.h>   // NVS：记 OTA 待确认标志，断电也不丢
#include <mbedtls/base64.h> // bodyB64 解码（protobuf 等二进制请求体）
#include <esp_ota_ops.h>   // esp_ota_get_running_partition：net_info 要报分区余量

// OTA 编译开关。
//   C6（8MB Flash，app0/app1 各 3264KB）：OTA_ENABLE=1，走默认。
//   D0WD（4MB Flash，app0/app1 各 1280KB，固件已占 1177KB）：用
//     --build-property "compiler.cpp.extra_flags=-DOTA_ENABLE=0"
//   编出无 OTA 版本，免得为了 OTA 把这点余量吃掉、以后加不了一行功能。
#ifndef OTA_ENABLE
#define OTA_ENABLE 1
#endif

#if OTA_ENABLE
#include <Update.h>
#include <mbedtls/sha256.h>
#endif

// ═══════════════════════════ 配置区 ═══════════════════════════

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

#define FW_VERSION "2.2.0"

// OTA 下载的落点回调。声明放在文件顶部是有原因的：Arduino 的预处理会给
// 每个函数自动生成原型并插到文件前部，如果 typedef 写在下面，生成出来的
// 原型就会用到还没声明的 OtaSink 而编译失败。
typedef bool (*OtaSink)(const uint8_t* p, size_t n);

// 连 WS 前先单独握一次手并把失败原因打出来。排障用，稳定后可以关掉。
// 关掉的理由：它会多花一次握手（顺利时 ~2s，链路差时卡满 8s）在启动阶段，
// 平时没有收益；需要查「连不上到底是什么原因」时用 -DTLS_DIAG=1 编一版。
#ifndef TLS_DIAG
#define TLS_DIAG 0
#endif

// 一次性联网自检：开机把「能出网 / 能连 CF / 证书认不认」三层分开测。
// 只有在怀疑某个环节时才开，正常固件不要带。
#ifndef NET_DIAG
#define NET_DIAG 0
#endif

// 目标电脑有线网卡 MAC（WOL 用，实测值）
uint8_t TARGET_MAC[6] = {0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF};

// ── 联调开关 ──
// TEST_MODE = 1 时走明文 ws:// 连电脑上的 Node 等价中继（不碰生产环境）。
// 板子第一次跑起来、还没部署 Worker 时用这个，能看到完整链路。
// 上生产时改回 0。
#define TEST_MODE 0
#if TEST_MODE
  const char*    WS_HOST  = "192.168.1.10";   // 电脑局域网 IP
  const uint16_t WS_PORT  = 8787;
  const bool     WS_TLS   = false;
  const char*    WS_TOKEN = "";                // 本地网关默认不要求 token
  const char*    WS_PATH  = "/ws/wol/esp32";
#else
  // 生产：独立的「住宅出口」Worker，跟 v3 的 tunnel.example.com 完全分开
  const char*    WS_HOST  = "exit.example.com";
  const uint16_t WS_PORT  = 443;
  const bool     WS_TLS   = true;
  // 必须与 Worker 上 `wrangler secret put TUNNEL_TOKEN` 的值一致。
  // 留空也能连，但 Worker 会回 401 —— 这是有意的 fail-closed，
  // 不会因为"没配"就静默放行。
  const char*    WS_TOKEN = "15317dcacf468cf073c0baf6a909a60ac2ddd73e6032ee81";
  const char*    WS_PATH  = "/ws/exit/esp32";
#endif

// ── 心跳 ──
#define HB_INTERVAL_MS 20000UL   // 应用层心跳（Manager TTL 50s，留足余量）
// 库层 ping：pong 超时给到 10s，因为一次 https_fetch 会阻塞 loop()，
// 太紧的 pong 超时会把「正在取网页」误判成「连接已死」。
#define WS_PING_MS     20000
#define WS_PONG_MS     10000
#define WS_PONG_FAIL   3

// ── 工具参数上限 ──
// 单个 DATA 帧的载荷大小。
// 原来 1024：抓 100KB 内容要发 100 帧，实测耗了 9.7 秒 —— 慢到大文件根本没法用。
// 4096 后同样内容只要 25 帧。txBuf 是 2+TOOL_CHUNK 字节的静态数组，
// C6 有 274KB 可用堆，4KB 完全放得下。
#define TOOL_CHUNK        4096
#define MAX_BODY_BYTES    131072UL  // 单次抓取体积上限（128KB），防一条请求把额度吃干
#define MAX_HEAD_BYTES    4096      // 响应头上限
#define MAX_REDIRECTS     3
#define FETCH_TIMEOUT_MS  6000      // 单跳超时
// 总预算必须小于 Worker 侧 DEFAULT_CALL_TIMEOUT(20s)：否则 Worker 早就超时回
// 504 了，板子还在傻等，而且这期间 loop() 被堵住 → WS 心跳回不了 → 连接被掐。
// 一次重定向 + 两个慢跳曾经把 loop() 堵到 24 秒，就是这么挂的。
#define MAX_TOTAL_FETCH_MS 20000UL

// WS 断连看门狗：lwIP 的 socket 表在反复重连后容易漏，
// 超过这个时间还没连上就整机重启 —— 重启比在残缺状态里打补丁可靠。
#define WS_DEAD_RESTART_MS 45000UL

// 「从来没连上过」的看门狗。
//
// 原来只有在 lastTunnelOkAt != 0（曾经连上过）时才重启，于是「开机就没连上」
// 这种情况永远不会触发重启。凌晨路由器重启后的失败链条正好落在这个盲区里：
//   路由器重启 → C6 重连 WiFi 成功，但 NTP 还不可达 → time() 仍是 1970
//   → TLS 校验证书必然失败 → startTunnel() 连不上 → lastTunnelOkAt 一直是 0
//   → 看门狗拒绝重启 → 永久卡死，只能人去拔电。
// 这条规则单独兜住它：开机 5 分钟内一次都没连上，就重启重来一遍。
#define WS_BOOT_DEAD_RESTART_MS 300000UL

// ── OTA 自更新 ──
#if OTA_ENABLE
#define OTA_MANIFEST_PATH   "/fw/manifest.json"
#define OTA_FIRST_CHECK_MS  45000UL            // 启动后首次检查（先让链路稳下来）
#define OTA_CHECK_EVERY_MS  (6UL * 3600UL * 1000UL)
#define OTA_BOOT_CONFIRM_MS 90000UL            // 升级后 90s 内没连上 WS 就回滚
#define OTA_DL_BUDGET_MS    (240UL * 1000UL)   // 单次下载总预算
#define OTA_MAX_IMAGE_BYTES (2UL * 1024UL * 1024UL)
#endif

// 帧类型
#define F_OPEN    0x01
#define F_OPEN_OK 0x02
#define F_DATA    0x03
#define F_CLOSE   0x04
#define F_WOL     0x05

// ═══════════════════════════ TLS 信任锚 ═══════════════════════════
//
// 为什么必须校验证书。原来 startTunnel() 调的是 beginSSL(host, port, path)，
// 既不传 CA 也不传 fingerprint，WebSockets 库内部就走 setInsecure() ——
// 也就是根本不验证对面是谁。任何人只要能插在设备和 Cloudflare 之间
// （同一 WiFi 下 ARP 欺骗、被控的路由器、上游中间盒），拿一张自签证书
// 就能冒充 exit.example.com，握手时把 Authorization: Bearer <TUNNEL_TOKEN>
// 直接收走。
//
// 更麻烦的是它会绕过 SSRF 防护：禁内网那段校验在 Worker 的 checkTarget() 里，
// 设备自己不判断目标。TLS 一破，攻击者根本不用碰 Worker，
// 直接冒充它下发 https_fetch host=192.168.1.1，设备就会去抓自家路由器的
// 管理页并回传。所以「TLS 不校验」等于「内网 SSRF 防护形同虚设」。
//
// 两个根都带上：
//   GTS Root R4   —— CF 现在用 Google Trust Services 的 WE1 签发，根就是它
//   ISRG Root X1  —— CF 哪天换回 Let's Encrypt 时兜底
// 都是自签根，有效期到 2036 / 2035，不会跟着服务器证书 90 天轮换而失效。
static const char ROOT_CA[] = R"ROOTS(
-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD
VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG
A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw
WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz
IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi
QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR
HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW
BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D
9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8
p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)ROOTS";


// ── HTTP 出口用的两个小结构体 ──
// 必须定义在「第一个函数定义」之前：Arduino 预处理会自动生成函数原型，
// 并把这些原型插在 include 之后、首个函数之前。原型里出现了 FetchResult&，
// 而结构体定义在后面，编译器就会说「FetchResult has not been declared」。
struct Target {
  String   host;
  uint16_t port;
  bool     tls;
  String   path;   // 含 query
};

struct FetchResult {
  bool     ok = false;
  int      status = -1;
  size_t   bytes = 0;
  int      redirects = 0;
  bool     truncated = false;
  String   err;
  String   finalHost;
  // 目标的 Content-Type。之前不往回带，上层一律当 application/octet-stream，
  // 调用方分不清拿到的是网页、JSON 还是图片。
  String   contentType;
};

// ═══════════════════════════ 全局状态 ═══════════════════════════

WebSocketsClient webSocket;

bool     tunnelOn   = false;
uint32_t tunnelUpAt = 0;         // millis()，用于算 uptime
uint32_t lastTunnelOkAt = 0;     // 最近一次 WS 连通时刻，供断连看门狗用
uint32_t tunnelDownAt   = 0;     // 断线时刻；看门狗从这一刻起算，不能从连通时刻算
bool     helloSent  = false;
uint32_t lastHbAt   = 0;
uint32_t lastWifiOkAt = 0;

// 初始化/对时状态。
// 这三个是 2.2.0 新增的：原来 onWifiOk() 用 lastWifiOkAt == 0 判断"是不是第一次"，
// 结果是「只初始化一次」，NTP 万一首次失败就再也没有第二次机会。
bool     timeSynced   = false;
uint32_t lastNtpTryAt = 0;
bool     tunnelStarted = false;
bool     wifiWasDown   = false;   // loop 里看到过 WiFi 断开，用来区分「真掉线」和「连得慢」
uint32_t bootAt       = 0;

#if OTA_ENABLE
bool     otaPending     = false;   // 新固件已写入另一分区，等"联网成功"确认
uint32_t otaLastCheckAt = 0;
uint32_t otaLastMs      = 0;
char     otaLastVer[20]    = "-";
char     otaLastResult[28] = "never";
#endif

char     nodeId[16] = "c6-000000";
uint32_t wolCount   = 0;
uint32_t callOk     = 0;
uint32_t callFail    = 0;
uint8_t  inflight    = 0;        // 当前在处理的工具调用数（单线程，实际只可能是 0 或 1）

// DATA 帧发送缓冲：一次分配，别在每次调用里 malloc
static uint8_t txBuf[2 + TOOL_CHUNK];

void sendHello();
void sendHb();

// ═══════════════════════════ 小工具 ═══════════════════════════

/**
 * 带余量检查的日志。
 *
 * 为什么不用裸 Serial.printf：ESP32 的 HardwareSerial::write 在 TX 环形缓冲写满时
 * 会**阻塞等待**。设备独立供电、USB 不接（也就是生产状态的常态）时，没人读串口，
 * 一次长日志就可能把 loop() 卡住 —— 而 loop() 一卡就等于心跳停摆、连接被 Worker 掐掉。
 * 实测就是这样：串口开着时 30 次调用全绿，串口一关就整片超时。
 * 宁可丢日志，也不能丢链路。
 */
void logf(const char* fmt, ...) {
  if (Serial.availableForWrite() < 96) return;   // 余量不够就这条不写了
  char buf[192];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  Serial.print(buf);
}

void makeNodeId() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  // 前缀按机型区分：两块板跑同一份代码，nodeId 撞车会让 Manager 把它们当成
  // 同一台，心跳互相覆盖、负载永远只压在一台上。
  const char* pfx = strstr(ESP.getChipModel(), "C6") ? "c6" : "esp";
  snprintf(nodeId, sizeof(nodeId), "%s-%02x%02x%02x", pfx, mac[3], mac[4], mac[5]);
}

// base64 解码（bodyB64 用）。
// 为什么需要它：protobuf 这类二进制请求体里到处是 0x00，而字符串一旦遇到
// 0x00 就在 C 层被截断 —— 实测发 8 字节 `AA\0BB\0CC`，目标只收到 `AA`。
// 所以二进制必须走 base64，在固件里解码成字节再整块 write。
size_t b64Decode(const String& in, uint8_t* out, size_t outCap) {
  size_t n = 0;
  int rc = mbedtls_base64_decode(out, outCap, &n,
                                 (const unsigned char*)in.c_str(), in.length());
  return rc == 0 ? n : 0;
}

void sendCtrl(JsonDocument& d) {
  char out[512];
  size_t n = serializeJson(d, out, sizeof(out));
  if (n > 0 && n < sizeof(out)) webSocket.sendTXT(out, n);
}

// 发一个 DATA 帧。返回 false 表示 WS 已经不可用，调用方应中止后续发送。
// 注意：streamBody 直接把 body 读进 txBuf+2，此时 p == txBuf+2，
// 不能无脑 memcpy（同址拷贝是未定义行为），所以先比一下指针。
bool sendDataChunk(int ch, const uint8_t* p, size_t n) {
  if (n == 0) return true;
  if (n > TOOL_CHUNK) n = TOOL_CHUNK;
  txBuf[0] = F_DATA;
  txBuf[1] = (uint8_t)ch;
  if (p != txBuf + 2) memcpy(txBuf + 2, p, n);
  return webSocket.sendBIN(txBuf, n + 2);
}

void sendClose(int ch) {
  uint8_t b[2] = {F_CLOSE, (uint8_t)ch};
  webSocket.sendBIN(b, 2);
}

/**
 * 回一条 result。meta 字段按 ResultMeta 定义：status/bytes/ms/host/redirects。
 * err 为 nullptr 表示成功。
 */
void sendResult(const char* id, bool ok, const char* err, int status, size_t bytes,
                uint32_t ms, const char* host, int redirects,
                bool truncated = false, const char* ctype = nullptr) {
  JsonDocument d;
  d["t"]  = "result";
  d["id"] = id;
  d["ok"] = ok;
  if (err && err[0]) d["err"] = err;

  JsonObject m = d["meta"].to<JsonObject>();
  if (status > 0) m["status"] = status;
  m["bytes"] = bytes;
  m["ms"]    = ms;
  if (host && host[0]) m["host"] = host;
  if (redirects > 0) m["redirects"] = redirects;
  // 撞到 maxBytes 上限被截断时必须明说。原来不报，上层只能拿到半截内容
  // 还以为是完整的 —— 这比抓取失败更危险，因为它看起来是成功的。
  if (truncated) m["truncated"] = true;
  if (ctype && ctype[0]) m["ctype"] = ctype;

  sendCtrl(d);
}

// ═══════════════════════════ WOL ═══════════════════════════

uint8_t bcastOctet(uint8_t ip, uint8_t mask) {
  return (uint8_t)(ip | (uint8_t)~mask);
}

void sendWOL(const uint8_t* mac, const char* source) {
  uint8_t packet[102];
  memset(packet, 0xFF, 6);
  for (int i = 0; i < 16; i++) memcpy(packet + 6 + i * 6, mac, 6);

  String subnetBcast = "255.255.255.255";
  if (WiFi.status() == WL_CONNECTED) {
    IPAddress ip = WiFi.localIP();
    IPAddress mk = WiFi.subnetMask();
    subnetBcast  = String(bcastOctet(ip[0], mk[0])) + "." + String(bcastOctet(ip[1], mk[1])) + "." +
                  String(bcastOctet(ip[2], mk[2])) + "." + String(bcastOctet(ip[3], mk[3]));
  }

  const String targets[2] = {subnetBcast, String("255.255.255.255")};
  const uint16_t ports[2] = {9, 7};
  WiFiUDP udp;
  for (int a = 0; a < 2; a++) {
    for (int b = 0; b < 2; b++) {
      udp.beginPacket(targets[a].c_str(), ports[b]);
      udp.write(packet, sizeof(packet));
      udp.endPacket();
    }
  }

  wolCount++;
  logf("[WOL] magic packet #%u (%s) -> %02X:%02X:%02X:%02X:%02X:%02X via %s\n",
                wolCount, source, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5],
                subnetBcast.c_str());
}

// ═══════════════════════════ HTTP 出口 ═══════════════════════════

/** 解析绝对 URL（只处理 http:// 与 https://） */
bool parseAbsUrl(const String& u, Target& t) {
  int sep = u.indexOf("://");
  if (sep < 0) return false;
  String scheme = u.substring(0, sep);
  scheme.toLowerCase();
  if (scheme == "https") { t.tls = true;  t.port = 443; }
  else if (scheme == "http") { t.tls = false; t.port = 80; }
  else return false;

  int rest = sep + 3;
  int slash = u.indexOf('/', rest);
  String hostPort = slash < 0 ? u.substring(rest) : u.substring(rest, slash);
  t.path = slash < 0 ? "/" : u.substring(slash);

  int colon = hostPort.indexOf(':');
  if (colon >= 0) {
    t.host = hostPort.substring(0, colon);
    t.port = (uint16_t)hostPort.substring(colon + 1).toInt();
  } else {
    t.host = hostPort;
  }
  return t.host.length() > 0;
}

/** 读响应头，直到 \r\n\r\n。返回 false = 超时或断开 */
bool readHeaders(Client& c, String& head, uint32_t deadline) {
  head = "";
  head.reserve(MAX_HEAD_BYTES);
  while ((int32_t)(millis() - deadline) < 0) {
    while (c.available()) {
      int v = c.read();
      if (v < 0) break;
      head += (char)v;
      if (head.endsWith("\r\n\r\n")) return true;
      if (head.length() >= MAX_HEAD_BYTES) return true;   // 头过长：截断但算成功
    }
    if (!c.connected() && !c.available()) return false;
    delay(0);
  }
  return false;
}

/**
 * 取响应头的值（不区分大小写）。
 * 服务器写的永远是标准大小写（Transfer-Encoding），而调用方习惯写小写，
 * 所以这里统一转小写后匹配 —— 只走一条路径，不留两条会分叉的代码。
 */
String headerValue(const String& head, const char* name) {
  String low = head;
  low.toLowerCase();
  String key = String("\r\n");
  key += name;
  key.toLowerCase();
  key += ":";

  int p = low.indexOf(key);
  if (p < 0) return "";
  int start = p + key.length();
  int e = low.indexOf("\r\n", start);
  if (e < 0) e = low.length();
  // String::trim() 返回 void（原地改），不能链式调用
  String v = head.substring(start, e);
  v.trim();
  return v;
}

/**
 * 把 body 流出去。chunked 要解（服务器常用），gzip 不解（板子扛不动 inflate，
 * 所以请求里默认带 Accept-Encoding: identity —— 见 buildRequest）。
 * 返回实际发出的字节数；truncated 表示撞到了 maxBytes 上限。
 */
/**
 * 抓取期间的看门狗心跳。
 *
 * doFetch() 是同步的，一次能堵住 loop() 十几秒。这期间心跳发不出去，
 * Manager 那边 50 秒 TTL 一到就判离线 —— 这正是之前修过的假离线，
 * 只是换了个触发方式：连续两次大抓取就够了。
 *
 * 所以读 body 的过程中也要定期发心跳。间隔 2 秒，和正常心跳周期同量级。
 */
void maybeHb(uint32_t& lastHbAt) {
  if ((int32_t)(millis() - lastHbAt) >= 2000) {
    lastHbAt = millis();
    sendHb();
  }
}

size_t streamBody(Client& c, int ch, bool chunked, size_t maxBytes, uint32_t idleMs,
                  size_t contentLength, bool& truncated) {
  truncated = false;
  size_t total = 0;
  uint32_t lastData = millis();
  uint32_t lastHbAt = millis();

  if (!chunked && contentLength > 0) {
    // 定长：读够就走
    while (total < contentLength && total < maxBytes) {
      if ((int32_t)(millis() - lastData) > (int32_t)idleMs) break;
      int avail = c.available();
      maybeHb(lastHbAt);
      if (avail <= 0) {
        if (!c.connected()) break;
        delay(0);
        continue;
      }
      size_t want = contentLength - total;
      if (want > (size_t)avail) want = avail;
      if (want > TOOL_CHUNK) want = TOOL_CHUNK;
      int n = c.read(txBuf + 2, want);
      if (n <= 0) break;
      if (!sendDataChunk(ch, txBuf + 2, (size_t)n)) break;
      total += n;
      lastData = millis();
    }
    // 只要没读满就是截断 —— 不管是被 maxBytes 截断、空闲超时、发送失败还是连接断掉。
    // 原来只在 total >= maxBytes 时才标记，于是「提前退出」这种最常见的截断
    // 反倒不上报，调用方拿到半截内容还以为是完整的。
    if (total < contentLength) truncated = true;
    return total;
  }

  if (chunked) {
    // chunked：<hex 长度>\r\n <数据> \r\n …… 0\r\n\r\n
    bool sawEnd = false;   // 有没有读到 0 长度的结束块
    while (total < maxBytes) {
      // 读长度行
      String line = "";
      uint32_t t0 = millis();
      while ((int32_t)(millis() - t0) < (int32_t)idleMs) {
        if (!c.available()) {
          if (!c.connected()) break;
          delay(0);
          continue;
        }
        char ch2 = (char)c.read();
        if (ch2 == '\n') break;
        if (ch2 != '\r') line += ch2;
        if (line.length() > 16) break;
      }
      long sz = strtol(line.c_str(), nullptr, 16);
      if (sz <= 0) { sawEnd = true; break; }   // 0 = 结束块

      long left = sz;
      while (left > 0 && total < maxBytes) {
        int avail = c.available();
        maybeHb(lastHbAt);
        if (avail <= 0) {
          if (!c.connected()) { left = 0; break; }
          delay(0);
          continue;
        }
        size_t want = (size_t)left;
        if (want > (size_t)avail) want = avail;
        if (want > TOOL_CHUNK) want = TOOL_CHUNK;
        int n = c.read(txBuf + 2, want);
        if (n <= 0) { left = 0; break; }
        if (!sendDataChunk(ch, txBuf + 2, (size_t)n)) { left = 0; break; }
        total += n;
        left -= n;
        lastData = millis();
      }
      // 吃掉块尾的 \r\n
      c.read(); c.read();
      if (total >= maxBytes) { truncated = true; break; }
    }
    // 没读到结束块就断了 → 内容不完整，必须上报。
    // 原来这种情况静默返回，调用方会把半截当成完整的。
    if (!sawEnd && total > 0) truncated = true;
    return total;
  }

  // 无长度信息：读到断开为止
  while (total < maxBytes) {
    if ((int32_t)(millis() - lastData) > (int32_t)idleMs) break;
    int avail = c.available();
    maybeHb(lastHbAt);
    if (avail <= 0) {
      if (!c.connected()) break;
      delay(0);
      continue;
    }
    size_t want = (size_t)avail;
    if (want > TOOL_CHUNK) want = TOOL_CHUNK;
    int n = c.read(txBuf + 2, want);
    if (n <= 0) break;
    if (!sendDataChunk(ch, txBuf + 2, (size_t)n)) break;
    total += n;
    lastData = millis();
  }
  if (total >= maxBytes) truncated = true;
  return total;
}

/**
 * 一次 https_fetch / http_get。
 * 支持 3 跳重定向（douyin 的短链就是 301/302，不跟就全是 3xx）；
 * 结果体边读边发 DATA，不在内存里攒整包 —— C6 只有 512KB SRAM 且无 PSRAM。
 */
void doFetch(const char* id, int ch, JsonObject args, FetchResult& r) {
  Target t;
  t.tls  = args["tls"] | (strcmp(args["_tool"] | "https_fetch", "http_get") != 0);
  t.host = String(args["host"] | "");
  t.port = t.tls ? 443 : 80;
  t.path = String(args["path"] | "/");

  String hostIn = String(args["url"] | "");
  if (t.host.length() == 0 && hostIn.length() > 0) {
    if (!parseAbsUrl(hostIn, t)) { r.err = "bad url"; return; }
  }
  if (args["port"].is<int>()) t.port = (uint16_t)args["port"].as<int>();
  if (t.host.length() == 0) { r.err = "host required"; return; }
  if (t.path.length() == 0) t.path = "/";

  String method = String(args["method"] | "GET");
  method.toUpperCase();
  String body   = String(args["body"] | "");
  JsonObject hdrs = args["headers"].as<JsonObject>();

  // ── 二进制请求体 ──
  // args.body 是 JSON 字符串，C 层遇到 0x00 就截断：实测发 8 字节 `AA\0BB\0CC`
  // 目标只收到 `AA`，Content-Length 也被写成 2。protobuf / gRPC 类接口
  // （抖音私信、大部分 protobuf API）全都踩这一脚。
  // 所以二进制改走 bodyB64：base64 里没有 0x00，能原样穿过 JSON。
  String bodyB64 = String(args["bodyB64"] | "");
  uint8_t* binBody = nullptr;
  size_t   binLen  = 0;
  // 用 guard 兜住所有 return：这个函数里有十几处提前返回，漏一个就是内存泄漏
  struct BinGuard {
    uint8_t* p;
    ~BinGuard() { if (p) free(p); }
  } binGuard{nullptr};

  if (bodyB64.length() > 0) {
    size_t cap = bodyB64.length() * 3 / 4 + 4;
    uint8_t* buf = (uint8_t*)malloc(cap);
    if (!buf) { r.err = "oom for bodyB64"; return; }
    binGuard.p = buf;
    binLen = b64Decode(bodyB64, buf, cap);
    if (binLen == 0) { r.err = "bad base64 body"; return; }
    body = "";                                  // 两条路只能选一条
  }
  size_t bodyBytes = binLen > 0 ? binLen : body.length();

  uint32_t timeoutMs = args["timeoutMs"] | FETCH_TIMEOUT_MS;
  if (timeoutMs > 12000) timeoutMs = 12000;
  size_t maxBytes = (size_t)(args["maxBytes"] | (uint32_t)MAX_BODY_BYTES);
  if (maxBytes > 262144) maxBytes = 262144;

  uint32_t t0 = millis();
  uint32_t budgetEnd = t0 + MAX_TOTAL_FETCH_MS;

  for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // 总预算到了就不开新跳：宁可回一条明确的 timeout，也不要让 loop() 无限期堵着
    if ((int32_t)(millis() - budgetEnd) >= 0) {
      r.err = "fetch budget exceeded";
      return;
    }
    WiFiClientSecure sc;
    WiFiClient       pc;
    Client*          c = nullptr;

    bool connected;
    if (t.tls) {
      sc.setInsecure();   // 不校验证书：C6 上没有证书包，且我们只取公开网页
      connected = sc.connect(t.host.c_str(), t.port, (int32_t)timeoutMs) == 1;
      c = &sc;
    } else {
      connected = pc.connect(t.host.c_str(), t.port, (int32_t)timeoutMs) == 1;
      c = &pc;
    }
    if (!connected) {
      r.err = String("connect failed: ") + t.host + ":" + t.port;
      return;
    }

    // ── 拼请求 ──
    String req;
    req.reserve(512);
    req += method + " " + t.path + " HTTP/1.1\r\n";
    req += "Host: " + t.host + "\r\n";
    // 调用方自带 UA 就用它的。原来无条件写死 ESP32-C6-Exit/2.0，
    // 大多数站点看到这一行直接识破并拒绝，等于把这个出口锁死在
    // "只能抓不在乎来源的页面"这个范围里 —— 那样就谈不上通用了。
    // 自定义 UA 由下面遍历 hdrs 时写入，这里只在没给的时候补默认值。
    bool uaGiven = false;
    for (JsonPair kv : hdrs) {
      String k = String(kv.key().c_str());
      k.toLowerCase();
      if (k == "user-agent") { uaGiven = true; break; }
    }
    if (!uaGiven) req += "User-Agent: ESP32-C6-Exit/" FW_VERSION "\r\n";
    req += "Accept: */*\r\n";
    // 关键：不要 gzip。板子解不了 inflate，压过的字节拿回来 Worker 也只能原样转发。
    req += "Accept-Encoding: identity\r\n";
    req += "Connection: close\r\n";
    for (JsonPair kv : hdrs) {
      String k = String(kv.key().c_str());
      String low = k;
      low.toLowerCase();
      if (low == "host" || low == "accept-encoding" || low == "connection") continue;
      // as<String>() 而不是 as<const char*>()：后者遇到非字符串值返回 nullptr，
      // 塞进 String 拼接会直接把固件搞崩
      req += k + ": " + kv.value().as<String>() + "\r\n";
    }
    if (bodyBytes > 0) req += "Content-Length: " + String((unsigned)bodyBytes) + "\r\n";
    req += "\r\n";

    c->write((const uint8_t*)req.c_str(), req.length());
    // body 必须按字节单独写，不能拼进 String —— 拼进去就会被 0x00 截断
    if (bodyBytes > 0) {
      if (binLen > 0) c->write(binGuard.p, binLen);
      else            c->write((const uint8_t*)body.c_str(), body.length());
    }
    c->flush();

    // ── 读头 ──
    String head;
    if (!readHeaders(*c, head, millis() + timeoutMs)) {
      c->stop();
      r.err = "no response headers";
      return;
    }

    int sp = head.indexOf(' ');
    r.status = (sp > 0) ? head.substring(sp + 1, head.indexOf(' ', sp + 1)).toInt() : -1;

    bool   chunked  = false;
    String te = headerValue(head, "transfer-encoding");
    te.toLowerCase();
    if (te.indexOf("chunked") >= 0) chunked = true;

    String cl = headerValue(head, "content-length");
    size_t contentLength = cl.length() ? (size_t)cl.toInt() : 0;

    // 每一跳都更新：跟随重定向后，最终内容的类型以最后一跳为准
    String ct = headerValue(head, "content-type");
    if (ct.length()) r.contentType = ct;

    // ── 重定向 ──
    if ((r.status == 301 || r.status == 302 || r.status == 303 || r.status == 307 ||
         r.status == 308) && hop < MAX_REDIRECTS) {
      String loc = headerValue(head, "location");
      c->stop();
      if (loc.length() == 0) { r.err = String("redirect without location"); return; }
      Target nt = t;
      if (loc.startsWith("http://") || loc.startsWith("https://")) {
        if (!parseAbsUrl(loc, nt)) { r.err = "bad redirect url"; return; }
      } else if (loc.startsWith("/")) {
        nt.host = t.host; nt.port = t.port; nt.tls = t.tls; nt.path = loc;
      } else {
        r.err = "relative redirect unsupported";
        return;
      }
      if (r.status == 303) method = "GET";
      logf("[fetch] %d -> %s%s\n", r.status, nt.host.c_str(), nt.path.c_str());
      t = nt;
      r.redirects++;
      continue;
    }

    // ── 发 body ──
    r.bytes = streamBody(*c, ch, chunked, maxBytes, timeoutMs, contentLength, r.truncated);
    r.finalHost = t.host;
    c->stop();

    r.ok = (r.status >= 200 && r.status < 400);
    if (!r.ok && r.err.length() == 0) r.err = String("http ") + r.status;

    logf("[fetch] %s%s -> %d, %u bytes, %d hops, %lums%s\n", t.host.c_str(),
                  t.path.c_str(), r.status, (unsigned)r.bytes, r.redirects,
                  (unsigned long)(millis() - t0), r.truncated ? " (truncated)" : "");
    return;
  }

  r.err = "too many redirects";
}

// ═══════════════════════════ OTA 自更新 ═══════════════════════════
//
// 为什么是「设备自己拉」而不是「面板往里推」。
//
// 推的方案看着更直接（点一下按钮，把 bin 顺着 WS 灌下去），但它依赖的正是那条
// 会坏的链路：传 1.2MB 期间心跳断一次、设备重启一次，灌进去的就是半截镜像，
// 而半截镜像已经写进了分区 —— 为了省一次插线，换来的是必须插线。
//
// 拉的方案里设备只做一件事：发一个 HTTPS GET。收到多少写多少，写完校验 sha256，
// 校验不过就 abort，旧固件毫发无损。链路差只会让升级变慢。
//
// 真正让这件事安全的是回滚：新固件写进「另一个」app 分区，重启后 90 秒内
// 连不上 WS（或连续几次起不来）就自动切回旧分区。少了这一步，OTA 只是把
// 「变砖」从需要插线变成不需要插线。

#if OTA_ENABLE

static Preferences prefs;

static mbedtls_sha256_context otaSha;
static size_t otaWritten = 0;
static String otaBodyBuf;
uint32_t otaInterval = OTA_CHECK_EVERY_MS;

// 当前机型在 manifest 里的键。8MB 和 4MB 编出来的 app 不一样，不能混发。
const char* otaChipKey() {
  const char* m = ESP.getChipModel();
  if (strstr(m, "C6"))   return "c6";
  if (strstr(m, "D0WD")) return "d0wd";
  if (strstr(m, "S3"))   return "s3";
  return "unknown";
}

void otaSetResult(const char* s) {
  snprintf(otaLastResult, sizeof(otaLastResult), "%s", s);
}

// 切回上一个分区。注意「上一个」在 OTA 成功并重启之后就是
// esp_ota_get_next_update_partition() 返回的那个 —— 因为升级已经把它写旧了，
// 它正是当前没在跑的那一半。
void otaRollback(const char* why) {
  logf("[ota] 回滚：%s\n", why);
  const esp_partition_t* prev = esp_ota_get_next_update_partition(nullptr);
  prefs.putBool("pend", false);
  prefs.putUChar("boots", 0);
  if (prev && esp_ota_set_boot_partition(prev) == ESP_OK) {
    logf("[ota] 启动分区切回 %s，重启\n", prev->label);
    delay(300);
    ESP.restart();
  }
  logf("[ota] 没有可回退的分区，留在当前固件\n");
}

static bool sinkToUpdate(const uint8_t* p, size_t n) {
  if (Update.write((uint8_t*)p, n) != n) return false;
  mbedtls_sha256_update(&otaSha, p, n);
  otaWritten += n;
  return true;
}

static bool sinkToString(const uint8_t* p, size_t n) {
  if (otaBodyBuf.length() + n > 4096) return false;   // manifest 不该这么大
  otaBodyBuf.concat((const char*)p, n);
  return true;
}

/**
 * 带 Bearer 的 HTTPS GET，body 边收边交给 sink。
 *
 * 不走 doFetch 的原因：doFetch 的出口是 sendDataChunk（把字节塞进 WS），
 * 这里要的是把字节塞进 Update()。复用会让原本跑通的抓取路径多背一份风险。
 *
 * 鉴权是必须的：固件二进制里硬编码着 TUNNEL_TOKEN 和 WiFi 口令，
 * 谁下到它谁就能冒充这台设备（连进你家内网）。所以 /fw/* 只认设备的 Bearer。
 *
 * 返回 HTTP 状态码；<0 表示传输层失败。
 */
int otaStreamGet(const String& path, OtaSink sink, String& err) {
  WiFiClientSecure sc;
  sc.setCACert(ROOT_CA);
  sc.setTimeout(15000);
  if (sc.connect(WS_HOST, 443, 15000) != 1) { err = "connect failed"; return -1; }

  String req = String("GET ") + path + " HTTP/1.1\r\nHost: " + WS_HOST + "\r\n";
  req += "User-Agent: ESP32-Exit-OTA/" FW_VERSION "\r\n";
  req += "Accept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n";
  req += String("Authorization: Bearer ") + WS_TOKEN + "\r\n\r\n";
  sc.write((const uint8_t*)req.c_str(), req.length());
  sc.flush();

  String head;
  if (!readHeaders(sc, head, millis() + 15000)) { sc.stop(); err = "no response head"; return -1; }
  int sp = head.indexOf(' ');
  int status = (sp > 0) ? head.substring(sp + 1, head.indexOf(' ', sp + 1)).toInt() : -1;

  bool   chunked = false;
  String te = headerValue(head, "transfer-encoding");
  te.toLowerCase();
  if (te.indexOf("chunked") >= 0) chunked = true;
  String cl = headerValue(head, "content-length");
  size_t len = cl.length() ? (size_t)cl.toInt() : 0;

  uint32_t deadline = millis() + OTA_DL_BUDGET_MS;
  uint8_t  buf[512];
  bool     ok = true;

  if (chunked) {
    while (ok) {
      if ((int32_t)(millis() - deadline) >= 0) { err = "chunked timeout"; ok = false; break; }
      String line = sc.readStringUntil('\n');
      line.trim();
      long sz = strtol(line.c_str(), nullptr, 16);
      if (sz <= 0) break;                       // 末块 0\r\n
      size_t left = (size_t)sz;
      while (left > 0 && ok) {
        if ((int32_t)(millis() - deadline) >= 0) { err = "chunked timeout"; ok = false; break; }
        size_t want = left < sizeof(buf) ? left : sizeof(buf);
        int n = sc.read(buf, want);
        if (n <= 0) { err = "chunk read timeout"; ok = false; break; }
        if (!sink(buf, (size_t)n)) { err = "sink rejected"; ok = false; break; }
        left -= (size_t)n;
      }
      sc.readStringUntil('\n');                 // 块尾 CRLF
    }
  } else if (len > 0) {
    size_t left = len;
    while (left > 0 && ok) {
      if ((int32_t)(millis() - deadline) >= 0) { err = "download timeout"; ok = false; break; }
      size_t want = left < sizeof(buf) ? left : sizeof(buf);
      if (sc.available() > 0 && (size_t)sc.available() < want) want = (size_t)sc.available();
      int n = sc.read(buf, want);
      if (n <= 0) {
        if (!sc.connected() && sc.available() == 0) { err = "closed early"; ok = false; break; }
        delay(2);
        continue;
      }
      if (!sink(buf, (size_t)n)) { err = "sink rejected"; ok = false; break; }
      left -= (size_t)n;
    }
  } else {
    // 既没 Content-Length 也没 chunked：读到断开为止
    while (ok) {
      if ((int32_t)(millis() - deadline) >= 0) { err = "download timeout"; ok = false; break; }
      int n = sc.read(buf, sizeof(buf));
      if (n <= 0) { if (!sc.connected()) break; delay(2); continue; }
      if (!sink(buf, (size_t)n)) { err = "sink rejected"; ok = false; break; }
    }
  }

  sc.stop();
  if (!ok) return -2;
  return status;
}

/**
 * 查一次 manifest，有新版就升级。
 * force=true 时不比较版本，同版本也重刷（用于「按钮强制刷一遍」验证链路）。
 */
void otaCheckAndRun(bool force) {
  if (!WS_TLS) { logf("[ota] 明文联调模式，跳过 OTA\n"); return; }
  if (inflight > 0) return;                      // 正在干活就别抢 loop()

  otaLastCheckAt = millis();
  otaBodyBuf = "";
  String err;
  int st = otaStreamGet(OTA_MANIFEST_PATH, sinkToString, err);
  if (st != 200) {
    otaInterval = 600000UL;                      // 失败 10 分钟后再试，别等 6 小时
    char b[28];
    snprintf(b, sizeof(b), "err:%d", st);
    otaSetResult(b);
    logf("[ota] manifest 失败 st=%d %s\n", st, err.c_str());
    return;
  }

  JsonDocument md;
  if (deserializeJson(md, otaBodyBuf)) {
    otaInterval = 600000UL;
    otaSetResult("bad-manifest");
    logf("[ota] manifest 不是合法 JSON\n");
    return;
  }
  JsonObject e = md[otaChipKey()].as<JsonObject>();
  const char* ver = e["ver"] | "";
  const char* sha = e["sha256"] | "";
  const char* url = e["url"] | "";
  size_t      sz  = (size_t)(e["size"] | 0);
  snprintf(otaLastVer, sizeof(otaLastVer), "%s", ver[0] ? ver : "-");

  if (!ver[0] || !url[0] || sz == 0) {
    otaInterval = 600000UL;
    otaSetResult("no-manifest-entry");
    logf("[ota] manifest 里没有 %s 这一项\n", otaChipKey());
    return;
  }
  if (!force && strcmp(ver, FW_VERSION) == 0) {
    otaInterval = OTA_CHECK_EVERY_MS;
    otaSetResult("no-update");
    logf("[ota] 已是最新 %s\n", FW_VERSION);
    return;
  }

  const esp_partition_t* run = esp_ota_get_running_partition();
  if (!run) {
    otaInterval = OTA_CHECK_EVERY_MS;
    otaSetResult("no-partition");
    return;
  }
  // 分区装不下就别开始：Update.begin 之后失败会把分区擦掉，
  // 虽然不影响正在跑的这半边，但没必要冒这个险。
  if (sz > run->size - 8192) {
    otaInterval = OTA_CHECK_EVERY_MS;
    otaSetResult("image-too-big");
    logf("[ota] 镜像 %u 字节 > 分区 %u 字节，拒绝\n", (unsigned)sz,
                  (unsigned)run->size);
    return;
  }

  logf("[ota] 发现 %s（本地 %s）%u 字节，开始下载\n", ver, FW_VERSION, (unsigned)sz);
  if (!Update.begin(sz, U_FLASH)) {
    otaInterval = 600000UL;
    otaSetResult("begin-failed");
    logf("[ota] Update.begin 失败: %s\n", Update.errorString());
    return;
  }
  mbedtls_sha256_init(&otaSha);
  mbedtls_sha256_starts(&otaSha, 0);
  otaWritten = 0;

  err = "";
  int st2 = otaStreamGet(String(url), sinkToUpdate, err);
  if (st2 != 200 || otaWritten != sz) {
    Update.abort();
    mbedtls_sha256_free(&otaSha);
    otaInterval = 600000UL;
    otaSetResult("download-failed");
    logf("[ota] 下载失败 st=%d %u/%u 字节 %s\n", st2, (unsigned)otaWritten,
                  (unsigned)sz, err.c_str());
    return;
  }

  uint8_t digest[32];
  mbedtls_sha256_finish(&otaSha, digest);
  mbedtls_sha256_free(&otaSha);

  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);

  if (sha[0] && strcasecmp(hex, sha) != 0) {
    Update.abort();
    otaInterval = 600000UL;
    otaSetResult("sha-mismatch");
    logf("[ota] sha256 不符，已放弃（本地 %s）\n", hex);
    return;
  }

  if (!Update.end(true)) {
    otaInterval = 600000UL;
    otaSetResult("end-failed");
    logf("[ota] Update.end 失败: %s\n", Update.errorString());
    return;
  }

  // 打完标记再重启：新固件起来后 90 秒内连不上 WS 会自动回滚
  prefs.putBool("pend", true);
  prefs.putUChar("boots", 0);
  otaSetResult("updated");
  logf("[ota] 写入完成 %u 字节，重启进 %s\n", (unsigned)otaWritten, ver);
  delay(400);
  ESP.restart();
}

// 启动时检查「上一次是不是刚 OTA 完」。连续起不来就直接回滚，
// 不等 90 秒 —— 有些坏固件是崩溃循环，根本活不到 90 秒。
void otaBootGuard() {
  prefs.begin("ota", false);
  otaPending = prefs.getBool("pend", false);
  if (!otaPending) return;
  uint8_t b = prefs.getUChar("boots", 0) + 1;
  prefs.putUChar("boots", b);
  logf("[ota] 新固件第 %u 次启动，90s 内连上 WS 才算成功\n", b);
  if (b > 2) otaRollback("连续多次起不来（新固件可能在崩溃循环）");
}

void otaConfirm() {
  if (!otaPending) return;
  otaPending = false;
  prefs.putBool("pend", false);
  prefs.putUChar("boots", 0);
  logf("[ota] 新固件 " FW_VERSION " 已联网，升级成功\n");
}

void otaLoop() {
  if (otaPending && millis() - bootAt > OTA_BOOT_CONFIRM_MS) {
    otaRollback("升级后 90s 内没连上 WS");
  }
  bool due = (otaLastCheckAt == 0)
               ? (millis() > OTA_FIRST_CHECK_MS)
               : (millis() - otaLastCheckAt > otaInterval);
  // 隧道正常时查；隧道死活连不上时也要查 —— 那种情况恰恰最该换固件
  if (due && (tunnelOn || millis() > 120000UL)) otaCheckAndRun(false);
}

#endif  // OTA_ENABLE

// ═══════════════════════════ 工具分发 ═══════════════════════════

void toolNetInfo(int ch, size_t& bytes) {
  String j = "{\"model\":\"" + String(ESP.getChipModel()) + "\",\"fw\":\"" FW_VERSION "\",";
  j += "\"chip\":\"" + String(ESP.getChipModel()) + "\",";
  // caps：让上层知道这台设备会什么。body_b64 决定能不能接 protobuf 类任务，
  // ota 决定面板上的「检查更新」对它有没有意义。
  const esp_partition_t* run = esp_ota_get_running_partition();
  j += "\"caps\":[\"fetch\",\"body_b64\"";
#if OTA_ENABLE
  j += ",\"ota\"";
#endif
  j += "],";
  if (run) {
    j += "\"appSize\":" + String((unsigned)run->size) + ",";
    size_t used = ESP.getSketchSize();
    j += "\"appUsed\":" + String((unsigned)used) + ",";
    j += "\"appFree\":" + String((unsigned)(run->size > used ? run->size - used : 0)) + ",";
  }
  j += "\"cores\":" + String(ESP.getChipCores()) + ",";
  j += "\"cpu\":" + String(ESP.getCpuFreqMHz()) + ",";
  j += "\"flash\":" + String(ESP.getFlashChipSize()) + ",";
  j += "\"heap\":" + String(ESP.getFreeHeap()) + ",";
  j += "\"heapmin\":" + String(ESP.getMinFreeHeap()) + ",";
  j += "\"largest\":" + String(ESP.getMaxAllocHeap()) + ",";
  j += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  j += "\"gw\":\"" + WiFi.gatewayIP().toString() + "\",";
  j += "\"mask\":\"" + WiFi.subnetMask().toString() + "\",";
  j += "\"dns\":\"" + WiFi.dnsIP().toString() + "\",";
  j += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  j += "\"ssid\":\"" + WiFi.SSID() + "\",";
  j += "\"mac\":\"" + WiFi.macAddress() + "\",";
  j += "\"up\":" + String(tunnelOn ? (millis() - tunnelUpAt) / 1000 : 0) + ",";
  j += "\"wol\":" + String(wolCount) + ",";
  j += "\"calls\":{\"ok\":" + String(callOk) + ",\"fail\":" + String(callFail) + "}";
  j += "}";
  sendDataChunk(ch, (const uint8_t*)j.c_str(), j.length());
  bytes = j.length();
}

void toolDns(int ch, JsonObject args, size_t& bytes, String& err) {
  String host = String(args["host"] | "");
  if (host.length() == 0) { err = "host required"; return; }
  IPAddress ip;
  uint32_t t0 = millis();
  if (!WiFi.hostByName(host.c_str(), ip)) { err = "resolve failed"; return; }
  String j = "{\"host\":\"" + host + "\",\"ip\":\"" + ip.toString() +
             "\",\"ms\":" + String(millis() - t0) + "}";
  sendDataChunk(ch, (const uint8_t*)j.c_str(), j.length());
  bytes = j.length();
}

/**
 * 固件与水位的只读快照。面板靠它显示「当前版本 / 分区余量 / 上次检查结果」，
 * 也是判断这台设备到底支不支持 OTA 的唯一依据（caps 里的 ota）。
 */
void toolFwInfo(int ch, size_t& bytes) {
  const esp_partition_t* run = esp_ota_get_running_partition();
  String j = "{\"fw\":\"" FW_VERSION "\",\"chip\":\"" + String(ESP.getChipModel()) + "\",";
  j += "\"partition\":\"" + String(run ? run->label : "?") + "\",";
  j += "\"appSize\":" + String(run ? (unsigned)run->size : 0) + ",";
  j += "\"appUsed\":" + String((unsigned)ESP.getSketchSize()) + ",";
#if OTA_ENABLE
  j += "\"ota\":true,";
  j += "\"pending\":" + String(otaPending ? "true" : "false") + ",";
  j += "\"lastVer\":\"" + String(otaLastVer) + "\",";
  j += "\"lastResult\":\"" + String(otaLastResult) + "\",";
  j += "\"lastCheckAgo\":" + String(otaLastCheckAt ? (millis() - otaLastCheckAt) / 1000 : -1);
#else
  j += "\"ota\":false";
#endif
  j += "}";
  sendDataChunk(ch, (const uint8_t*)j.c_str(), j.length());
  bytes = j.length();
}

/**
 * 处理一条 call。返回后 result 已发出。
 *
 * 关于 inflight：主循环是单线程的，一次 fetch 期间新的 CALL 只能排在 WS 缓冲区里，
 * 所以设备真实的并发能力是 1，不是 2。把 capacity 报成 2 会让 Manager 以为
 * 还有余量继续派活，结果排队越来越长、每条都更慢 —— 那是把「排队」伪装成「并发」。
 */
void handleCall(const char* id, const char* tool, JsonObject args, int ch) {
  struct InflightGuard {
    InflightGuard() { inflight++; }
    ~InflightGuard() { inflight--; }
  } guard;

  uint32_t t0 = millis();
  uint32_t heapBefore = ESP.getFreeHeap();
  size_t   bytes = 0;
  String   err;
  int      status = 0;
  int      redirects = 0;
  String   host;

  logf("[call] id=%s tool=%s ch=%d heap=%u largest=%u\n", id, tool, ch,
                (unsigned)heapBefore, (unsigned)ESP.getMaxAllocHeap());

  if (strcmp(tool, "net_info") == 0) {
    toolNetInfo(ch, bytes);
  } else if (strcmp(tool, "fw_info") == 0) {
    toolFwInfo(ch, bytes);
  } else if (strcmp(tool, "dns_lookup") == 0) {
    toolDns(ch, args, bytes, err);
  } else if (strcmp(tool, "wol") == 0) {
    uint8_t mac[6];
    memcpy(mac, TARGET_MAC, 6);
    String m = String(args["mac"] | "");
    if (m.length() >= 17) {
      for (int i = 0; i < 6; i++) mac[i] = (uint8_t)strtol(m.substring(i * 3, i * 3 + 2).c_str(), nullptr, 16);
    }
    sendWOL(mac, "remote");
  } else if (strcmp(tool, "https_fetch") == 0 || strcmp(tool, "http_get") == 0) {
    FetchResult r;
    args["_tool"] = tool;                    // 让 doFetch 知道默认是否走 TLS
    doFetch(id, ch, args, r);
    bytes     = r.bytes;
    status    = r.status;
    redirects = r.redirects;
    host      = r.finalHost.length() ? r.finalHost : String(args["host"] | "");
    err       = r.err;
    if (r.truncated) err = err.length() ? err + " (truncated)" : "truncated";
    if (!r.ok) {
      callFail++;
      sendResult(id, false, err.length() ? err.c_str() : "fetch failed", status, bytes,
                 millis() - t0, host.c_str(), redirects, r.truncated, r.contentType.c_str());
      return;
    }
    callOk++;
    sendResult(id, true, nullptr, status, bytes, millis() - t0, host.c_str(), redirects,
               r.truncated, r.contentType.c_str());
    logf("[call] done heap=%u (peak drop %ld)\n", (unsigned)ESP.getFreeHeap(),
                  (long)heapBefore - (long)ESP.getFreeHeap());
    return;
  } else {
    sendResult(id, false, "tool_not_supported", 0, 0, millis() - t0, nullptr, 0);
    logf("[call] unsupported tool: %s\n", tool);
    callFail++;
    return;
  }

  if (err.length()) {
    callFail++;
    sendResult(id, false, err.c_str(), 0, bytes, millis() - t0, nullptr, 0);
    return;
  }
  callOk++;
  sendResult(id, true, nullptr, 0, bytes, millis() - t0, nullptr, 0);
  logf("[call] done heap=%u\n", (unsigned)ESP.getFreeHeap());
}

// ═══════════════════════════ 帧处理 ═══════════════════════════

void handleBin(const uint8_t* p, size_t n) {
  if (n < 1) return;
  switch (p[0]) {
    case F_WOL: {
      if (n < 7) return;
      uint8_t mac[6];
      bool allZero = true;
      for (int i = 0; i < 6; i++) {
        mac[i] = p[1 + i];
        if (mac[i]) allZero = false;
      }
      sendWOL(allZero ? TARGET_MAC : mac, "remote");
      break;
    }
    case F_OPEN: {
      // 本固件是应用层出口，不做 TCP 隧道 —— 明确回 CLOSE，不假装成功。
      if (n >= 2) {
        logf("[frame] OPEN ch=%d rejected (tcp tunnel not supported on this node)\n", p[1]);
        sendClose(p[1]);
      }
      break;
    }
    case F_DATA:
    case F_CLOSE:
      // 用户侧数据面：本固件没有对应通道，忽略
      break;
    default:
      logf("[frame] unknown bin type 0x%02X len=%u\n", p[0], (unsigned)n);
      break;
  }
}

void handleText(const uint8_t* p, size_t n) {
  JsonDocument d;
  DeserializationError e = deserializeJson(d, (const char*)p, n);
  if (e) {
    logf("[ctrl] bad json: %s\n", e.c_str());
    return;
  }
  const char* t = d["t"] | "";
  if (strcmp(t, "call") == 0) {
    const char* id   = d["id"] | "";
    const char* tool = d["tool"] | "";
    int ch = d["ch"] | -1;
    if (!id[0] || !tool[0] || ch < 0) {
      logf("[ctrl] call missing id/tool/ch\n");
      return;
    }
    JsonObject args = d["args"].as<JsonObject>();
    handleCall(id, tool, args, ch);
    return;
  }
  if (strcmp(t, "ping") == 0) {
    JsonDocument r;
    r["t"]  = "pong";
    r["id"] = d["id"] | "";
    sendCtrl(r);
    return;
  }
#if OTA_ENABLE
  if (strcmp(t, "ota") == 0) {
    // 面板按钮走这条。必须先回 ack 再干活：下载会堵住 loop() 几十秒，
    // 不回 ack 的话按钮要一直转到 HTTP 超时，看起来像没反应。
    {
      JsonDocument r;
      r["t"]  = "ota_ack";
      r["fw"] = FW_VERSION;
      sendCtrl(r);
    }
    otaCheckAndRun(d["force"] | false);
    return;
  }
#endif
  logf("[ctrl] ignored: %s\n", t);
}

// ═══════════════════════════ WS 事件 ═══════════════════════════

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      tunnelOn   = true;
      tunnelUpAt = millis();
      lastTunnelOkAt = millis();
      helloSent  = false;
      logf("[WS] connected heap=%u largest=%u\n", (unsigned)ESP.getFreeHeap(),
                    (unsigned)ESP.getMaxAllocHeap());
      sendHello();                       // 连上立刻自我介绍，Manager 靠它登记节点
      lastHbAt = millis();
#if OTA_ENABLE
      otaConfirm();                      // 连上了就说明新固件是活的，撤销回滚标记
#endif
      break;

    case WStype_DISCONNECTED:
      tunnelOn  = false;
      helloSent = false;
      tunnelDownAt = millis();           // 断连看门狗从这里起算（不能从「连通时刻」算）
      logf("[WS] DISCONNECTED heap=%u largest=%u\n", (unsigned)ESP.getFreeHeap(),
                    (unsigned)ESP.getMaxAllocHeap());
      break;

    case WStype_ERROR:
      logf("[WS] ERROR heap=%u\n", (unsigned)ESP.getFreeHeap());
      break;

    case WStype_TEXT:
      handleText(payload, length);
      break;

    case WStype_BIN:
      handleBin(payload, length);
      break;

    default:
      break;
  }
}

void sendHello() {
  JsonDocument d;
  d["t"]        = "hello";
  d["node"]     = nodeId;
  d["model"]    = String(ESP.getChipModel()) + " " + String(ESP.getFlashChipSize() / 1048576) + "MB";
  d["fw"]       = FW_VERSION;
  JsonArray tools = d["tools"].to<JsonArray>();
  tools.add("https_fetch");
  tools.add("http_get");
  tools.add("net_info");
  tools.add("fw_info");
  tools.add("dns_lookup");
  tools.add("wol");
  d["capacity"] = 1;                      // 单线程串行处理，真实并发就是 1（见 handleCall 注释）
  d["heap"]     = ESP.getFreeHeap();
  d["rssi"]     = WiFi.RSSI();
  d["ip"]       = WiFi.localIP().toString();
  sendCtrl(d);
  helloSent = true;
  logf("[hello] node=%s fw=%s heap=%u rssi=%d ip=%s\n", nodeId, FW_VERSION,
                (unsigned)ESP.getFreeHeap(), WiFi.RSSI(), WiFi.localIP().toString().c_str());
}

void sendHb() {
  JsonDocument d;
  d["t"]     = "hb";
  d["heap"]  = ESP.getFreeHeap();
  d["rssi"]  = WiFi.RSSI();
  d["up"]    = tunnelOn ? (millis() - tunnelUpAt) / 1000 : 0;
  d["conns"] = inflight;
  d["fw"]    = FW_VERSION;
  sendCtrl(d);
}

// ═══════════════════════════ 连接 ═══════════════════════════

void startTunnel() {
  IPAddress rip;
  if (WiFi.hostByName(WS_HOST, rip)) {
    logf("[DNS] %s -> %s\n", WS_HOST, rip.toString().c_str());
  } else {
    logf("[DNS] FAILED to resolve %s\n", WS_HOST);
  }
  logf("[heap] free=%u largest=%u\n", (unsigned)ESP.getFreeHeap(),
                (unsigned)ESP.getMaxAllocHeap());

#if TLS_DIAG
  // 预检：单独握一次手，把失败原因打出来。
  // WebSocketsClient 只会告诉你「DISCONNECTED」，TLS 到底卡在哪一层完全看不到 ——
  // 排查那两天就是这么被坑住的：两块板子都只吐 DISCONNECTED，分不清是
  // TCP 不通、证书不认、还是时间不对。这里用 lastError() 拿到 mbedtls 的原话。
  if (WS_TLS) {
    WiFiClientSecure probe;
    probe.setCACert(ROOT_CA);
    uint32_t t0 = millis();
    int r = probe.connect(WS_HOST, 443, 8000);
    if (r == 1) {
      logf("[tls] 预检通过 %lums\n", (unsigned long)(millis() - t0));
    } else {
      char ebuf[160] = {0};
      probe.lastError(ebuf, sizeof(ebuf));
      logf("[tls] 预检失败 rc=%d %lums: %s\n", r, (unsigned long)(millis() - t0), ebuf);
    }
    probe.stop();
  }
#endif

  if (WS_TLS) {
    // 校验证书（根证书见文件上方的 ROOT_CA）。原来这里是 beginSSL 三参数版，
    // 不传 CA 也不传 fingerprint，库内部直接 setInsecure() —— 见上方那段注释。
    // 代价：必须先对时，否则证书有效期判断一定失败。对时在 onWifiOk() 里做。
    webSocket.beginSslWithCA(WS_HOST, WS_PORT, WS_PATH, ROOT_CA);
  } else {
    webSocket.begin(WS_HOST, WS_PORT, WS_PATH);
  }
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(WS_PING_MS, WS_PONG_MS, WS_PONG_FAIL);
  if (WS_TOKEN[0] != '\0') {
    // 库只保存指针 —— 必须 static，否则这块内存被回收后头发出去就是垃圾
    static String authHeader;
    authHeader = String("Authorization: Bearer ") + WS_TOKEN;
    webSocket.setExtraHeaders(authHeader.c_str());
  }
  logf("[WS] connecting %s://%s:%u%s\n", WS_TLS ? "wss" : "ws", WS_HOST, WS_PORT,
                WS_PATH);
}

/**
 * 对时。TLS 校验证书要判断有效期，而 C6 没有 RTC，开机 time() 还停在 1970，
 * 校验必然不过。所以连 wss 之前必须先拿到正确时间。
 *
 * 这里阻塞等待，但整机只会在「WiFi 第一次连上」时调用一次，启动阶段等 10 秒
 * 可以接受。失败不阻断流程，只把原因写清楚 —— 宁可连不上并说清楚，
 * 也绝不偷偷降级回 setInsecure（那等于把 TLS 防护整个扔掉，比现在更糟）。
 */
bool syncTimeBlocking(uint32_t budgetMs = 10000) {
  // 公共 NTP 的硬编码 IP。光猫刚重启那几分钟路由器 DNS 还没起来，域名对时必然
  // 失败；但 123/udp 往往已经通了 —— 用 IP 就绕过 DNS 这一层。
  // 这是「C6 卡死 3 小时」的直接诱因之一：对时一直失败 → 永不启动 TLS，
  // 而旧看门狗又要求「已对时」才肯重启，两边互锁。
  static const char* HOSTS[] = {"ntp.aliyun.com", "cn.pool.ntp.org", "ntp.tencent.com"};
  static const char* IPS[]   = {"203.107.6.88", "119.28.183.184", "120.25.115.20"};

  auto waitSync = [](uint32_t ms) -> bool {
    uint32_t t0 = millis();
    while (millis() - t0 < ms) {
      time_t now = time(nullptr);
      if (now > 1700000000L) {          // 2023-11 之后就算对上了
        struct tm tmv;
        localtime_r(&now, &tmv);
        logf("[ntp] 已对时 %04d-%02d-%02d %02d:%02d:%02d（%lums）\n",
                      tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                      tmv.tm_hour, tmv.tm_min, tmv.tm_sec,
                      (unsigned long)(millis() - t0));
        return true;
      }
      delay(200);
    }
    return false;
  };

  configTime(8 * 3600, 0, HOSTS[0], HOSTS[1], HOSTS[2]);
  logf("[ntp] 对时中…\n");
  if (waitSync(budgetMs / 2)) return true;

  logf("[ntp] 域名对时失败，改用 IP 绕过 DNS\n");
  configTime(8 * 3600, 0, IPS[0], IPS[1], IPS[2]);
  if (waitSync(budgetMs / 2)) return true;

  logf("[ntp] 对时失败：证书校验会因此失败，查一下 123/udp 有没有被路由器拦\n");
  return false;
}

/**
 * 把 DNS 固定成公共解析器。
 *
 * 实测本地路由器 DNS 对 v.douyin.com 会连丢两轮查询（4 秒以上）才回，而且回的是
 * 被运营商改写的 CNAME（xxx.queniuiq.com）；更糟的是 core 里的 hostByName() 没有
 * 超时参数，DNS 一卡就把整个 loop() 堵死，WS 心跳回不了 → 连接被掐。
 *
 * ⚠️ 必须在「每次」WiFi 连上后都调用，不能只在开机第一次：光猫重启会让 DHCP
 * 重新下发，setDNS 的结果会被覆盖回运营商解析器 —— 那之后域名全部解析错。
 */
void applyStaticDns() {
  if (WiFi.setDNS(IPAddress(223, 5, 5, 5), IPAddress(119, 29, 29, 29))) {
    logf("[dns] 已固定为 %s / %s\n", WiFi.dnsIP(0).toString().c_str(),
                  WiFi.dnsIP(1).toString().c_str());
  } else {
    logf("[dns] setDNS 失败，继续用 DHCP 下发的解析器\n");
  }
}

void onWifiOk() {
  bool first = (lastWifiOkAt == 0);
  if (first) {
    logf("[wifi] connected ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(),
                  WiFi.RSSI());
    logf("[dns] dhcp 给的解析器: %s\n", WiFi.dnsIP().toString().c_str());
    applyStaticDns();
    makeNodeId();
  } else if (wifiWasDown) {
    // WiFi 真的掉过再回来（loop 里亲眼看到 status != CONNECTED 才算）。
    //
    // 原来这里用「lastWifiOkAt 比现在旧 30 秒」来判断，这是错的：一次 TLS 连接
    // 阻塞 20 秒也会让时间戳变旧，于是把「网没断、只是连得慢」误判成「断线恢复」，
    // 接着又去重对时（再阻塞 8 秒），越堵越堵。状态必须由状态本身给出。
    wifiWasDown = false;
    logf("[wifi] 断线恢复，重设 DNS 并重新对时\n");
    applyStaticDns();          // DHCP 重下发会把 DNS 覆盖回运营商的
    timeSynced   = false;
    lastNtpTryAt = 0;
  }
  lastWifiOkAt = millis();

  // 对时没成功就不启动 TLS：时间停在 1970，证书校验必然失败，
  // 这时候去连只是白连一轮。每 30s 重试，成功为止。
  // 原版只在第一次连上时对一次时，一旦那次失败就再也没有第二次机会 ——
  // 凌晨路由器重启后的那次「永久连不上」正是这么来的。
  if (WS_TLS && !timeSynced) {
    if (lastNtpTryAt == 0 || millis() - lastNtpTryAt > 30000UL) {
      lastNtpTryAt = millis();
      timeSynced = syncTimeBlocking(8000);
    }
    if (!timeSynced) return;
  }

  if (!tunnelStarted) {
    tunnelStarted = true;
    startTunnel();
  }
}

// ═══════════════════════════ setup / loop ═══════════════════════════

#if NET_DIAG
void netDiagTcp(const char* host, uint16_t port, uint32_t ms) {
  WiFiClient c;
  uint32_t t0 = millis();
  int r = c.connect(host, port, (int32_t)ms);
  logf("[diag] tcp %s:%u -> %d (%lums)\n", host, port, r, (unsigned long)(millis() - t0));
  c.stop();
}

void netDiagTls(const char* label, bool insecure) {
  WiFiClientSecure c;
  if (insecure) c.setInsecure();
  else          c.setCACert(ROOT_CA);
  c.setHandshakeTimeout(8);
  uint32_t t0 = millis();
  int r = c.connect(WS_HOST, 443, 8000);
  logf("[diag] tls(%s) -> %d (%lums)\n", label, r, (unsigned long)(millis() - t0));
  if (r != 1) {
    char ebuf[160] = {0};
    c.lastError(ebuf, sizeof(ebuf));
    logf("[diag]   err: %s\n", ebuf);
  } else {
    c.stop();
  }
  c.stop();
}

void netDiag() {
  logf("[diag] ===== 联网自检开始 =====\n");
  logf("[diag] v6 global=%s link=%s\n", WiFi.globalIPv6().toString().c_str(),
                WiFi.linkLocalIPv6().toString().c_str());
  netDiagTcp("223.5.5.5", 53, 5000);          // 出口通不通
  netDiagTcp(WS_HOST, 443, 8000);             // 到 CF 的 TCP（走域名）
  netDiagTcp("104.21.47.223", 443, 6000);     // 同一个 CF 边缘，走字面 IPv4
  netDiagTcp("172.67.173.205", 443, 6000);    // 另一个 CF 边缘
  netDiagTcp("182.61.200.7", 443, 5000);      // 百度（国内基线）
  netDiagTls("带证书校验", false);
  netDiagTls("不校验证书", true);
  logf("[diag] ===== 联网自检结束 =====\n");
  delay(200);
}
#endif

void setup() {
  Serial.begin(115200);
  delay(300);
  bootAt = millis();
  Serial.println();
  Serial.println("=== ESP32 住宅出口 v" FW_VERSION " ===");
  logf("[chip] model=%s cores=%d cpu=%uMHz flash=%u bytes\n", ESP.getChipModel(),
                ESP.getChipCores(), (unsigned)ESP.getCpuFreqMHz(),
                (unsigned)ESP.getFlashChipSize());
  logf("[heap] boot free=%u largest=%u\n", (unsigned)ESP.getFreeHeap(),
                (unsigned)ESP.getMaxAllocHeap());
  logf("[ota] %s\n", OTA_ENABLE ? "已编入（可远程升级）" : "未编入（本机只能插线刷）");

#if OTA_ENABLE
  otaBootGuard();     // 上一次是不是刚 OTA 完？连续起不来就回滚
#endif

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  // 关掉省电：省电模式下 TLS 握手时会进 modem sleep，RSSI 抖动大、握手更容易超时
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  logf("[wifi] connecting to %s\n", WIFI_SSID);

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(200);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
#if NET_DIAG
    netDiag();
#endif
    onWifiOk();
  } else {
    logf("[wifi] FAILED, will keep retrying in loop()\n");
  }
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    onWifiOk();
    webSocket.loop();

#if OTA_ENABLE
    otaLoop();     // 到点自查 manifest；升级/回滚都在这里面
#endif

    if (tunnelOn) {
      if (!helloSent) sendHello();
      if (millis() - lastHbAt >= HB_INTERVAL_MS) {
        lastHbAt = millis();
        sendHb();
      }
    } else if (lastTunnelOkAt && tunnelDownAt && millis() - tunnelDownAt > WS_DEAD_RESTART_MS) {
      // 断连超时：库里那套重连重试过一轮又一轮仍然连不上，说明 socket 表或
      // TLS 上下文已经进入残缺状态，这时候重启是唯一确定能恢复的动作。
      // 计时基准是「断线时刻」而不是「连通时刻」—— 用后者的话，连了一小时后
      // 一断就会被判成「已超时 45 秒」而立刻重启，白白丢掉刚稳定的连接。
      logf("[WS] 断线 %lus 未恢复，整机重启\n",
                    (unsigned long)((millis() - tunnelDownAt) / 1000));
      ESP.restart();
    } else if (!lastTunnelOkAt && millis() - bootAt > WS_BOOT_DEAD_RESTART_MS) {
      // ⚠️ 这里原来还有 `(timeSynced || !WS_TLS)` 这个条件，是个死锁：
      // 光猫重启那晚 NTP 一直失败 → timeSynced 永远 false → 这个分支永远不成立，
      // 而 onWifiOk() 又因为没对时成功而不启动 TLS → 既不连接也不重启，
      // C6 就这么卡了 3 小时 48 分（2026-11-01 实测：lastSeen 停在 uptime=20）。
      // 现在不管 NTP 成没成，超时就重启：重启会重走 DHCP + 重设 DNS，
      // 比在错误状态里等一个永远不来的条件强。
      logf("[WS] 开机 %lus 一次都没连上（NTP %s），整机重启\n",
                    (unsigned long)((millis() - bootAt) / 1000),
                    timeSynced ? "已对时" : "未对时");
      ESP.restart();
    }
  } else {
    // WiFi 掉线超过 60s 直接重启：lwIP 的 socket 表在这种状态下容易漏，
    // 重启比在残缺状态里打补丁可靠。
    wifiWasDown = true;
    if (lastWifiOkAt && millis() - lastWifiOkAt > 60000) {
      logf("[wifi] gone > 60s, restarting\n");
      ESP.restart();
    }
    delay(500);
  }
}

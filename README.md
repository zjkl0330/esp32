# esp32

> 一块 ESP32 = 家庭局域网的「守门人」：**远程唤醒电脑 + 内网穿透 + 住宅出口节点**，
> 全部经 Cloudflare Workers 中继，家里无需公网 IP、无需开端口、目标设备零依赖。

```
                          公网（Cloudflare Workers）                家庭局域网
  手机浏览器 ────┐
  命令行 / SDK ──┼── HTTPS/WSS ──▶ Durable Object 中继 ◀── wss(TLS) ── ESP32
  RDP / SSH ─────┘                  │  按需配对转发                       │
                                    │                                     ├─▶ 局域网任意 TCP 服务（RDP/SSH/路由器后台/NAS…）
                                    └─▶ WOL 帧 ──▶ UDP 广播 ──▶ 唤醒关机/睡眠的电脑
```

两个子项目，**共用同一套 Worker 代码、不同入口部署**：

| 子项目 | 域名（占位） | 干什么 |
|---|---|---|
| **WOL + 内网穿透** | `tunnel.example.com` | 一键唤醒电脑；把局域网任意 TCP 服务穿透到公网 |
| **住宅出口节点** | `exit.example.com` | 把 ESP32 变成「家庭 IP 的 HTTP 出口」，`GET/POST /api/fetch` 从家里宽带发起请求 |

## 仓库结构

```
firmware/             ESP32 固件（Arduino 框架）
  ESP32_WOL_Tunnel/     ★ 融合固件：WOL 定时/远程唤醒 + TCP 穿透隧道
  ESP32_C6_Exit/        ★ 住宅出口节点固件（HTTPS 抓取、OTA、看门狗）
  ESP32_WOL/            v1 纯 WOL 唤醒器（最小可运行）
worker/               Cloudflare Worker（一套代码，两份 wrangler 配置）
  src/                  Manager / Relay / panel / security / protocol
  wrangler.toml         → 部署为 WOL+穿透中继
  wrangler.exit.toml    → 部署为住宅出口
  fw-publish.mjs        固件 OTA 发布（推 KV，设备自检更新）
client/               本地客户端
  wol.mjs / tunnel.mjs  命令行发魔术包 / 本地端口→局域网穿透
  console/              ★ Web 控制台（状态总览 / 一键唤醒 / 隧道增删启停）
  send-wol.bat.example  Windows 双击唤醒模板
sdk/                  exit-fetch.mjs —— 住宅出口零依赖 Node SDK
test/                 14 个自写测试：端到端 / 安全面 / TLS 指纹探针 / 排障
tools/                串口脚本（抓日志 / 复位 / 自动验证穿透）
docs/                 文档（见下）
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/01-wol-tunnel.md`](docs/01-wol-tunnel.md) | WOL+穿透主文档：架构、部署、用法、验收 |
| [`docs/02-wol-pc-boot.md`](docs/02-wol-pc-boot.md) | 定时唤醒电脑落地手册（网卡武装/注册表/测试流程） |
| [`docs/03-esp32-project-list.md`](docs/03-esp32-project-list.md) | 这块板子还能刷什么（项目清单） |
| [`docs/05-tunnel-debug.md`](docs/05-tunnel-debug.md) | ★ 「数据只去不回」三个 bug 的排查复盘 |
| [`docs/exit/`](docs/exit/) | 住宅出口四篇设计文档 + 技术路线 |

## 硬件

| 板子 | 用途 | 说明 |
|---|---|---|
| ESP32-D0WD | WOL + 穿透 | CP210x 转串口；**必须独立供电**（笔记本 USB 会随睡眠断电） |
| ESP32-C6 N8 | 住宅出口 | 8MB Flash（OTA 需要），CH343 转串口 |

Arduino 依赖库：[WebSockets](https://github.com/Links2004/arduinoWebSockets) 2.7.2（链接版：2.x 分支）。

## 快速开始

### 1. 部署 Worker

```bash
cd worker && npm install
npx wrangler secret put TUNNEL_TOKEN     # 生成一个强随机串
npx wrangler deploy                      # wrangler.toml（WOL+穿透）
```

### 2. 烧固件

复制 `firmware/ESP32_WOL_Tunnel/ESP32_WOL_Tunnel.ino`，改顶部配置区：

```cpp
const char* WIFI_SSID    = "YOUR_WIFI_SSID";
const char* WIFI_PASS    = "YOUR_WIFI_PASSWORD";
const char* WORKER_HOST  = "tunnel.example.com";   // 你的 Worker 域名
const char* TUNNEL_TOKEN = "YOUR_TUNNEL_TOKEN";    // 与上面 secret 相同
uint8_t TARGET_MAC[6]    = {0xAA,0xBB,0xCC,0xDD,0xEE,0xFF}; // 目标电脑网卡 MAC
```

用 Arduino IDE 或 arduino-cli 烧录（esp32 core 3.x）。注意 `WORKER_PATH = "/ws/wol/esp32"` 固定格式。

### 3. 远程唤醒

```bash
curl "https://tunnel.example.com/wol/wol?token=YOUR_TUNNEL_TOKEN"
```

### 4. 穿透到局域网任意设备

```bash
# 本地端口 → 局域网 IP:端口，目标设备零依赖
CHANNEL_BASE=1 CHANNEL_COUNT=4 node client/tunnel.mjs 19080 192.168.1.1 80 wss://tunnel.example.com wol
# 浏览器打开 http://127.0.0.1:19080 —— 就是路由器后台
```

> ⚠️ **通道号是 ESP32 上的全局资源（共 8 条，可用 1~7）**。同时跑多个客户端
> 必须用 `CHANNEL_BASE` / `CHANNEL_COUNT` 划分不重叠区间，否则互相干扰。
> 这是实际踩过坑的：详见 [`docs/05-tunnel-debug.md`](docs/05-tunnel-debug.md)。

### 5. Web 控制台

```bash
TUNNEL_TOKEN=xxx node client/console/server.mjs
# 局域网内打开 http://<电脑IP>:8787/ —— 状态总览、一键唤醒、隧道增删启停
# 手机在外网：先用局域网保存一次 remote.html，之后经隧道自举直连（见 console/README.md）
```

## 测试

```bash
cd worker && npm i ws && npx tsc --noEmit   # 类型检查
node test/e2e.mjs                            # 端到端（Node 模拟中继 + TCP 回显）
node test/security.mjs                       # 安全面测试
TUNNEL_NAME=test node test/real-worker.mjs   # 打真实 Worker（独立 DO，不干扰线上）
TUNNEL_TOKEN=xx node test/probe-open.mjs 192.168.1.10 8080 1   # 单帧探测
```

## 实测验收

```
# 穿透连打 3 次（HTTP 服务）
2.1s / 3.2s / 3.2s，208 字节原样返回

# 两台设备并行穿透
路由器后台 192.168.1.1:80  → 2.3s / HTTP 200
笔记本 HTTP …:8080         → 3.8s / HTTP 200

# 远程唤醒
curl .../wol/wol → 200，串口可见 magic packet 广播
```

## 排障速查

| 现象 | 先查 |
|---|---|
| 帧到了板子但没反应 | 通道号是否 > 7（Bug 3，见复盘文档） |
| 接口说「已发送」板子却没收到 | DO 里是否有僵尸 ESP32 连接（Bug 1） |
| 拨号成功但响应回不来 | 靶机是否绑 0.0.0.0；固件是否「先读后判」 |
| 板子反复断连重连 | 是否启用了心跳；供电是否独立 |
| 串口打不开/乱码 | 打开串口会触发 DTR 复位；先清缓冲再读 |

## 本仓库已去敏

所有 WiFi 凭据、token、MAC、真实域名、账号 ID、KV id、内网 IP 均已替换为
`YOUR_*` / `*.example.*` 占位符。使用时全局搜索 `YOUR_` 即可找到所有需要填写的位置。

## License

MIT

# ESP32 WOL + 内网穿透（Cloudflare Workers 中继）

把家里那台笔记本的「Wake-on-LAN 定时唤醒」和「内网穿透」合成一套东西：
ESP32 常驻局域网，主动连公网 Workers，**公网能唤醒它、也能穿透到局域网任意 TCP 服务**。

参考来源：WorkBuddy 资料库《ESP32 + Cloudflare Workers 局域网穿透》（tunnel 帧协议与 DO 中继思路），
融合本地已有的 WOL 定时唤醒固件。

---

## v2：从「单向中继」升级成「可调度的住宅出口」

v2 在原有帧协议之上加了一个**控制面**：设备连上后自报身份与工具表，Worker 可以按节点
派发工具调用、看 heap/RSSI 曲线、看任务流水。原 5 个二进制帧一个都没动。

**已经跑在生产上**：`https://exit.example.com`（独立 Worker `esp32-exit`，与 v3 的
`tunnel.example.com` 完全隔离，互不影响）。

| 想看什么 | 去哪 |
|---|---|
| **立项、技术路线、功能清单、面板数据设计、生产实测** | [`docs/01-立项与控制面.md`](docs/01-立项与控制面.md) |
| **对外通道怎么用、三层密钥、SSRF 防护、部署步骤** | [`docs/02-对外通道与安全.md`](docs/02-对外通道与安全.md) |
| 为什么选这条路线（含被否掉的方案） | [`抖音出口-技术路线.md`](抖音出口-技术路线.md) |
| 控制面板 | <https://exit.example.com/admin>（口令 = `ADMIN_TOKEN`） |
| 本地联调面板 | `node test/lan-gateway.mjs` → <http://127.0.0.1:8790/admin?token=dev> |
| 部署 | `deploy-exit.bat`（带类型检查门禁） |

一句话：**ESP32 只负责「建 TLS + 搬运字节」，解析、调度、配额全在 Worker。**

### 门禁

```bash
cd worker && node ./node_modules/typescript/bin/tsc --noEmit   # 0 errors
cd .. && node test/security.mjs                                # 55 passed（SSRF/密钥/配额）
cd .. && node test/e2e.mjs                                     # 26 passed（逻辑，无需硬件）
cd .. && node test/panel-interact.mjs                          # 13 passed（真点按钮）
cd .. && ADMIN_TOKEN=xxx CLIENT_KEY=xxx node test/prod-verify.mjs   # 23 passed（线上，需真机）
```

---

## 一、架构

```
                        公网                                  家庭局域网
  手机浏览器 ──┐                    ┌──────────────┐
  命令行 ──────┼──HTTPS──▶  Cloudflare Workers 中继  ◀──wss── ESP32 ──TCP──▶ 笔记本:3389/22/80
  RDP/SSH ─────┘        (Durable Object，按 tunnel 配对)      │
                                                             └──UDP 广播──▶ 魔术包，唤醒关机/睡眠的笔记本

  手动发送 = GET /wol/<tunnel>          → 中继发 WOL 帧 → ESP32 广播魔术包
  全自动   = ESP32 自己的定时任务        → 到点发魔术包（不依赖公网）
```

两条路互不依赖：
- **公网不通**，ESP32 仍按本地时间定时唤醒（原 v2 能力完整保留）。
- **不想等定时**，手机打开操作页点一下，立刻发魔术包。

## 二、目录

```
F:/esp32/
├── arduino/ESP32_WOL_Tunnel/ESP32_WOL_Tunnel.ino   ① 融合固件（WOL + 隧道）
└── tunnel/                                         ② 中继与客户端
    ├── worker/               Cloudflare Workers（Durable Objects）
    │   ├── src/protocol.ts       隧道帧协议（与固件字节级一致）
    │   ├── src/Relay.ts          DO：配对 / 双向转发 / 手动 WOL / 手机操作页
    │   ├── src/index.ts          路由 /ws /wol /status /panel
    │   ├── wrangler.toml         DO 绑定
    │   └── tsconfig.json         tsc --noEmit 已通过
    ├── client/
    │   ├── wol.mjs               手动发送（命令行）
    │   └── tunnel.mjs            本地端口 → 隧道 → 局域网目标（RDP/SSH/Web）
    ├── test/
    │   ├── protocol.mjs          协议 JS 镜像
    │   ├── relay-node.mjs        Node 等价中继（本地验证用）
    │   ├── mock-esp32.mjs        模拟 ESP32
    │   └── e2e.mjs               端到端断言脚本
    └── send-wol.bat              双击即用：手动发送魔术包
```

## 三、帧协议（WS 上的二进制帧）

| 类型 | 方向 | 字节布局 |
|---|---|---|
| OPEN | 用户 → ESP32 | `0x01` + channel(1B) + ip(4B) + port(2B) |
| OPEN_OK | ESP32 → 用户 | `0x02` + channel(1B) |
| DATA | 双向 | `0x03` + channel(1B) + payload |
| CLOSE | 双向 | `0x04` + channel(1B) |
| WOL | 用户 → ESP32 | `0x05` + mac(6B) |

`WOL` 帧 MAC 全 0 = **用固件里的默认 MAC**（手机一键唤醒走这条）。

## 四、部署（✅ 2026-10-11 已完成）

### 实际部署结果

| 项 | 值 |
|---|---|
| Worker 名 | `esp32-wol-tunnel` |
| **公网地址** | **`https://tunnel.example.com`**（custom domain，**不要用 workers.dev**） |
| CF 账号 | `bai account` / `YOUR_CF_ACCOUNT_ID` |
| 版本 ID | `37371b34-c238-4033-863c-9244b613cdee` |
| ESP32 内网 IP | `192.168.1.91` |
| tunnel 名 | `wol` |

### ⚠️ 关键坑：workers.dev 在国内被 DNS 污染

`esp32-wol-tunnel.your-subdomain.workers.dev` 会被解析到 **Facebook 的 IP**
（`128.242.240.218` / IPv6 `2a03:2880:f11b:83:face:b00c:0:25de`）→ TCP 超时。
**ESP32 和浏览器都连不上。** 必须绑自定义域名（`wrangler.toml` 里的 `routes`）。

### ① 部署中继（已用 API Token 完成）

```bash
cd F:/esp32/tunnel/worker
npm install
CLOUDFLARE_API_TOKEN='cfat_***' CLOUDFLARE_ACCOUNT_ID='YOUR_ACCOUNT_ID...' \
  ./node_modules/.bin/wrangler deploy
```

> `wrangler login`（OAuth）在本机**调不起浏览器**，会 `Timed out waiting for authorization code`。
> **直接用 API Token + 环境变量**，别走 OAuth。
> Durable Object 用的是 `new_sqlite_classes`（SQLite-backed），**免费计划可用**；
> 若写成 `new_classes`（KV-backed）则需付费计划。

### ② 烧固件（已完成）

`arduino/ESP32_WOL_Tunnel/ESP32_WOL_Tunnel.ino` 顶部：

```cpp
const char* WORKER_HOST = "tunnel.example.com";
const char* WORKER_PATH = "/ws/wol/esp32";
const char* TUNNEL_TOKEN = "";        // 未设 secret，留空
```

```bash
cd F:/esp32
cmd //c upload.bat ESP32_WOL_Tunnel
```

串口应看到（实测）：
```
[DNS] tunnel.example.com -> 172.67.173.205
[heap] free=213392 largest=110580 (TLS 握手约需 40KB 连续)
[WS] connected to tunnel.example.com/ws/wol/esp32
```

### ③ 手动发送：实测通过（**已启用鉴权，必须带 token**）

```bash
B=https://tunnel.example.com
T=<TUNNEL_TOKEN>                       # 值见 send-wol.bat 或问维护者

curl "$B/status/wol?token=$T"          # → {"esp32":true,...}
curl "$B/wol/wol?token=$T"             # → "wol sent (default mac)"
curl -H "Authorization: Bearer $T" "$B/wol/wol"   # header 方式也行
```

不带 token 一律 `401`（已实测）。

ESP32 侧落地确认：
```
[WOL] magic packet #1 (remote) -> AA:BB:CC:DD:EE:FF via 192.168.1.255
```

### ④ 手机一键唤醒

浏览器打开（**必须带 token**）：

```
https://tunnel.example.com/panel/wol?token=<TUNNEL_TOKEN>
```

> 建议把带 token 的完整链接存成手机书签，省得每次输。

### ⑤ 鉴权机制说明

`Relay.ts` 的 `authorized()` 支持两种方式，二选一即可：

| 方式 | 写法 |
|---|---|
| Header（推荐给命令行） | `Authorization: Bearer <token>` |
| 查询参数（推荐给浏览器） | `?token=<token>` |

- **token 用 `wrangler secret put TUNNEL_TOKEN` 注入，不写在 `wrangler.toml` 里。**
- **鉴权只在建立连接时检查一次** —— 设完 secret 后，已建立的 WS 不会被踢；
  但 ESP32 一旦重连就会因无 token 被 401 拒绝，**所以固件必须同步带 token 重烧**。
- ⚠️ `send-wol.bat` 与固件 `.ino` 里含明文 token，**别外传、别传公开仓库**。

## 六、穿透到局域网任意设备（✅ 2026-10-15 实测打通）

```bash
# 通用形式
node client/tunnel.mjs <本地端口> <局域网IP> <目标端口> wss://tunnel.example.com wol

# 例：访问路由器的管理页
node client/tunnel.mjs 19081 192.168.1.1 80 wss://tunnel.example.com wol
# 然后浏览器打开 http://127.0.0.1:19081

# 例：访问另一台机器的远程桌面
node client/tunnel.mjs 13389 192.168.1.50 3389 wss://tunnel.example.com wol
# 然后远程桌面连 127.0.0.1:13389
```

**目标设备零依赖** —— 不用装任何东西，只要 ESP32 能路由到它就行（同一局域网/可达网段）。

### ⚠️ 通道号是全局资源，必须划分区间

ESP32 固件的 `MAX_CHANNELS = 8`（通道 0~7），**这是整个隧道共用的**。
同时跑多个 `tunnel.mjs` 进程时，如果各自都从 1 开始分配就会互相踩，
表现为「本地连上了、WS 也建了，但数据不回来」。

**用环境变量给每个进程划不重叠的区间**：

```bash
# 进程A：占通道 1-4
CHANNEL_BASE=1 CHANNEL_COUNT=4 node client/tunnel.mjs 19080 192.168.1.10 8080 wss://tunnel.example.com wol

# 进程B：占通道 5-7
CHANNEL_BASE=5 CHANNEL_COUNT=3 node client/tunnel.mjs 19081 192.168.1.1 80 wss://tunnel.example.com wol
```

> 历史上这里有第三个 bug：`channel` 曾写成 `1 + (seq++ % 254)`，超过 7 时
> 固件 `if (ch >= MAX_CHANNELS) return;` 会**静默丢弃** OPEN 帧，
> 现象就是「永远收不到 OPEN_OK」。现已限制在 1~7。

### 验收证据（2026-10-15 实测）

```
# 单目标连打 3 次
第1次: 2.1s, 208字节, 内容='TUNNEL-PROOF-2026-OK'
第2次: 3.2s, 208字节, 内容='TUNNEL-PROOF-2026-OK'
第3次: 3.2s, 208字节, 内容='TUNNEL-PROOF-2026-OK'

# 两台设备并行
路由器 192.168.1.1:80     → 2.3s / 4096 字节 / HTTP/1.1 200 OK
靶机   192.168.1.10:8080  → 3.8s /  208 字节 / HTTP/1.0 200 OK
```

### 排障工具

| 工具 | 用途 |
|---|---|
| `test/probe-open.mjs` | 单次 OPEN 探测，打印收到的每个帧<br>`TUNNEL_TOKEN=xx node test/probe-open.mjs <ip> <port> <channel>` |
| `tools/verify_tunnel.py` | 复位板子→等连上→触发 OPEN→同步抓串口（一次做完） |
| `GET /status/<tunnel>` | 含诊断字段 `esp32Count` / `esp32States` / `wsOpenConst` |

**排查时注意**：打开 COM3 会通过 DTR 触发 ESP32 复位，别在测试中途反复开关串口。

## 五、验证状态（真实执行）

| 项 | 结果 |
|---|---|
| Worker 类型检查 `tsc --noEmit` | ✅ exit 0 |
| 端到端 `node test/e2e.mjs` | ✅ **10 passed, 0 failed** |
| 固件编译 `arduino-cli compile` | ⏳ 待用户放行安全中心对工具链头文件的读取权限后执行 |

`e2e.mjs` 的断言（真实 WS 连接 + 真实 TCP 回显，不是空口）：

```
✓ 中继就绪 (/status/wol 返回 200)
✓ 模拟 ESP32 已连入中继，/status 显示在线
✓ 用户连接建立并收到 OPEN_OK
✓ 双向转发正确 (用户→ESP32→回显→用户)
✓ 多通道隔离正确 (ch11/ch12 互不串数据)
✓ 手动 WOL 送达 ESP32，MAC 一致 (AA:BB:CC:DD:EE:FF)
✓ 默认 MAC 手动 WOL 送达（全 0 帧，固件用 TARGET_MAC）
✓ 手机操作页 /panel/wol 返回可用 HTML（含一键唤醒按钮）
✓ ESP32 离线时手动 WOL 返回 503（不假装成功）
```

重跑：`cd F:/esp32/tunnel && node test/e2e.mjs`

## 六、已知边界

- **HTTP 穿透未做流式**：只实现了裸 TCP 隧道（RDP/SSH/Web 都能用）；需要 HTTP 反代时自己加一层。
- **单一 ESP32**：中继当前一个 tunnel 只挂一个 ESP32，多台需扩展成数组路由。
- **固件未上真机**：代码按 arduinoWebSockets 标准 API 写，首次烧录请确认串口出现 `[WS] connected` 与 `[tunnel] chX OPEN_OK`。
- **明文 ws 仅调试**：生产必须 `wss://`（固件已用 `beginSSL`）。
- 出站 WS 单帧上限 32 MiB（Cloudflare 限制），上行已按 256 字节分片。

## 七、安全建议

1. 设 `TUNNEL_TOKEN`，ESP32（已在固件里支持 `Authorization: Bearer`）与客户端都带上。
2. 中继只暴露 `wol` 这一个 tunnel，不要拿它当开放代理用。
3. `/wol` 接口暴露在公网 = 知道域名就能发魔术包。够用的话就加 token。

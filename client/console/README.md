# Web 控制台（console/）

把 **WOL 远程唤醒** 和 **TCP 内网穿透** 合成一个 Web 端。原生 HTML/CSS/JS，无构建工具；
Node 端只用内置模块 + 项目已有的 `ws`。

## 一、架构：本地控制台 + 浏览器自举

```
                    公网                              家里局域网
 手机浏览器 ──┬─ 存一份 remote.html（一次）        ┌─ wss(帧协议) ─┐
             └─ 每次请求开 user WS ────────────────▶ Cloudflare Worker ◀──wss── ESP32
                                                (帧中继，按 channel 配对)      │拨号
                                                                              ▼
                                        console/server.mjs :8787 ◀──TCP── 控制台所在 PC
                                          ├─ 静态 UI（index.html）
                                          ├─ REST API（/api/*）
                                          ├─ TunnelManager：本地端口 → 隧道 → 局域网目标
                                          └─ 代理 Worker 的 /status /wol（带 token）
```

- **为什么是本地服务（A）**：「管理本地端口映射」必须有个本地进程持有，机器不在家里就没法映射。
- **为什么手机外网也能用（B）**：控制台自己也在局域网内，手机浏览器直接以 `user` 身份开 WS，
  `OPEN(控制台局域网IP, 端口)` 让 ESP32 拨到控制台 PC，再把 HTTP 报文塞进 DATA 帧。
  连接器**不依赖任何公网静态托管**——把 `remote.html` 存到手机一次即可（自举）。

| 能力 | 局域网 `http://<ip>:8787/` | 外网（手机存 `remote.html`） |
|---|---|---|
| 状态总览 | ✅ | ✅ |
| WOL 唤醒 | ✅ | ✅ |
| 隧道管理 | ✅ | ✅ |

## 二、运行

```bash
cd F:/esp32/tunnel
node console/server.mjs
```

打开 `http://localhost:8787/`。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `CONSOLE_PORT` | `8787` | 本地监听端口（绑 `0.0.0.0`） |
| `WORKER_BASE` | `https://tunnel.example.com` | Worker 公网地址 |
| `TUNNEL_NAME` | `wol` | 隧道名 |
| `TUNNEL_TOKEN` | 空 | Worker 鉴权 token（**只在服务端用，不下发前端**） |
| `CONSOLE_TOKEN` | 空 | 可选：给控制台自己的 API 加鉴权（外网必开） |
| `CONSOLE_STATE` | `console/tunnels.json` | 映射定义的持久化文件 |

Windows Git Bash 例：

```bash
TUNNEL_TOKEN=xxxx CONSOLE_TOKEN=yyyy node console/server.mjs
```

> 若没设 `TUNNEL_TOKEN`，页面「设置」里也能填（只存内存/浏览器，不落盘）。

## 三、手机在外网使用

1. 在**家里**同一局域网，用手机浏览器打开 `http://<电脑局域网IP>:8787/remote.html`。
   （**别用 localhost** —— 页面会把 Host 头里的地址记为控制台地址。）
2. 浏览器菜单里「保存网页 / 添加到主屏幕」，存到手机。
3. 之后在外网打开它 → 设置里填 **Worker token**（和可选的 **控制台 token**）→ 保存。
4. 完成。页面通过隧道直连控制台，功能与局域网一致。

## 四、API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | `{workerBase,tunnel,authRequired,hasWorkerToken}`（**不含 token 值**） |
| POST | `/api/session` | `{workerToken}`，仅存内存 |
| GET | `/api/status` | 代理 Worker `/status/<t>` |
| POST | `/api/wol` | `{mac?}` → 代理 Worker `/wol/<t>[/mac]` |
| GET | `/api/tunnels` | 映射列表 + 状态/连接数/上下行字节 |
| POST | `/api/tunnels` | `{name,localPort,targetHost,targetPort,start}` |
| POST | `/api/tunnels/:id/start` · `/stop` | 启停 |
| PATCH | `/api/tunnels/:id` | 改地址（运行中会先停再起） |
| DELETE | `/api/tunnels/:id` | 删除 |

对 Worker 的请求由服务端带 `TUNNEL_TOKEN`（`Bearer`）。控制台自身 API 若设了
`CONSOLE_TOKEN`，需带 `Authorization: Bearer` 或 `?token=`。

## 五、文件

| 文件 | 作用 |
|---|---|
| `server.mjs` | HTTP 服务 + 路由 + config 注入 + 鉴权 |
| `tunnel-manager.mjs` | 隧道引擎（`net` + `ws`），逐连接状态与字节统计，持久化 |
| `worker-api.mjs` | 代理 Worker `/status` `/wol` |
| `public/index.html` | 单文件 UI，双传输（fetch / 帧隧道），中文响应式 |
| `smoke.mjs` | 本地冒烟测试（Node 中继 + 模拟 ESP32 + 回显） |

## 六、自测

```bash
node console/smoke.mjs     # 14 passed, 0 failed（含远程帧隧道路径）
```

## 七、已知边界

- **帧隧道延迟**：外网每次 API 调用都要新开 WS + ESP32 拨号，约 0.5–2s；故外网模式默认 20s 刷新（局域网 5s）。
- **单 ESP32**：一个 tunnel 只挂一个 ESP32（与中继现状一致）。
- **默认只监听 127.0.0.1**：映射的本地端口默认绑 `127.0.0.1`，同机才可用；要局域网共用请改进 `bind` 字段。
- `tunnels.json` 与浏览器 localStorage 里会存映射/ token，别外传。
- **未改** `worker/src/Relay.ts` 的 `panelHtml()`（线上在用）。若后续要统一入口，建议：`panelHtml` 只留「一键唤醒」，其余跳到本控制台；并把写死的默认 MAC 抽成 DO 存储值。

# chat2api × Cloudflare Workers × ESP32 住宅出口

> 完整设计 v1 · 状态：设计稿（未写代码）
>
> 目标：在 Workers 上提供 OpenAI 兼容的基础聊天（SSE），上游接「网页账号 Cookie/Token」与「Our Free Model 免费池」。
> 硬约束：家里只有 ESP32-C6，没有 7×24 常驻主机。

---

## 0. 结论（先看这一页）

### 0.1 能交付什么、不能交付什么

| 能力 | v1 结论 | 原因 |
|---|---|---|
| Kilo 免费池聊天（SSE） | **可以做，且是 v1 的主路径** | 公开网关、无需账号、Workers 可直接 fetch |
| 网页账号文本聊天 | **有条件做**，只放行探针通过的少数站点 | ESP32 的 TLS 指纹/HTTP1.1/16KB/128KB 限制 |
| **千问网页版（Qwen）** | **✅ 可实现，代码已接入** | `/api/models` 公开可探，对话是 OpenAI 兼容 SSE，只需网页 token |
| **DeepSeek 网页版** | **✅ 可实现，需 token + PoW** | Huawei WAF 不是 Cloudflare；PoW 是 SHA3，可在 Worker 用 26KB WASM 求解 |
| **豆包网页版** | **✅ 可实现，需 sessionid** | openresty，不是 Cloudflare；`/samantha/chat/completion` 可直接调 |
| ChatGPT / Claude / Gemini 网页版 | **默认不做**，先探针再决定 | Cloudflare/Google 风控 + mbedTLS JA3，高风险 |
| 多轮长上下文 | **受限**，单次请求体 ≤16KB | ESP32 请求体要塞进固件内存 |
| 图片生成 | **v1 不做** | 响应经常 >256KB，且多为 b64/大文件 |
| 视频生成 | **v1 不做** | 分钟级任务 + 大文件，ESP32 链路不成立 |
| docx 生成 | 可做，但排在 v1 之后 | 纯 Worker 能力，不需要住宅出口 |
| 并发聊天 | **不支持**，设备 capacity=1 | 硬件单核单连接 |
| 7×24 稳定 | **不承诺** | 家里断电/断网/路由器重启都会断 |

### 0.2 v1 的承诺

v1 只承诺三件事：

1. `POST /v1/chat/completions` 支持 `stream:true/false`，OpenAI SDK 可直接用。
2. 免费池通道（Kilo）稳定可用，不依赖 ESP32。
3. 网页账号通道在「探针通过 + 证书校验通过」后，支持**单账号、单设备、短上下文**的文本聊天。

不承诺的部分不写成“以后再说”，而是在第 14 节写成明确的止损条件。

### 0.3 三个必须先过的门禁

| 门禁 | 问题 | 不过怎么办 |
|---|---|---|
| **G0 指纹门禁** | 目标站点是否接受 mbedTLS/HTTP1.1 的请求 | 该站点永久移出网页账号通道 |
| **G1 证书门禁** | ESP32 能否校验目标证书 | 不许发送任何 Cookie/Token，网页通道关闭 |
| **G2 流式门禁** | ESP32 能否连续 60~120 秒流式回传而不掉线 | 网页通道只支持非流式短回答，或关闭 |

这三个门禁不过，代码写得再完整也不上线。

---

## 1. 现状（已核实，不是推测）

### 1.1 现有 `esp32` 仓库

`827802685/esp32` 是私有仓库，`main` 分支，语言 JavaScript，2026-11-01 更新。仓库不是空壳，已有两套链路：

| 子系统 | 硬件 | 域名（占位） | 状态 |
|---|---|---|---|
| WOL + 内网穿透 | ESP32-D0WD | `tunnel.example.com` | Worker + DO + 固件 + 控制台，已实测 |
| 住宅出口 | ESP32-C6 N8 | `exit.example.com` | 已上线，真机 wss 验收通过 |

与本次设计直接相关的是**住宅出口**：

- Worker：`esp32-exit`，独立于 WOL 隧道 Worker。
- Durable Object：`Manager`（节点表/配额/任务）+ `Relay`（设备 WS 配对/字节转发）。
- 对外 API：`GET/POST /api/fetch`、`GET /api/me`。
- 安全：三层密钥（`TUNNEL_TOKEN` / `ADMIN_TOKEN` / `CLIENT_KEYS`）、fail-closed、每 key 独立配额、SSRF 防护、面板密钥管理。
- SDK：`sdk/exit-fetch.mjs`，零依赖。
- 固件：`firmware/ESP32_C6_Exit/ESP32_C6_Exit.ino`，工具 `https_fetch` / `http_get` / `net_info` / `dns_lookup` / `wol`。

### 1.2 住宅出口的硬上限（文档实测）

| 项 | 实测值 | 对聊天的含义 |
|---|---|---|
| 请求体 | ≤16KB | 上下文只能装 2~4 轮短对话 |
| 单次响应 | 默认 128KB，最大 256KB | 短回答够，长回答/图片不够 |
| 并发 | 1（单核单连接，排队） | 两个人同时聊会 429 |
| 单次耗时 | 1~12 秒（不含模型生成） | 首字慢；长生成会撞固件预算 |
| 固件单次预算 | 15 秒（文档写明） | 必须为流式放宽到 120 秒 |
| 压缩 | 不支持 gzip，强制 `Accept-Encoding: identity` | 少数站点会返回乱码 |
| TLS | mbedTLS，HTTP/1.1，无 ALPN | JA3/JA4 一眼不是浏览器 |
| 证书 | 设备→目标 `setInsecure()`，不校验 | **绝不能带 Cookie 使用** |

仓库的 `docs/exit/04-接出给其他项目.md` 已经给出相同结论：要浏览器 TLS 指纹和大文件，就把出口换成家中那台机器；ESP32 只当哑管道。

### 1.3 `Our Free Model` 是什么

`Our Free Model` 是第三方项目（`Ebony-Vinyl/dsh-our-free-model`，以及 `mu-zi-lee/magpie-our-free-model` 适配版），不是本账号下的仓库。它的关键事实：

- 形态是 **dsh/Magpie 本地插件**，零依赖，需要本地 Node/Bun 运行，自带本地控制台。
- 免费车道是 **OpenCode Zen 网关**：`https://opencode.ai/inference/...`，需要大量“客户端指纹整形”（session 头、project id、工具表、官方 system prompt、UA）。
- 另一条是 **Kilo 公共网关**：`https://api.kilo.ai/api/gateway`，OpenAI 兼容，免费池无需任何 key/登录。
- 它自身已经有一个 **Cloudflare Worker 版 EAC 网关**（`ofm/worker/worker.js`），但那是“验签后转发到需要真 key 的中继”，不是免费车道，不能直接当免费上游用。

**结论：不要把 Our Free Model 整个插件搬进 Worker。** v1 只复刻它最简单的一条：Kilo 免费池。OpenCode 车道放到 v2，先做可行性门禁。

### 1.4 仓库里缺什么

- 没有 chat2api 代码，也没有 `/v1/chat/completions`、SSE、OpenAI schema。
- 没有 R2、没有异步任务、没有图片/视频链路。
- 没有针对目标站点的证书校验（只有设备→Worker 的 wss 校验）。
- 没有流式转发：Relay 现在把 DATA 块收集完再 base64 返回。

---

## 2. 设计目标与非目标

### 2.1 目标

1. OpenAI 兼容：`/v1/models`、`/v1/chat/completions`（stream / non-stream）。
2. 两条上游通道：
   - `kilo/*`：Worker 直接调 Kilo 免费池。
   - `web/*`：经现有 ESP32 住宅出口调网页账号。
3. 单设备、单账号、短上下文下可用。
4. 密钥、配额、审计、错误码全部显式，不静默失败。
5. 不破坏现有 WOL/穿透/住宅出口链路。

### 2.2 非目标（v1）

- 不做通用代理/翻墙。
- 不做多设备调度（Manager 已有多节点字段，但 v1 只承诺单设备）。
- 不做图片、视频、docx（第 15 节给后续路径）。
- 不做 function calling / tools / vision / audio。
- 不做服务端会话记忆（v1 由客户端每次带 `messages`）。
- 不追求“像浏览器一样”的 TLS 指纹（硬件决定）。

---

## 3. 总体架构

```
┌──────────────────────┐
│ 客户端 / OpenAI SDK  │
└──────────┬───────────┘
           │ HTTPS  /v1/chat/completions（SSE）
           ▼
┌─────────────────────────────────────────────────────────────┐
│ chat2api Worker（新，独立部署）                              │
│  · OpenAI schema / SSE                                       │
│  · 模型路由：kilo/* | web/*                                 │
│  · key 鉴权 / 配额 / 审计                                    │
│  · D1：keys / usage / web_accounts                           │
│  · KV：模型清单缓存                                          │
└───────┬───────────────────────────────┬─────────────────────┘
        │ 通道 K：原生 fetch            │ 通道 W：service binding
        ▼                               ▼
┌──────────────────┐          ┌──────────────────────────────┐
│ Kilo 公共网关     │          │ esp32-exit Worker（现有）     │
│ api.kilo.ai      │          │  · /internal/stream（新）     │
│ 免费池，无 key    │          │  · Manager DO（选节点/配额）  │
└──────────────────┘          │  · Relay DO（WS 配对/流式）   │
                              └──────────────┬───────────────┘
                                             │ wss（ESP32 主动外连）
                                             ▼
                              ┌──────────────────────────────┐
                              │ ESP32-C6（家里）              │
                              │  https_fetch_stream（新）     │
                              │  证书校验 + 域名白名单（新）   │
                              └──────────────┬───────────────┘
                                             │ TLS（mbedTLS）
                                             ▼
                              ┌──────────────────────────────┐
                              │ 网页聊天服务（仅白名单站点）   │
                              └──────────────────────────────┘
```

关键决策：

| 决策 | 选择 | 否掉的做法 | 理由 |
|---|---|---|---|
| 是否复用 exit Worker | **新建 `chat2api` Worker** | 把 `/v1` 塞进 exit | 两套鉴权/配额/发布节奏；exit 是安全敏感小接口 |
| 如何调用 exit | **service binding + 内部密钥** | 走公网 `/api/fetch` | 公网路径缓冲、无流式、多一跳 |
| 流式在哪做 | **chat Worker 里做 SSE 变换** | 让 ESP32 直接吐 OpenAI SSE | ESP32 只搬字节，业务逻辑留在 Worker |
| 免费池怎么接 | **Worker 直接 fetch Kilo** | 在 Worker 里跑 OFM 插件 | 插件依赖 Node/Bun/fs/本地控制台，Workers 跑不了 |
| 网页账号怎么接 | **经 ESP32 出口** | Worker 直接 fetch | Worker 出口是机房 IP，住宅属性丢失 |
| 会话状态 | **v1 无状态** | 服务端存全部消息 | 16KB 与隐私成本；先让客户端带 `messages` |

---

## 4. 上游通道设计

### 4.1 通道 K：Kilo 免费池（v1 必做）

- Base：`https://api.kilo.ai/api/gateway`
- 模型清单：`GET /models`，过滤 `isFree: true`，保留 `kilo-auto/free` 等。
- 对话：`POST /chat/completions`，OpenAI 兼容，SSE。
- 鉴权：无（免费池）；付费 id 会 401，必须过滤。
- 传输：Worker 原生 `fetch`，**不经过 ESP32**。
- 超时：首字节 60s，总 300s，空闲 30s。
- 隐私：Kilo 免费池可能记录 prompt 用于改进服务；禁止发送密钥、身份证、公司机密。
- 失败：429 透传 `Retry-After`；5xx 重试 1 次（仅未收到首字节时）；仍失败返回 502。

这一条是 v1 的“保底可用路径”。即使网页账号通道全部失败，聊天仍可用。

### 4.2 通道 W：网页账号（v1 有条件）

#### 4.2.1 适用边界

- 单账号、单设备、串行请求。
- 只支持文本，不支持图片/文件/语音。
- 请求体 JSON ≤16KB（含 system prompt 与历史）。
- 响应 ≤256KB；超出标记 `truncated` 并终止。
- 只支持探针通过的站点；未通过的一律 404 `model_not_found`。

#### 4.2.2 Provider 适配器

每个站点一个模块，统一接口：

```ts
export interface WebProvider {
  id: string;                     // chatgpt / claude / deepseek / kimi ...
  host: string;                   // 目标域名（固件白名单也要有）
  ca: 'gts_r4' | 'isrg_x1' | 'digicert_g2' | 'amazon_ca1';
  models: string[];               // 公开模型别名
  build(req: ChatRequest, account: WebAccount): {
    path: string;                 // /backend-api/conversation
    headers: Record<string, string>;
    body: string;                 // ≤16KB
  };
  parse(bytes: ReadableStream): AsyncIterable<Delta>;
}
```

适配器只做三件事：拼请求、解析流、映射错误。**不做重试、不做会话记忆、不做多账号轮询。**

#### 4.2.3 证书与 Cookie 的顺序（硬规则）

```
没有证书校验 → 不允许带 Cookie/Token → 该站点不允许进入 web 通道
```

原因：设备到目标这一段是 `setInsecure()`。运营商/路由器/同 WiFi 设备理论上可以中间人。抓公开网页可以接受，带登录态绝对不行。

#### 4.2.4 探针门禁 G0

对每个候选站点，用真实浏览器 DevTools 复制一份请求（URL/method/headers/body，Cookie 脱敏后存 fixture），通过现有 exit `/api/fetch` 发一次：

| 观察 | 判定 |
|---|---|
| HTTP 200 + `text/event-stream` | 通过 |
| HTTP 200 但返回挑战页/HTML | 失败（风控） |
| 401/403 | 失败（鉴权或指纹） |
| 429 | 限流，需单独评估 |
| 证书错误/超时 | 失败（G1/网络） |

探针结果写入 `docs/chat/provider-matrix.md`，作为“哪些站点能开”的唯一依据。

**默认预期**：Kilo 通过；ChatGPT / Claude / Gemini 网页版高风险；国内部分站点（DeepSeek/Kimi/Qwen 等）需逐个实测，不能预先承诺。

### 4.2.5 千问 / DeepSeek 的实测结论（2026-11-03）

这两家和 ChatGPT 不是同一难度：

**千问（Qwen）**

- `https://chat.qwen.ai/api/models` 实测 **200 + JSON**，不需要登录。
- 对话端点 `/api/chat/completions` 是 **OpenAI 兼容 SSE**，只需要 `Authorization: Bearer <网页 token>`。
- 已有第三方 Cloudflare Worker 版本（`aigem/qwen-free-api-worker`）证明 CF 出口可用。
- 结论：**可以做**。已接入 `web/qwen/<model>`，代码见 `chat-worker/src/providers/qwen.ts`；只差一个 `QWEN_TOKEN` 做真实联调。
- 如果 Alibaba WAF 对 mbedTLS 不友好，可先用 Worker 直连（CF IP），再切 ESP32 住宅出口。

**DeepSeek**

- `https://chat.deepseek.com/api/v0/chat/create_pow_challenge` 实测可达；无 token 返回 `{"code":40002,"msg":"Missing Token"}`，**不是 Cloudflare 挑战**。
- 服务端是 Huawei WAF（`server: CW`、`HWWAFSESID`），HTTP/1.1 可用。
- 对话流程：`chat_session/create` → `create_pow_challenge` → 解 SHA3 PoW → `chat/completion`。
- PoW 是 SHA3-256 难度搜索；仓库自带 26KB WASM 求解器（`sha3_wasm_bg.wasm`），可直接打进 Worker。
- 结论：**已接入** `web/deepseek/<model>`（`deepseek-default` / `deepseek-reasoner` / `deepseek-expert` / `deepseek-vision`）。PoW 使用 26KB WASM，单元测试与参考解 `58033` 一致；只差 `DEEPSEEK_TOKEN` 做真实联调。

**ChatGPT** 仍然是 Cloudflare + sentinel + PoW + Turnstile + `curl_cffi` 指纹，和上面两家不在一个量级。

### 4.2.6 豆包（Doubao）

- `www.doubao.com` 是 openresty，不是 Cloudflare；`/api/` 无鉴权返回 401，说明是可直连的普通 HTTP。
- 聊天端点：`POST /samantha/chat/completion`，Cookie `sessionid` + `sessionid_ss`，请求体是 `messages` + `completion_option`。
- `a_bogus` / `msToken` 在参考实现里是**伪值**；聊天端点不强制真签名。
- 结论：**已接入** `web/doubao/doubao`；只差 `DOUBAO_SESSIONID` 真实联调。

### 4.2.7 客户端登录流程（不是控制面板）

DeepSeek 短信登录已接入：

```
POST /v1/auth/deepseek/sms/send    { mobile, areaCode?, captcha? }
  → { deviceId, sendWindowSecs }

POST /v1/auth/deepseek/sms/verify  { mobile, code, deviceId }
  → 存 token 到加密账号池，返回 account
```

- 端点：`/api/v0/users/create_sms_verification_code` → `/api/v0/users/login_by_mobile_sms`。
- 验证码发送需要 `turnstile_token` / `shumei_verification` / `hcaptcha_token` 之一；Worker 不生成验证码，客户端必须把浏览器拿到的 captcha 字段传进来。
- 登录成功后 token + `Set-Cookie` 用 `COOKIE_ENC_KEY` 加密存 D1，后续 `web/deepseek/*` 自动选账号，不需要再配 `DEEPSEEK_TOKEN`。
- 聊天时会带上登录 Cookie，并在单次请求内继续吸收 `Set-Cookie`。
- **千问 qwen.ai 没有手机号登录**：网页端只支持 Google / Apple / email / GitHub。
- 千问中国版已跳到 `www.qianwen.com/qianwen/`，聊天 API 是 `api.qianwen.com/api/v2/chat`，登录态 Cookie 是 `login_aliyunid` / `login_tongyi_ticket`。
- 中国版手机号登录走 Alibaba passport：
  - `/havanaone/loginLegacy/sms/sendSms.do`
  - `/havanaone/loginLegacy/sms/login.do`
  - 但页面强制 baxia / NoCaptcha，纯 Worker HTTP 过不去；需要 Browser Rendering 或浏览器登录后导入 Cookie。
- **豆包手机号登录已接**：见 4.2.10；保存 `sessionid` + 完整 Cookie。

### 4.2.8 智谱清言（GLM）

- 站点是 Tengine + Alibaba WAF，不是 Cloudflare。
- 聊天端点：`POST /chatglm/backend-api/assistant/stream`，SSE；请求头需要 `X-Sign` / `X-Timestamp` / `X-Nonce`。
- 签名算法来自参考实现：`md5(timestamp + "-" + nonce + "-" + secret)`，secret 默认 `8a1317a7468aa3ad86e997d08f3f31cb`，可用 `GLM_SIGN_SECRET` 覆盖。
- 已接入 `web/glm/glm` / `web/glm/glm-think`；只差 `GLM_TOKEN` 真实联调。
- 注意：官网改签名算法后需要更新 secret/算法，否则会 401。

### 4.2.9 ChatGPT 网页版（按 chat2api 复刻）

- 直接对照 `chat2api/chatgpt/ChatService.py`、`proofofWork.py`、`chatFormat.py` 移植。
- 链路：拉 `chatgpt.com` 首页 → 取 script/dpl → 生成 config → `gAAAAAC` requirements token → `/backend-api/sentinel/chat-requirements` → 按需解 `gAAAAAB` PoW → `/backend-api/conversation` SSE → OpenAI SSE。
- PoW 是 SHA3-512；固定向量与 Python 参考实现一致（`seed=0.123456`, `diff=0fffff`, `i=15`）。
- 模型：`web/chatgpt/gpt-4o`、`gpt-4o-mini`、`gpt-4`、`o3`、`o1`、`gpt-3.5-turbo`。
- `cf_chl_opt` 会明确返回 `provider_blocked`，不伪装成功。
- turnstile/arkose 需要时，可配 `CHATGPT_TURNSTILE_SOLVER_URL` / `CHATGPT_ARKOSE_TOKEN_URL`；不配则 403。
- 真实联调需要 `CHATGPT_ACCESS_TOKEN` + ESP32 出口。

### 4.2.10 豆包短信登录（ByteDance passport）

- 从 `accounts.doubao.com` 的 SSO 代码里确认端点：
  - `POST /passport/web/send_code/`
  - `POST /passport/web/sms_login/`
- 请求参数：
  - send：`{aid, mobile, type:24, is6Digits:1, verify_ticket}`
  - login：`{aid, mobile, code, service, safe_mobile_register_to_login:false}`
- 默认 `aid=497858`、`service=https://www.doubao.com`，可用 `DOUBAO_AID` / `DOUBAO_SERVICE` 覆盖。
- 登录成功后保存 `sessionid` + 完整 `Set-Cookie`；`web/doubao/*` 会带上。
- 扫码接口已找到（`/passport/web/get_qrcode/`、`/check_qrconnect/`），但还没接。
- 如果 passport 要求 captcha，需要把 `verify_ticket` 传进来。

### 4.3 通道 O：OpenCode / Our Free Model（v2，默认关闭）

为什么不进 v1：

- OpenCode 免费车道要求 **x-opencode-session-id / x-opencode-session / x-opencode-project**、工具指纹（`read`/`shell` 等）、官方 system prompt、特定 UA。
- 它还有 **session 真实时间戳**、**按 project × egress 配额**、**区域门禁**。
- 插件用 Bun 子进程承担这条车道的传输；Workers 没有子进程/文件系统。
- 2026-10 的验证记录里出现过 `403 LANE_LOCKED`，可用性本身有波动。

v2 做法：

1. 把 `ofm/src/o2a/` 的整形逻辑（8 个模块 + 官方资产）移植成 TS。
2. session/project 映射存 KV（按 conversation）。
3. 端点用 `/inference/openai/v1/chat/completions`（v2 分组）。
4. 先跑门禁：Cloudflare 出口的 TLS 是否被接受；不通过就永久关闭。
5. 与 OFM 上游版本绑定，定期探针；失败 fail-closed。

如果用户手里有 OFM 的 EAC 中继凭据，可另开 `eac/*` 通道，复用 OFM 的 HMAC Worker 模式；这属于“有凭据才启用”，不在 v1。

### 4.4 通道对比

| | K | W | O |
|---|---|---|---|
| 名称 | Kilo 免费池 | 网页账号 | OpenCode |
| 依赖 ESP32 | 否 | 是 | 否 |
| 住宅 IP | 否 | 是 | 否 |
| 需要 Cookie | 否 | 是 | 否 |
| 流式 | 是 | 是（新协议） | 是 |
| 上下文上限 | Worker 限制（1MB） | 16KB | Worker 限制 |
| 并发 | 受上游限制 | 1 | 受上游限制 |
| v1 状态 | **必做** | **门禁后做** | 关闭 |

---

## 5. Worker API

### 5.1 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/v1/models` | 聚合可用模型 |
| POST | `/v1/chat/completions` | 聊天（stream/non-stream） |
| GET | `/api/me` | 当前 key 的配额与用量 |
| GET | `/health` | 只回 `{"ok":true}` |
| GET/POST/DELETE | `/admin/api/keys` | 管理下游 key（Bearer 管理员） |
| GET/POST/DELETE | `/admin/api/accounts` | 管理网页账号（Cookie 加密） |
| GET | `/admin/api/status` | 通道/设备/额度状态 |

### 5.2 模型命名

| 前缀 | 示例 | 路由 |
|---|---|---|
| `kilo/` | `kilo/kilo-auto/free` | 通道 K |
| `web/` | `web/deepseek/default` | 通道 W |
| `ofm/` | `ofm/deepseek-v4.1-flash-free` | 通道 O（v2） |

`/v1/models` 返回的对象：

```json
{
  "object": "list",
  "data": [
    {
      "id": "kilo/kilo-auto/free",
      "object": "model",
      "owned_by": "kilo",
      "created": 0
    }
  ]
}
```

- Kilo 清单每 10 分钟刷新一次，缓存在 KV；上游失败时用旧缓存。
- `web/*` 只列配置且探针通过的模型。
- 未知模型：HTTP 404，`error.code = "model_not_found"`。

### 5.3 请求

只接受以下字段（其余忽略或 400）：

```json
{
  "model": "kilo/kilo-auto/free",
  "messages": [
    { "role": "system", "content": "你是助手" },
    { "role": "user", "content": "你好" }
  ],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 1024,
  "stop": ["\n\n"]
}
```

限制：

| 项 | 值 | 说明 |
|---|---|---|
| `messages` 总体积 | K：1MB；W：16KB | W 含 JSON 序列化后的 UTF-8 字节 |
| `max_tokens` | 默认 1024，最大 4096 | W 通道建议 ≤2048，避免撞 256KB |
| `tools` / `functions` | 400 `unsupported_parameter` | v1 不支持 |
| `n` | 只允许 1 | |
| 图片/多模态 `content` | 400 | v1 不支持 |

W 通道超限返回：

```json
{
  "error": {
    "message": "web channel context exceeds 16KB; trim messages or use kilo/*",
    "type": "invalid_request_error",
    "code": "context_too_large"
  }
}
```

### 5.4 非流式响应

标准 `chat.completion` 对象；`usage` 上游有就带，没有就省略（不伪造）。

### 5.5 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | `invalid_request` | JSON/schema 错误 |
| 400 | `unsupported_parameter` | tools/多模态/n>1 |
| 404 | `model_not_found` | 模型未配置/未通过门禁 |
| 401 | `invalid_api_key` | key 不存在或已吊销 |
| 403 | `provider_blocked` | 站点被风控/未通过门禁 |
| 403 | `tls_verify_required` | 网页通道未启用证书校验 |
| 413 | `context_too_large` | W 通道超 16KB |
| 429 | `quota_exceeded` | 日配额 |
| 429 | `device_busy` | ESP32 正在处理另一个请求 |
| 429 | `upstream_rate_limited` | 上游 429，带 Retry-After |
| 502 | `upstream_error` | 上游 5xx/协议错误 |
| 502 | `upstream_truncated` | 响应撞 256KB |
| 503 | `device_offline` | ESP32 不在线 |
| 504 | `upstream_timeout` | 首字节/总时长超时 |

流中错误：先发一帧 `data: {"error":{...}}`，再 `data: [DONE]`，然后关闭。客户端必须能处理流内错误。

---

## 6. 流式链路（核心）

### 6.1 时序

```
Client          chat Worker              exit Worker            Relay DO              ESP32             Provider
  │ POST stream      │                       │                     │                    │                  │
  ├─────────────────►│                       │                     │                    │                  │
  │                  │ 选通道/配额/模型        │                     │                    │                  │
  │                  │ service binding        │                     │                    │                  │
  │                  ├──────────────────────►│ 鉴权 x-internal-key  │                    │                  │
  │                  │                       ├────────────────────►│ 选节点/占 channel   │                  │
  │                  │                       │                     ├──── call(stream) ─►│                  │
  │                  │                       │                     │                    ├─ TLS 握手 ──────►│
  │                  │                       │                     │◄── head(status) ────┤                  │
  │                  │◄──── headers ─────────┤◄──── Response ──────┤                    │                  │
  │◄── 200 SSE ──────┤                       │                     │◄── DATA × N ────────┤◄── SSE 字节 ────┤
  │                  │ 解析/映射/写 SSE       │                     │                    │                  │
  │◄── data: chunk ──┤                       │                     │◄── result ──────────┤                  │
  │◄── [DONE] ───────┤                       │                     │                    │                  │
```

### 6.2 协议扩展（在现有 binary + JSON 控制帧上加）

现有帧保持不变：`OPEN 0x01 / OPEN_OK 0x02 / DATA 0x03 / CLOSE 0x04 / WOL 0x05`。
控制帧 `hello / hb / call / result` 保持不变，新增：

| 消息 | 方向 | 载荷 |
|---|---|---|
| `call`（扩展） | Worker → 设备 | `id / tool / args / ch / stream:true / totalMs / idleMs` |
| `head` | 设备 → Worker | `{t:"head", id, status, ctype, headers?, truncated?}` |
| `cancel` | Worker → 设备 | `{t:"cancel", id}` |
| `result`（扩展） | 设备 → Worker | `{id, ok, err?, meta:{status,bytes,ms,truncated,redirects,ctype}}` |

约定：

- `head` 在拿到目标响应头后立即发，不等 body。
- `head` 之后，body 一律走该 `ch` 的 DATA 帧，直到 `result`。
- `ch` 仍从 192~255 分配；capacity=1 时同一时刻只有一个调用。
- `result` 的 `meta.bytes` 与实际 DATA 总字节一致。

### 6.3 exit Worker 新路由

`POST /internal/stream`

- 只允许 service binding + `x-internal-key`（新增 secret，不复用 `TUNNEL_TOKEN`）。
- 请求体与 `/api/fetch` 相同，增加 `stream:true`。
- 响应：
  - `status` = 目标站真实状态码（拿到 `head` 后确定）。
  - `x-exit-ctype`、`x-exit-truncated`、`x-exit-ms`。
  - body = 目标原始字节流（不 base64、不缓冲）。
- 错误（没有 `head`）：返回 JSON，状态码 502/503/504。

### 6.4 Relay DO 改造

现有 `handleCall` 是“收齐 chunks → base64”。新增 `handleStream`：

1. 分配 `ch`、生成 `id`、写 `pending`（这里存 `controller`，不存 chunks）。
2. 等 `head`（首字节超时 60s）。
3. 用 `head.status` 构造 `Response`，body 是 `ReadableStream`。
4. 每来一个 DATA，`controller.enqueue(bytes)`。
5. 来 `result`，`controller.close()` 并清理 channel。
6. 客户端 abort / 写失败：发 `cancel`，关闭设备连接，清理。
7. 队列上限 512KB；超过则发 `cancel`，向客户端抛错（防止 DO 内存被拖爆）。
8. 设备断线：`controller.error()`，前端收到流内错误；节点标离线。

### 6.5 超时与取消

| 参数 | K 通道 | W 通道 |
|---|---|---|
| 首字节 | 60s | 60s |
| 空闲 | 30s | 20s |
| 总时长 | 300s | 120s（固件 `totalMs`） |
| 取消传播 | fetch abort | abort → exit → `cancel` → 设备关闭连接 |

设备在流式读 body 期间每 2 秒发一次 `hb`（现有固件已有此逻辑），避免被判 stale。

### 6.6 背压

ESP32 的发送速度远低于 Worker/客户端消费速度，正常情况下不会堆积。仍要做上限：

- Relay 队列高水位 256KB，硬上限 512KB。
- 超过硬上限：取消本次流，向客户端发 `upstream_overflow`，不让 DO 内存无限增长。
- 不做跨请求重连/断点续传（v1）。

---

## 7. ESP32 固件改造

### 7.1 新工具：`https_fetch_stream`

与现有 `https_fetch` 共用 TLS/请求构造，但：

1. 解析响应头后先发 `head`。
2. body 边读边发 DATA，不在内存攒整包。
3. 支持 `totalMs`（默认 120000，上限 120000）与 `idleMs`（默认 20000）。
4. 读 body 每 2 秒发 `hb`。
5. 收到 `cancel` 立即关闭 `WiFiClientSecure`，发 `result`（`ok:false, err:"cancelled"`）。
6. `result.meta.truncated` 必须如实上报。
7. 不自动重试、不跟随超过 3 跳重定向。

### 7.2 目标证书校验（G1）

新增 `args.ca` 枚举，固件用 `PROGMEM` 存根证书，按需 `setCACert`：

| 枚举 | 根证书 | 常见使用者 |
|---|---|---|
| `gts_r4` | GTS Root R4 | Cloudflare 当前 WE1 链 |
| `isrg_x1` | ISRG Root X1 | Let's Encrypt / CF 回退 |
| `digicert_g2` | DigiCert Global Root G2 | 多数传统站点 |
| `amazon_ca1` | Amazon Root CA 1 | AWS 前端 |
| `sectigo_r46` | Sectigo Root R46 | 部分站点 |

规则：

- **网页账号通道强制 `ca`**；缺省 → Worker 返回 `tls_verify_required`。
- 未知 `ca` → 固件拒绝，不回退 insecure。
- 开机 NTP 对时（现有 wss 已做）；时间不对 → 证书校验必失败，直接报错。
- 反向验证：故意配错根证书，必须 0 次成功；这不是“能连上”能证明的。

### 7.3 目标主机白名单（第二层 SSRF）

Worker 已经拦私网字面量，但 DNS 解析到私网的情况 Worker 看不到。固件补：

1. `allowed_hosts` 存在 NVS，支持后缀匹配（如 `chat.deepseek.com`、`.kimi.moonshot.cn`）。
2. 解析出 IP 后再判一次：`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`100.64/10`、`::1`、`fc00::/7`、`fe80::/10` → 拒绝。
3. 不在白名单 → `host_not_allowed`，不建 TLS。
4. 管理工作路径保留任意 host 的能力，但生产固件默认关闭 debug 工具；具体用编译宏 `CHAT_PROFILE` 区分。

这样即使 `EXIT_INTERNAL_KEY` 泄漏，攻击者也只能让设备访问几个聊天站点，不能探内网。

### 7.4 请求/响应上限

| 项 | 值 |
|---|---|
| 请求体 | 16KB（不变） |
| 请求头总量 | 8KB（新增，Cookie 大时提前拒绝） |
| 单次响应 | 256KB 硬上限 |
| DATA 块 | 4KB（现有） |
| 并发 | 1 |

### 7.5 固件日志

- 只记录 `host / path / status / bytes / ms / heap`。
- **绝不打印 `cookie`、`authorization`、请求体、响应体**。
- 错误信息不回显 header 内容。
- 现有 `logf()` 的串口缓冲保护继续保留。

### 7.6 兼容性

- WOL + 穿透固件不动。
- 住宅出口固件新增工具，保持旧工具行为；旧 Worker 仍能工作。
- `hello` 的 `tools[]` 增加 `https_fetch_stream`，Manager 的 `pickNode` 自动识别。

---

## 8. 存储与密钥

### 8.1 D1（主库）

```sql
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  key_hash    TEXT NOT NULL,          -- SHA-256(key)
  prefix      TEXT NOT NULL,          -- sk-chat_xxxx 前 12 位，便于排查
  day_calls   INTEGER,                -- NULL = 不限
  day_bytes   INTEGER,
  hosts       TEXT,                   -- JSON 数组，给 web/* 用
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE TABLE usage_daily (
  key_id      TEXT NOT NULL,
  day         TEXT NOT NULL,          -- 北京时间 YYYY-MM-DD
  calls       INTEGER NOT NULL DEFAULT 0,
  bytes_out   INTEGER NOT NULL DEFAULT 0,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

CREATE TABLE web_accounts (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  label       TEXT NOT NULL,
  cookie_enc  TEXT NOT NULL,          -- AES-GCM: v1:iv:ct
  extra_enc   TEXT,                   -- 额外 token/org id，同格式
  status      TEXT NOT NULL DEFAULT 'active',
  last_ok_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE request_log (
  id          TEXT PRIMARY KEY,
  key_id      TEXT NOT NULL,
  model       TEXT NOT NULL,
  channel     TEXT NOT NULL,          -- kilo | web
  status      INTEGER NOT NULL,
  ttft_ms     INTEGER,
  total_ms    INTEGER,
  bytes_out   INTEGER,
  created_at  INTEGER NOT NULL
);
```

- `request_log` 只存元数据，不存 prompt/response；保留 7 天，定时清理。
- 日界按北京时间切，和现有 exit 一致。

### 8.2 KV

| key | 内容 | TTL |
|---|---|---|
| `models:kilo` | Kilo 模型清单 | 10 分钟 |
| `config:web` | 启用的 web provider/model 列表 | 常驻 |
| `session:opencode:<conv>` | v2 用 | 30 天 |

### 8.3 R2（后续）

- bucket `chat-media`：docx、图片、视频产物。
- v1 不启用。

### 8.4 Secrets

| 名称 | 用途 |
|---|---|
| `EXIT_INTERNAL_KEY` | chat Worker ↔ exit Worker service binding |
| `COOKIE_ENC_KEY` | AES-GCM 主密钥（32 字节 base64） |
| `ADMIN_TOKEN` / `ADMIN_USER` | 管理接口 |
| `KILO_BASE`（可选） | 覆盖默认网关 |
| `WEB_CHANNEL_ENABLED` | 总开关，默认 0 |
| `OPENCODE_MODE` | `off` / `shadow` / `on`，默认 off |

### 8.5 Cookie 加密

```
存储：v1:<base64(iv)>:<base64(ciphertext)>
算法：AES-256-GCM
附加数据：provider|label（防止换行/换账号重放）
解密：仅在 buildRequest 时进行一次
日志：永不输出明文；错误信息统一 "account_decrypt_failed"
```

信任边界说明：Cloudflare 仍能在 Worker 内存里看到明文 Cookie。如果不能接受这个边界，网页账号通道就不应开启。

---

## 9. 安全设计

### 9.1 威胁模型

| 威胁 | 缓解 |
|---|---|
| 下游 key 泄漏 | 每 key 独立配额/吊销；只存 hash；`sk-chat_` 前缀 |
| 设备 token 泄漏 | 只能冒充设备接入；固件主机白名单限制能访问的站点 |
| `EXIT_INTERNAL_KEY` 泄漏 | 只能发起白名单站点的流式请求；内网被固件 IP 检查挡住 |
| Cookie 中间人 | 强制目标证书校验；不通过不发送 |
| Cookie 落日志 | 统一脱敏；测试 grep 断言 |
| SSRF | Worker 字面量检查 + 固件 DNS 后私网检查 + 主机白名单 |
| 滥用/批量 | 每 key 日配额、每账号配额、并发 1、可选 Rate Limiting 绑定 |
| 上游看到 CF IP | 网页通道走 ESP32；免费通道接受 CF IP |
| 提示词隐私 | 免费池可能记录 prompt；文档明示；不传敏感信息 |

### 9.2 鉴权

- 下游：`Authorization: Bearer sk-chat_...`；D1 存 SHA-256；常量时间比较。
- 管理：`Authorization: Bearer <ADMIN_TOKEN>`；不接受 URL 参数；不设默认口令。
- 服务间：`x-internal-key`，独立于 `TUNNEL_TOKEN`。
- 设备：沿用现有 `TUNNEL_TOKEN`。

### 9.3 CORS

- `/v1/*` 默认允许 `*`（OpenAI SDK 多为服务端调用），但文档明确：**不要把 key 放浏览器**。
- `/admin/*` 不允许跨域，返回 `SameSite=Strict` 会话 Cookie（若做 UI）。

### 9.4 配额

- `day_calls` / `day_bytes` 在 D1 `usage_daily` 原子累加（`INSERT ... ON CONFLICT DO UPDATE`）。
- 超额返回 429，带 `x-ratelimit-remaining`。
- 网页账号另加 `day_turns`（每账号 100 次/天，默认），防止单账号被刷爆。
- 并发 1：Manager 的 `conns` 在流开始时 +1，结束/取消 -1；满了直接 429 `device_busy`，不排队（SSE 排队体验差）。

### 9.5 日志

```json
{
  "rid": "req_...",
  "key": "main",
  "model": "web/deepseek/default",
  "channel": "web",
  "status": 200,
  "ttft_ms": 1830,
  "total_ms": 24000,
  "bytes": 12034,
  "node": "c6-02f8cc"
}
```

禁止字段：`messages`、`prompt`、`cookie`、`authorization`、`set-cookie`、完整 URL query（可能带 token）。

---

## 10. 目录结构（在现有仓库上新增）

```
esp32/
├─ worker/                          # 现有 exit Worker，最小改动
│  ├─ src/index.ts                  # + /internal/stream 路由
│  ├─ src/Relay.ts                  # + handleStream（流式）
│  ├─ src/Manager.ts                # + conns 计数/忙判定
│  └─ wrangler.exit.toml
│
├─ chat-worker/                     # 新 Worker，独立部署（M1 已落地）
│  ├─ src/index.ts                  # 路由 + 鉴权 + 配额 + admin
│  ├─ src/openai/errors.ts
│  ├─ src/openai/sse.ts             # SSE 编码/改写
│  ├─ src/openai/validate.ts        # OpenAI 请求校验
│  ├─ src/panel.ts                  # /admin 控制面板（chat2 同款）
│  ├─ src/exit-client.ts            # 网页请求 → esp32-exit
│  ├─ src/router.ts                 # 模型前缀路由
│  ├─ src/providers/kilo.ts
│  ├─ src/providers/qwen.ts         # web/qwen，已接入
│  ├─ src/providers/deepseek.ts     # web/deepseek，已接入
│  ├─ src/providers/deepseek-pow.ts # SHA3 PoW 求解
│  ├─ src/providers/deepseek-wasm.ts# 26KB WASM base64
│  ├─ src/providers/deepseek-login.ts# 短信验证码登录
│  ├─ src/providers/doubao.ts       # web/doubao，已接入
│  ├─ src/providers/doubao-login.ts # 豆包 passport 短信登录
│  ├─ src/providers/glm.ts          # web/glm，已接入
│  ├─ src/providers/chatgpt.ts      # web/chatgpt，按 chat2api 复刻
│  ├─ src/storage/store.ts          # D1 / Memory
│  ├─ src/storage/accounts.ts       # 加密账号池
│  ├─ src/storage/cache.ts          # KV / Memory 模型缓存
│  ├─ src/types.ts
│  ├─ src/util.ts
│  ├─ test/*.test.mjs               # 71 项
│  ├─ test/live-kilo.mjs            # 可选真实上游
│  ├─ test/live-qwen.mjs            # 可选，需要 QWEN_TOKEN
│  ├─ test/live-deepseek.mjs        # 可选，需要 DEEPSEEK_TOKEN
│  ├─ test/live-doubao.mjs          # 可选，需要 DOUBAO_SESSIONID
│  ├─ migrations/0001_init.sql
│  ├─ migrations/0002_web_accounts.sql
│  ├─ wrangler.toml
│  └─ package.json
│
├─ firmware/ESP32_C6_Exit/
│  ├─ ESP32_C6_Exit.ino             # + https_fetch_stream / CA / 白名单
│  └─ certs/                        # 根证书（PROGMEM 生成）
│
├─ test/chat/
│  ├─ provider-probe.mjs            # G0
│  ├─ cert-negative.mjs             # G1
│  ├─ sse-e2e.mjs                   # mock exit + mock provider
│  ├─ openai-sdk.mjs                # Python/Node SDK 兼容
│  ├─ kilo-live.mjs                 # 可选，真实上游
│  ├─ device-stream.mjs             # 真机
│  └─ security.mjs
│
└─ docs/chat/
   ├─ 00-design.md                  # 本文
   ├─ provider-matrix.md            # 探针结果
   └─ runbook.md                    # 部署/轮换/止损
```

---

## 11. 部署与配置

### 11.1 前置条件

- **Workers Paid（建议）**：DO、长流、30s CPU 限制；免费版 10ms CPU 跑 SSE 变换不够稳。
- 自定义域名 `chat.example.com`；不要用 `*.workers.dev`（国内 DNS 污染，仓库文档已踩过）。
- D1 一个、KV 一个；R2 暂不建。

### 11.2 绑定

`chat-worker/wrangler.toml` 关键片段：

```toml
name = "chat2api"
main = "src/index.ts"
compatibility_date = "2026-11-01"

[[d1_databases]]
binding = "DB"
database_name = "chat2api"
database_id = "<id>"

[[kv_namespaces]]
binding = "KV"
id = "<id>"

[[services]]
binding = "EXIT"
service = "esp32-exit"

[vars]
KILO_BASE = "https://api.kilo.ai/api/gateway"
WEB_CHANNEL_ENABLED = "0"
OPENCODE_MODE = "off"
```

### 11.3 密钥

```bash
cd chat-worker
npx wrangler secret put EXIT_INTERNAL_KEY
npx wrangler secret put COOKIE_ENC_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler d1 execute chat2api --file=migrations/0001_init.sql
npx wrangler deploy
```

exit Worker 同步新增：

```bash
cd worker
npx wrangler secret put EXIT_INTERNAL_KEY --config wrangler.exit.toml
npx tsc --noEmit
npx wrangler deploy --config wrangler.exit.toml
```

### 11.4 上线开关

| 阶段 | 配置 |
|---|---|
| M1 | `WEB_CHANNEL_ENABLED=0`，只开 Kilo |
| M3 | `WEB_CHANNEL_ENABLED=1`，只放行探针通过的 provider |
| 事故 | 改 `0` 立即停 web，Kilo 不受影响 |

---

## 12. 里程碑与验收

### M0 · 设计与门禁（本轮）

- 本文 + `provider-matrix.md` 模板。
- 验收：三个门禁有明确结论；候选站点清单确定。

### M1 · Kilo 免费通道 + OpenAI API

**状态：已实现（2026-11-02，2026-11-03 追加千问 + DeepSeek 通道）**，代码在 `chat-worker/`。

- `/v1/models`、`/v1/chat/completions`（流式/非流式）。
- **Kilo 免费通道 + 千问 `web/qwen/*` + DeepSeek `web/deepseek/*` + 豆包 `web/doubao/*`**。
- DeepSeek：session → `create_pow_challenge` → WASM 解 SHA3 PoW → `chat/completion` → 自定义 SSE 转 OpenAI SSE。
- DeepSeek 短信登录：`/v1/auth/deepseek/sms/send` + `/sms/verify`，token 加密进 `web_accounts`。
- 豆包：`/samantha/chat/completion`，sessionid + 自定义 SSE 解析。
- **网页请求经 esp32-exit `/api/fetch`**（service binding + `EXIT_CLIENT_KEY`），出口是家里 IP；Kilo 仍 Worker 直连。
- `WEB_EGRESS_REQUIRED=1` 时没配 exit 直接 503，**不会静默退化成 CF 直连**。
- 面板新增“检测 ESP32 出口”，对应 `GET /admin/api/egress-check`。
- 当前 exit 是缓冲模式：请求体 ≤16KB、响应 ≤256KB、固件单次约 15s；逐块流式留给 M2。
- D1 key、配额、错误码；D1 为空时用 `CHAT_API_KEYS` secret 当种子。
- 控制面板：`/admin`（chat2 同款渐变卡片风格），管理 Key、网页账号、DeepSeek 短信登录。
- 管理接口：`/admin/api/keys`、`/admin/api/accounts`、`/admin/api/status`。
- 验收结果：
  - `npm test`：**71 passed / 0 failed**（SSE、校验、Kilo、千问、DeepSeek PoW/流式、豆包、豆包短信登录、GLM、ChatGPT 复刻、ChatGPT PoW 参考向量、短信登录、控制面板、账号池、ESP32 出口、鉴权、配额、admin）。
  - DeepSeek PoW 单测：与参考解 `answer=58033` 一致。
  - 真实 Kilo：`15` 个免费模型；一次流式请求 **47 个 SSE 帧**，2.86s，模型名被改写为 `kilo/kilo-auto/free`。
  - OpenAI Node SDK 真实链路：流式 **9 帧 / content "你好"**；非流式 content "你好"。
  - `wrangler deploy --dry-run` 打包通过（**250.00 KiB / gzip 66.59 KiB**）。
  - `/admin` 控制面板已用真浏览器验收：登录后可见标题、指标卡、三个标签页。
  - 无 key → 401；未配置 → 503；超配额 → 429；上游 429 带 `Retry-After`。
  - 已接入 `web/qwen/*`、`web/deepseek/*`、`web/doubao/*`、`web/glm/*`、`web/chatgpt/*`；其余 `web/*` 返回 404 `model_not_found`。
  - **已知行为**：Kilo 免费池里多个模型默认走 reasoning；`max_tokens` 太小（<256）时可能只输出 reasoning、`content` 为空。默认 `max_tokens=1024`，短回答也建议 ≥256。
- 运行：
  ```bash
  cd chat-worker
  npm install
  npm test
  npm run live        # 可选，真实打 Kilo
  ```

### M2 · exit 流式 + 固件

- `https_fetch_stream`、`head/cancel`、`/internal/stream`、Relay `handleStream`。
- 验收：
  - mock ESP32 流式 20 块，逐字节 sha256 一致。
  - 真机单次 60s 流式不断线，heap 峰值后回落。
  - 客户端中断 → 设备 5s 内收到 `cancel`。
  - 拔电 → 流内错误 + 节点离线。
  - 证书错配 → 0 次成功。

### M3 · 第一个网页账号 provider

- 选 M0 探针通过的第一个站点。
- Cookie 加密、16KB 预算、错误映射。
- 验收：
  - 20 轮短对话成功。
  - 20KB 请求体 → 413。
  - 300KB 响应 → `upstream_truncated`。
  - 日志 grep 不到 Cookie。
  - 并发第二路 → 429 `device_busy`。

### M4 · OpenCode（可选）

- 先做可行性门禁；不通过就停在 `OPENCODE_MODE=off`。
- 验收：整形请求 200 + SSE；版本/探针记录在案。

### M5 · 运维

- 管理接口、用量视图、告警、密钥轮换 runbook。
- 验收：轮换 key 不影响在途请求；吊销立即 401。

### 后续 · docx / 图片 / 视频

见第 15 节。

---

## 13. 测试计划

| 类别 | 用例 | 断言 |
|---|---|---|
| 单元 | SSE 解析/编码 | 多行 data、注释、`[DONE]`、坏 JSON |
| 单元 | 模型路由 | 未知前缀 404；大小写/空白处理 |
| 单元 | key 鉴权 | 正确/错误/吊销/常量时间 |
| 集成 | mock exit | 流式 20 块、head 状态、取消 |
| 集成 | mock Kilo | SSE 透传、429、5xx 重试一次 |
| 集成 | OpenAI SDK | Python + Node 两种客户端 |
| 真机 | 60s 流式 | 不断线；heap 回落；心跳 |
| 真机 | 取消 | 设备 5s 内关闭目标连接 |
| 真机 | 拔电 | 流错误 + 503 |
| 安全 | 证书错配 | 0 次成功 |
| 安全 | SSRF | 私网字面量/十进制/DNS 后私网 |
| 安全 | 日志脱敏 | grep 不到 cookie/authorization/prompt |
| 压力 | 10 并发 | 1 成功 + 9 × 429；无内存增长 |
| 长跑 | 100 轮 | 成功率 ≥95%；无泄漏 |

门禁命令（沿用仓库风格）：

```bash
cd chat-worker && npx tsc --noEmit
node test/chat/sse-e2e.mjs
node test/chat/security.mjs
node test/e2e.mjs                 # 现有 26 项不能退
node test/security.mjs            # 现有 55 项不能退
```

---

## 14. 风险与止损

| # | 风险 | 概率 | 影响 | 应对/止损 |
|---|---|---|---|---|
| 1 | 网页站点全部拒绝 mbedTLS 指纹 | 高 | 网页通道空转 | 探针 3 个站点仍全失败 → 关闭 web 通道，只保留 Kilo |
| 2 | Cookie 经未校验 TLS 泄漏 | 中 | 账号被盗 | G1 不过不许开；证书错配测试必须 0 成功 |
| 3 | 16KB 上下文不够用 | 高 | 多轮体验差 | 明确提示；长上下文走 kilo；后续加家中主机 |
| 4 | 流式 120s 被固件/CF 掐断 | 中 | 长回答失败 | 限 `max_tokens`；M2 真机 60s 验收；失败显式报错 |
| 5 | CF 出口被 Kilo 限流/区域限制 | 中 | 免费通道不稳 | 探针 + 缓存 + 429 透传；必要时换官方 API |
| 6 | ESP32 掉线/断电 | 高 | web 不可用 | 503 显式；Kilo 不受影响；WOL 无法救断网 |
| 7 | `EXIT_INTERNAL_KEY` 泄漏 | 低 | 白名单站点被刷 | 固件主机白名单 + 私网检查 + 配额 + 轮换 |
| 8 | 提示词/隐私 | 中 | 数据泄露 | 免费池可能记录；文档明示；不传敏感内容 |
| 9 | 上游 ToS/合规 | 中 | 账号封禁 | 个人低频使用；不转售；不批量 |
| 10 | OpenCode 整形漂移 | 高 | v2 失效 | 版本绑定 + 探针 + `OPENCODE_MODE=off` 默认 |

**止损规则**：网页通道连续 3 个候选站点探针失败，或真机流式连续 10 次失败，停止投入，把系统定位为“Kilo 免费聊天 + ESP32 小请求出口”。

---

## 15. 后续：docx / 图片 / 视频

### 15.1 docx（最可行，不依赖 ESP32）

```
POST /v1/files/docx  { title, sections[] }
  → Worker 内 docx + JSZip 生成
  → R2 存 .docx
  → 返回 /v1/files/<id> 签名下载 URL
```

- 无住宅出口需求。
- 需要 R2、签名 URL、清理策略。
- 可与聊天结合：模型输出结构化 JSON → docx。

### 15.2 图片

- 免费/官方 API：Worker 直接调用，结果进 R2。
- 网页账号：需经 ESP32；但图片多为 b64 或大文件，256KB 上限经常不够。
- 结论：优先 API；网页账号图片只支持“返回 URL”的站点，且 URL 需可被 Worker 拉取。

### 15.3 视频

- 必然是异步任务：提交 → job id → 轮询 → R2。
- 网页账号提交通常需要大 body/长连接，ESP32 不成立。
- 结论：只有两种情况可做：
  1. 官方/第三方 API 支持异步任务；
  2. 家里有常驻主机（当前没有）。
- v1 明确不做，避免写成“以后支持”的空头支票。

### 15.4 若以后加了家中主机

最小改动：

- ESP32 只做 WOL 唤醒。
- 主机跑 `chat2api + curl_cffi`，用 Cloudflare Tunnel 或 Worker 反连。
- chat Worker 增加 `home/*` 通道，接口与 `web/*` 相同。
- 现有 `exit-fetch` 协议不用改，只是换执行端。

---

## 附录 A · OpenAI SSE 帧示例

```text
data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1762000000,"model":"kilo/kilo-auto/free","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1762000000,"model":"kilo/kilo-auto/free","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1762000000,"model":"kilo/kilo-auto/free","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

约定：

- 首帧带 `role:"assistant"`。
- 每帧 `id/model` 固定，不随上游变化。
- `finish_reason` 只出现在最后一帧。
- 上游没有 usage 就不写 usage，不编造。

---

## 附录 B · 网页账号探针矩阵模板

`docs/chat/provider-matrix.md`：

| 站点 | 端点 | 认证方式 | HTTP | cf-mitigated | ctype | 结论 | 日期 |
|---|---|---|---|---|---|---|---|
| deepseek | `/api/v0/chat/completion` | Cookie | 待测 | 待测 | 待测 | 待定 | |
| kimi | 待补 | Cookie | 待测 | 待测 | 待测 | 待定 | |
| chatgpt | `/backend-api/conversation` | Bearer access token | 待测 | 待测 | 待测 | 高风险 | |
| claude | `/api/...` | session cookie | 待测 | 待测 | 待测 | 高风险 | |
| gemini | `/_/...` | cookie + at token | 待测 | 待测 | 待测 | 高风险 | |

只有“结论=通过”的站点才允许写进 `config:web`。

---

## 附录 C · 决策记录（ADR 摘要）

| # | 决策 | 理由 | 重新评估条件 |
|---|---|---|---|
| ADR-1 | 新建 chat Worker，不改造成 exit | 鉴权/配额/发布独立；exit 保持小而安全 | 若流量极低且想省一个 Worker |
| ADR-2 | v1 无状态，不存会话 | 16KB 限制 + 隐私 + 复杂度 | 有家中主机/更大上下文时 |
| ADR-3 | 免费池走 Kilo 直连 | 无账号、OpenAI 兼容、Workers 可直接 fetch | Kilo 关闭免费池 |
| ADR-4 | OpenCode 放 v2 | 整形/传输/可用性都不稳 | 门禁通过且上游稳定 |
| ADR-5 | 网页通道强制证书校验 | 否则 Cookie 可被中间人窃取 | 不适用（硬规则） |
| ADR-6 | 流式经 DO 转发，不缓冲 | 现有 `/api/fetch` 会攒整包 | 不适用 |
| ADR-7 | 并发满直接 429，不排队 | SSE 排队首字不可预期 | 有队列 UI 时 |
| ADR-8 | 图片/视频 v1 不做 | ESP32 256KB + 1~12s 不成立 | 有家中主机或官方异步 API |

---

## 附录 D · 需要你确认的默认值

| 项 | 默认值 | 可改 |
|---|---|---|
| Workers Paid | 建议开启 | 是 |
| 首个网页 provider | 按探针结果选 | 是 |
| 单 key 日额度 | 2000 次 / 50MB | 是 |
| 单账号日轮次 | 100 | 是 |
| web `max_tokens` | 2048 | 是 |
| web 请求体上限 | 16KB | 固件硬上限，不可超 |
| 流式总时长 | 120s | 固件上限 120s |
| Cookie 存储 | AES-GCM 进 D1 | 可改为每请求透传 |
| OpenCode | `off` | `shadow` / `on` |

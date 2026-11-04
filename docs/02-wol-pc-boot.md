# 定时唤醒电脑 —— WOL 方案（已落地）

> 目标机器：华硕 X550CC 笔记本 / Windows Server 2025
> 执行器：ESP32-D0WD 开发板（COM3）

---

## 一、当前进度

| 环节 | 状态 | 证据 |
|---|---|---|
| 网卡武装（可唤醒） | ✅ | `powercfg /devicequery wake_armed` → Realtek PCIe GbE |
| Magic Packet 唤醒 | ✅ | 注册表 `*WakeOnMagicPacket = 1` |
| **关机(S5)唤醒开关** | ✅ | 注册表 **`S5WakeOnLan = 1`** |
| 快速启动（必须关） | ✅ | `HiberbootEnabled = 0`，关机是真 S5 |
| ESP32 联网 | ✅ | IP `192.168.1.123`，RSSI -65dBm |
| ESP32 NTP 对时 | ✅ | `2026-10-07 16:34:29` |
| ESP32 HTTP 触发 | ✅ | `curl .../wake` 返回成功 |
| ESP32 发魔术包 | ✅ | `[WOL] magic packet -> AA:BB:CC:DD:EE:FF (via 192.168.1.255)` |
| ESP32 状态页 / 网页改时间 | ✅ | v2 已刷入，`/status`、`/set`、`/wake` 实测全通 |
| **ESP32 独立供电** | ❌ **未做，必须做** | 现在插在笔记本 USB 上 |
| 实测唤醒 S3 | ⏳ 待做 | |
| 实测唤醒 S5 | ⏳ 待做 | |

**唯一阻塞：供电。** ESP32 现在插在笔记本自己的 USB 口。笔记本一睡眠，USB 断电，ESP32 跟着死，发不出包 —— 自己叫不醒自己。

---

## 二、先做这一步：换独立供电

把 ESP32 从笔记本 USB 拔下来，插到 **手机充电器** 或 **插排上的 USB 口**。

插上后打开串口看它拿到的 IP（可能会变，路由器 DHCP 决定的）：

```bash
cd F:/esp32/tools
"C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
  serial_tail.py COM3 115200 20
```

记下打印出来的 `IP = 192.168.x.x`。

> ⚠️ 用 `serial_tail.py`（只监听、不复位），别用 `serial_read.py`（会复位芯片）。

---

## 三、测试唤醒

### 测 S3（睡眠）—— 大概率成

1. 确认 ESP32 已独立供电、拿到新 IP
2. 笔记本开始菜单 → 电源 → **睡眠**
3. 拿**手机**连同一个 WiFi，浏览器打开 `http://<ESP32的IP>/`
4. 点红色「唤醒电脑」按钮
5. 看笔记本是否亮起

### 测 S5（关机）—— 成败看硬件

同上，但第 2 步改成**关机**。

- 成 → 完美，你要的"定时开机"彻底打通
- 不成 → 说明这台笔记本 S5 时没给网卡待机供电。**这是硬件限制，软件层面已无解**，
  只能回退到 BIOS RTC 或控制适配器供电的方案（见第五节）

> 测试时 ESP32 的串口日志会打印每次发包记录，可用来确认"包确实发出去了"。
> 若包发了但电脑没醒 → 问题在电脑侧；若包没发 → 问题在 ESP32 侧。

---

## 四、日常使用

### 端口速查

| 用途 | 值 |
|---|---|
| ESP32 串口 | **COM3**（115200） |
| ESP32 网页 | **端口 80**，浏览器直接输 `http://192.168.1.123/`（**不用写 `:80`**） |
| 备用地址（mDNS） | `http://wol.local/` |
| WOL 魔术包端口 | 9 和 7（ESP32 内部自己发，你不用管） |

### 网页能做什么

打开 `http://192.168.1.123/` 会看到：

- **大号倒计时** —— 距下次唤醒还剩多久
- 当前时间 / 下次唤醒时刻（含"明天"标记）
- 今日是否已触发、累计发包数、最后一次发包时间
- ESP32 的 IP 和 WiFi 信号强度
- **修改唤醒时间** —— 直接在网页上填 时/分，点保存，**存进 flash，断电不丢，不用重新编译**
- **立即唤醒电脑** 按钮 —— 手动测试用

### 改时间

网页上改就行。固件里的默认值（`DEFAULT_HOUR` / `DEFAULT_MINUTE`）只在 flash 里没有保存过时生效。

要重新刷固件：

```bash
cd F:/esp32
cmd //c upload.bat ESP32_WOL
```

（`upload.bat` 已改成通用版，参数是 `arduino/` 下的目录名）

### 怎么看日志确认发包了

```bash
cd F:/esp32/tools
"C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
  serial_tail.py COM3 115200 20
```

> 用 `serial_tail.py`（只监听不复位）。`serial_read.py` 会复位芯片，调试常驻服务时别用。

---

## 五、如果 S5 唤醒失败 —— 备选

### 备选 1：BIOS RTC 定时开机（零成本）
开机按 **F2** → `Advanced` → 找 `APM Configuration` / `Wake Up Event Management` /
`Power On By RTC` → 启用并设时间。BIOS 层直接触发，比 WOL 可靠。

### 备选 2：ESP32 控制适配器供电（不用拆机）
1. BIOS 里设 `Restore AC Power Loss` = **Power On**
2. ESP32 + 继电器串在适配器正极（或直接用智能插座）
3. 到点给电 → 笔记本自动开机

⚠️ 只用它开机，关机交给系统自己（`shutdown /s /t 0`），别硬断电。

### 不推荐
拆笔记本接电源键 —— X550CC 电源键在键盘薄膜上，要拆机 + 焊接 + 光耦，
风险远高于收益。

---

## 六、内网穿透 + 公网手动唤醒（v3，已写码）

在原有 WOL 基础上叠了一套公网通道，参考 WorkBuddy 资料库《ESP32 + Cloudflare Workers 局域网穿透》：

- **固件**：`arduino/ESP32_WOL_Tunnel/ESP32_WOL_Tunnel.ino`（新 sketch，不动原来的 ESP32_WOL）
- **中继**：`F:/esp32/tunnel/worker/`（Cloudflare Workers + Durable Object）
- **手动发送**：手机打开 `https://<worker>/panel/wol` 点按钮 ／ 双击 `F:/esp32/tunnel/send-wol.bat` ／ `node client/wol.mjs <worker> wol`
- **顺带能穿透**：`node client/tunnel.mjs 3389 192.168.1.50 3389 wss://<worker> wol`

完整说明见 `F:/esp32/tunnel/README.md`。刷固件：`cmd //c upload.bat ESP32_WOL_Tunnel`。

> 状态：Worker 端 `tsc --noEmit` 通过、端到端 `e2e.mjs` 10/10 全绿；**固件编译被安全中心拦在对工具链头文件的读取上，待放行后执行**。

---

## 七、环境备忘

| 项 | 值 |
|---|---|
| 笔记本有线 MAC | `74-D0-2B-BA-B4-14` |
| 第二网卡 MAC | `00-E0-4C-46-33-18`（Realtek USB GbE，未插线） |
| WLAN MAC | `24-FD-52-3C-F6-A7`（AR9485，不支持 WOL） |
| ESP32 IP（当前） | `192.168.1.123`（换电源后可能变） |
| WOL 端口 | 9 和 7（固件两个都发） |
| 广播地址 | 子网广播 + `255.255.255.255`（固件两个都发） |

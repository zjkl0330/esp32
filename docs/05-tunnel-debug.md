# 隧道「数据只去不回」排查复盘 —— 三个 bug 叠加

> 结论先行：问题不是单点，而是**三个 bug 叠加**，每个单独看症状都指向别处。
> 全文记录排查路径，配真实日志，希望下一个踩坑的人少走弯路。

## 症状

本地 TCP 连上了、用户 WebSocket 也建好了，但**永远收不到 OPEN_OK**，
`/wol` 接口返回 200「已发送」而板子串口一片安静。

## Bug 1：Worker 把帧转发给「僵尸连接」

`Durable Object` 里取 ESP32 连接最初这样写：

```ts
private esp32() {
  const list = this.ctx.getWebSockets('esp32');
  return list.length > 0 ? list[0] : null;   // ⚠️
}
```

两个坑：

1. `getWebSockets()` **不保证返回顺序**；
2. ESP32 掉电/复位时 TCP 没有 FIN，CF 侧旧连接残留很久。

于是每次板子重连，`list[0]` 都是**最早那条死连接**，`send()` 静默进黑洞。
接口层完全看不出来——`esp32` 还显示在线（列表非空嘛）。

**修法**：只认 `readyState === OPEN` 的连接、从后往前取最新的；
新 ESP32 接入时先把旧的 `close(1000, 'replaced')` 掉。

## Bug 2：固件先判 `connected()` 后读数据

```cpp
// 错误顺序
if (!cl.connected()) { closeChannel(c, true); continue; }  // ①
int avail = cl.available();                                 // ②
```

远端优雅关闭时（HTTP「发完即关」是典型），`connected()` **立刻变 false，
但接收缓冲里还压着整段响应**。走到 ① 就把通道连缓冲一起 `stop()` 掉了。

**修法**：先 `available()` 读干净、转发完，缓冲空了再判 `connected()` 收尾。
修完才能解释为什么「拨号成功、请求发得出去、一个字节都回不来」。

## Bug 3：通道号超过固件上限被静默丢弃

客户端分配通道：

```js
const channel = 1 + (seq++ % 254);   // 能到 254
```

固件处理 OPEN：

```cpp
if (length < 8 || ch >= MAX_CHANNELS) return;   // MAX_CHANNELS = 8
```

**通道号一旦超过 7，固件静默 return** —— 不报错、不回 CLOSE，什么都不发生。
而且这时候帧**确实到了板子**（串口能看到 `[WS] RX frame 8 bytes`），
最容易让人以为是 Worker 的问题。

**修法**：客户端限制 1..7；同时通道是 ESP32 上的**全局资源**，
多个客户端进程必须用 `CHANNEL_BASE`/`CHANNEL_COUNT` 划分不重叠区间。

## 排查路径（为什么花了这么久）

| 步骤 | 做了什么 | 得到什么 |
|---|---|---|
| 1 | 写 `test/real-worker.mjs` 用两个 WS 打真实 Worker | 8/8 全绿 → 路由逻辑没错（但此时没暴露僵尸问题） |
| 2 | 换靶机（ESP32 连不上自己的 IP） | `dial FAILED` → 拨号链路通了 |
| 3 | 串口 + 客户端同步抓 | 帧到了板子、`RX frame 8 bytes`、但 `OPEN ch9` 没打印 → **锁定 Bug 3** |
| 4 | 用合法通道号重试 | `dial FAILED`（靶机绑了 127.0.0.1）→ 重启靶机绑 0.0.0.0 → **通了** |

三个 bug 是**逐层剥开**的：Bug 1 被 Bug 3 掩盖（通道号大时根本走不到转发）；
Bug 2 被 Bug 1 掩盖（帧都到不了板子，谈何读缓冲）。修掉上一层才能看到下一层。

## 经验总结

1. **写客户端时先对齐固件的硬约束**（通道数、帧大小上限），协议文档里写清；
2. **固件对非法输入要么报错要么回 CLOSE，不要静默 return** —— 静默丢弃是最难查的失败模式；
3. **判断工具链健康别用 `--version`**（GCC 内部程序 cc1/cc1plus 不支持），做一次真实编译才算验证；
4. **打开串口 = DTR 复位板子**，测试中途反复开关串口等于反复踹重启，自动化验证要一次开好；
5. `getWebSockets()` 拿到的连接可能死掉，发帧前校验 `readyState`，并且新连接顶掉旧连接。

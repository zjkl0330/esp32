# ESP32 能刷什么 — 项目清单

> 硬件实况（本机实测，2026-10-07）

| 项目 | 实测值 |
|---|---|
| 芯片 | ESP32-D0WD rev v1.0（Xtensa LX6 双核） |
| 主频 | 240 MHz（XTAL 40MHz / APB 80MHz） |
| **Flash** | **4 MB** @80MHz，Micron/ST 兼容芯片（ID `0x4016`） |
| **可用程序空间** | **1,310,720 字节（1.25 MB）** |
| **SRAM 可用堆** | **370,600 字节（362 KB）**，空闲 326 KB |
| 最大连续内存块 | 110,580 字节（≈108 KB） |
| PSRAM | 默认编译下检测为 NO（**未做启用 PSRAM 的交叉验证**，待确认） |
| 无线 | WiFi 2.4GHz + 蓝牙经典/BLE |
| 软件栈 | ESP-IDF v5.5.4 / Arduino core 3.3.10 |
| 串口 | COM3 (CP210x) |

**一句话定位**：4MB Flash + 362KB RAM、无（待确认）PSRAM 的入门级 ESP32。
跑网络类、外设控制类项目绰绰有余；跑图像/语音/大屏类项目会卡在内存上。

---

## 一、能直接刷（只需板子本身 + WiFi）

| 项目 | ★ | 用途 |
|---|---|---|
| [Tasmota](https://github.com/arendst/Tasmota) | 24.8k | 智能家居固件：MQTT / HTTP / KNX / 定时规则，Web 配置 |
| [WLED](https://github.com/wled/WLED) | 18.8k | WS2812B 等数字 LED 灯带控制，自带 Web UI 和特效 |
| [ESPHome](https://github.com/esphome/esphome) | 11.8k | YAML 写配置，接 Home Assistant 生态 |
| [ESP32 Marauder](https://github.com/justcallmekoko/ESP32Marauder) | 12.6k | WiFi/蓝牙 安全审计套件（扫描、抓包、wardriving） |
| [nodemcu-firmware](https://github.com/nodemcu/nodemcu-firmware) | 7.9k | Lua 交互式固件，免编译直接写脚本 |
| [ESP32-Bit-Pirate](https://github.com/geo-tp/ESP32-Bit-Pirate) | 5.9k | 硬件调试工具，Web CLI，跑 I2C/SPI/UART/CAN/JTAG |
| [IRremoteESP8266](https://github.com/crankyoldgit/IRremoteESP8266) | 3.6k | 红外遥控收发库，支持大量空调/电视协议 |
| [FastLED](https://github.com/FastLED/FastLED) | 7.5k | LED 动画库（配 WLED 用或自己写） |
| [ArduinoJson](https://github.com/bblanchon/ArduinoJson) | 7.2k | JSON 库，做 API 对接必备 |
| [TFT_eSPI](https://github.com/Bodmer/TFT_eSPI) | 4.9k | TFT 彩屏驱动库（接屏后可用） |

## 二、能刷，但需要外接模块

| 项目 | ★ | 需要什么 |
|---|---|---|
| [Meshtastic](https://github.com/meshtastic/firmware) | 8.4k | LoRa 模块（SX1276/SX1262）→ 离网 Mesh 通信 |
| [ExpressLRS](https://github.com/ExpressLRS/ExpressLRS) | 5.4k | LoRa 模块 → 高性能 RC 遥控链路 |
| [OpenMQTTGateway](https://github.com/1technophile/OpenMQTTGateway) | 4.1k | 433/315MHz 射频、红外、BLE 多协议网关 |
| [ESP32-BlueJammer](https://github.com/EmenstaNougat/ESP32-BlueJammer) | 8.5k | nRF24 模块（2.4GHz 干扰测试，仅限授权场景） |
| [esp32-weather-epd](https://github.com/lmarzen/esp32-weather-epd) | 6.3k | 墨水屏 + 传感器 → 低功耗天气站 |
| [crosspoint-reader](https://github.com/crosspoint-reader/crosspoint-reader) | 8.2k | 墨水屏 → 开源电子书阅读器 |
| [LVGL](https://github.com/lvgl/lvgl) | 24.8k | 屏幕 → 嵌入式图形 UI（无 PSRAM 时大 UI 受限） |
| [Marlin](https://github.com/MarlinFirmware/Marlin) | 17.6k | 3D 打印机主板硬件 |

## 三、这块板子**不建议**刷

| 项目 | ★ | 原因 |
|---|---|---|
| [ESP32-DIV](https://github.com/cifertech/ESP32-DIV) | 4.1k | 基于 **ESP32-S3**，且是整套定制硬件（主板 + 3×NRF24 + CC1101 屏蔽板），D0WD 刷不了 |
| [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) | 30.5k | AI 语音助手，官方主打 **ESP32-S3 + PSRAM**。（本条未完成复核，待验证） |
| ESP32-CAM 系列 | — | 摄像头 JPEG 缓冲依赖 **PSRAM**，D0WD 通常没有 |
| 复古游戏机模拟器（NES/GB） | — | 模拟器 + 帧缓冲需要 **PSRAM**，362KB SRAM 撑不住 |
| [oomwoo](https://github.com/makerspet/oomwoo) | 11.4k | 扫地机器人，需要激光雷达 + ROS2 上位机 |
| [espectre](https://github.com/francescopace/espectre) | 9.5k | WiFi CSI 人体感知，芯片适配需确认（倾向新一代芯片） |

> 说明：标 **★** 为 GitHub star 数，抓取时间 2026-10-07。
> PSRAM 一项：默认编译固件报告 `Detected: NO`，但未用 `PSRAM=enabled` 重新编译验证，
> 因此不能 100% 断定模组无 PSRAM 芯片。要确认可以补做一次交叉验证。

---

## 四、多功能无线工具箱 + TFT 屏：可行方案

### 结论：ESP32-DIV 刷不了，ESP32 Marauder 能

| | ESP32-DIV | ESP32 Marauder |
|---|---|---|
| 目标芯片 | **ESP32-S3**（README 原话 "built on the ESP32-S3"） | 有 `GENERIC_ESP32` 板型 → 经典 ESP32 支持 |
| 形态 | 整套定制硬件：主板 + 屏蔽板 | 固件，刷进通用开发板 |
| 主板配置 | ESP32-S3 / ILI9341 2.8" / PCF8574 / IP5306 / SD / CP2102 | 用户自己接屏 |
| 屏蔽板 | 3× NRF24 + 1× CC1101 + IR 收发 + 多天线 | 无（可选接 nRF24） |
| 对你 | ❌ 芯片型号就不对 | ✅ 可用 |

### 路线 A：现有板子外挂 SPI 屏

Marauder 官方 `User_Setup.h` 默认驱动就是 **ILI9341**，接线照抄即可：

| TFT 屏引脚 | ESP32 GPIO | 说明 |
|---|---|---|
| VCC | 3.3V | |
| GND | GND | |
| SCK / CLK | **18** | 硬件 SPI |
| MOSI / SDI / DIN | **23** | 硬件 SPI |
| MISO / SDO | **19** | 不用触摸/SD 时可省 |
| CS | **17** | |
| DC / RS | **16** | |
| RST / RES | **5** | |
| BL / LED | **32** | 或直接接 3.3V 常亮 |
| T_CS（触摸） | **21** | 可选，XPT2046 电阻触摸 |

- 屏选 **ILI9341 2.8" 240×320 SPI 模块**，约 20-35 元，驱动宏零改动。
- 换 ST7789 / ST7796 也能用（configs.h 里有 `HAS_ST7789` / `HAS_ST7796`），需改 `User_Setup.h` 驱动宏。
- 官方 SPI 频率 27 MHz。

### 路线 B：直接上一体机（推荐，免飞线）

Marauder 的 `configs.h` 里已内置这些一体板型：

| 板型宏 | 对应硬件 |
|---|---|
| `MARAUDER_CYD_MICRO` | ESP32-2432S028（CYD，"Cheap Yellow Display"） |
| `MARAUDER_CYD_2USB` | 2432S028 双 USB 版本 |
| `MARAUDER_CYD_GUITION` | ESP32-2432S024 GUITION |
| `MARAUDER_CYD_3_5_INCH` | 3.5 寸 CYD |

**ESP32-2432S028R** 就是答案：主控 ESP32-WROOM-32（与手上这颗同芯片）+ 2.8" ILI9341
触摸屏 + microSD 槽 + RGB LED，USB 直插，约 40-70 元。刷完即用，一根线都不用接。

### 官方预编译固件（已实测查询，v1.18.0 / 2026-10-06 发布）

Marauder 的 Release 里直接有 CYD 的成品固件，不用自己编译：

| 固件 | 大小 | 对应硬件 |
|---|---|---|
| `esp32_marauder_v1_18_0_20261006_cyd_2432S028.bin` | **1568.9 KB** | CYD 标准版 |
| `esp32_marauder_v1_18_0_20261006_cyd_2432S028_2usb.bin` | 1755.5 KB | CYD 双 USB 版 |
| `esp32_marauder_v1_18_0_20261006_cyd_2432S024_guition.bin` | 1566.9 KB | GUITION 2432S024 |
| `esp32_marauder_v1_18_0_20261006_cyd_3_5_inch.bin` | 1566.7 KB | 3.5 寸 CYD |
| `marauder-installer-assets.zip` | 28746.4 KB | **网页一键刷机包**（浏览器直接刷，免工具链） |

⚠️ **关键约束**：CYD 固件 **1.53 MB** > 本板默认分区表给的 app 空间 **1.25 MB**。
所以现有这块板子要跑 Marauder，**必须改成 "Huge APP (3MB No OTA)" 之类的分区表**才装得下。

### "all-in-one" 的真实边界

CYD 是**一块板集成主控 + 屏 + 触摸 + SD**，但**没有射频扩展模块**。对照 ESP32-DIV：

| 功能 | CYD + Marauder | 需要额外硬件？ |
|---|---|---|
| WiFi 全套（扫描/嗅探/deauth/beacon/Evil Portal/Karma/Probe Flood） | ✅ | 不需要 |
| BLE 全套（扫描/sniffer/spoof/Sour Apple/AirTag） | ✅ | 不需要 |
| 2.4GHz（NRF24 嗅探/干扰/MouseJack） | ❌ | **要外挂 nRF24 模块** |
| Sub-GHz（315/433/868 重放、干扰） | ❌ | **要外挂 CC1101 模块** |
| 红外（捕获/重放/万能遥控） | ❌ | **要外挂 IR 收发** |
| GPS（wardriving） | ❌ | **要外挂 GPS 模块** |
| SD 日志 | ✅ | 板上自带槽 |
| 触摸 UI | ✅ | 板上自带 |

**结论**：
- 当 **WiFi/BLE 掌上工具箱** → CYD 是真正的 all-in-one，官方固件直接刷，一根线不接。
- 当 **全频段无线工具箱**（要 2.4G / Sub-GHz / IR）→ 做不到 all-in-one，必须外挂模块。
  而 ESP32-DIV 那种「主板 + 屏蔽板」两层结构才集成这些东西，但它需要 ESP32-S3。

### 已验证 / 未验证

- ✅ 已验证：Marauder v1.18.0 有官方 CYD 预编译固件；固件大小；板型宏；TFT 引脚（源码实读）。
- ❌ 未验证：**没有把 Marauder 刷进本板实测过**。尤其是改分区表后能否正常运行，未做端到端验证。

---

## 附：本机刷新固件的命令

```bash
cd F:/esp32/tools
# 编译（把 <Sketch> 换成 F:/esp32/arduino/<目录名>）
./arduino-cli.exe --config-file arduino-cli.yaml compile \
  -b esp32:esp32:esp32 --build-path F:/esp32/build F:/esp32/arduino/<Sketch>

# 上传（波特率必须 115200，默认 921600 会让 esptool 崩）
./arduino-cli.exe --config-file arduino-cli.yaml upload \
  -p COM3 -b "esp32:esp32:esp32:UploadSpeed=115200" \
  --input-dir F:/esp32/build F:/esp32/arduino/<Sketch>
```

或直接双击 `F:/esp32/upload.bat` / `F:/esp32/monitor.bat`。

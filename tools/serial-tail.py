#!/usr/bin/env python
# serial-tail.py —— 跟随串口输出，带时间戳，自动识别复位电平极性。
#
# 为什么需要「自动识别极性」：
#   D0WD 的 CP210x 板子：RTS 低 = 放开 EN。
#   C6 的 CH343 板子实测是**反相**的：RTS 高才是运行，RTS 低把芯片按在复位里。
#   同一份脚本用一套极性去戳两块板，总有一块读出来是「完全没输出」——
#   而「完全没输出」最容易被误判成固件挂了。所以这里两种都试一遍，谁能出字节用谁。
#
# 用法：
#   python tools/serial-tail.py [端口] [秒数] [reset]
#   python tools/serial-tail.py COM4 30 reset
#   python tools/serial-tail.py COM1 0            # 0 = 一直跟，Ctrl+C 退出
import sys
import time

import serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM4"
seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 20
do_reset = len(sys.argv) > 3 and sys.argv[3].lower() == "reset"

ser = serial.Serial(port, 115200, timeout=0.1)
time.sleep(0.4)
ser.reset_input_buffer()

# 两种候选「运行态」，试到能出字节的那个为止
CANDS = [
    ("DTR=T RTS=T", True, True),
    ("DTR=F RTS=F", False, False),
]


def apply_state(dtr, rts):
    ser.setDTR(dtr)
    ser.setRTS(rts)


def pulse(dtr_level):
    """把 EN 拉低再放开。dtr_level 同时决定 IO0 停在「不下载」的那一极。"""
    ser.setDTR(dtr_level)
    ser.setRTS(not dtr_level)
    time.sleep(0.12)
    ser.setRTS(dtr_level)


def drain(secs, show=True):
    out = []
    t0 = time.time()
    buf = b""
    while time.time() - t0 < secs:
        chunk = ser.read(4096)
        if not chunk:
            continue
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            text = line.decode("utf-8", "replace").rstrip("\r")
            out.append(text)
            if show:
                print(f"{time.time()-t0:7.2f}s | {text}", flush=True)
    return out


if do_reset:
    chosen = None
    for label, dtr, rts in CANDS:
        apply_state(dtr, rts)
        time.sleep(0.2)
        ser.reset_input_buffer()
        pulse(dtr)
        time.sleep(0.35)
        ser.reset_input_buffer()
        got = drain(1.6, show=False)
        if got:
            chosen = label
            print(f"[tail] 极性 {label} 有输出（{len(got)} 行）", flush=True)
            for line in got:
                print(f"{0:7.2f}s | {line}", flush=True)
            break
        print(f"[tail] 极性 {label} 无输出，换一个", flush=True)
    if not chosen:
        print("[tail] 两种极性都没输出：可能没上电，或串口没接到芯片 UART", flush=True)
else:
    for label, dtr, rts in CANDS:
        apply_state(dtr, rts)
        time.sleep(0.2)
        if ser.in_waiting:
            print(f"[tail] 极性 {label} 正在吐数据", flush=True)
            break

print(f"[tail] {port} @115200, {seconds if seconds > 0 else 'inf'}s", flush=True)
try:
    drain(seconds if seconds > 0 else 10 ** 9)
finally:
    ser.close()
    print("[tail] closed", flush=True)

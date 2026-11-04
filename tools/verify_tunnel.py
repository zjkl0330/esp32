#!/usr/bin/env python
"""一次性验证：复位板子 -> 等它连上 -> 触发一次 OPEN -> 同时抓串口看板子收到什么。

为什么必须一次做完：打开 COM3 会通过 DTR 触发 ESP32 复位，
所以不能在测试中途反复开关串口，否则每读一次就把板子踹重启一次。
"""
import os
import subprocess
import sys
import threading
import time

import serial

NODE = r"C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
TUNNEL = r"F:/esp32/tunnel"
TOKEN = os.environ.get("TUNNEL_TOKEN", "")
TARGET = os.environ.get("TARGET_IP", "192.168.1.10")
PORT = os.environ.get("TARGET_PORT", "8080")
WAIT_BOOT = int(os.environ.get("WAIT_BOOT", "18"))
CAPTURE = int(os.environ.get("CAPTURE", "16"))

s = serial.Serial("COM3", 115200, timeout=0.3)
print("[开串口] 板子复位中，等 %ds 启动并连上中继..." % WAIT_BOOT, flush=True)
time.sleep(WAIT_BOOT)

pre = b""
while s.in_waiting:
    pre += s.read(s.in_waiting)
boot = pre.decode("utf-8", "replace")
print("  板子已连上中继:", "[WS] connected" in boot, flush=True)


def trigger():
    time.sleep(2)
    env = dict(os.environ)
    env["TUNNEL_TOKEN"] = TOKEN
    r = subprocess.run(
        [NODE, "test/probe-open.mjs", TARGET, PORT, "9"],
        capture_output=True,
        text=True,
        cwd=TUNNEL,
        env=env,
    )
    print("--- 用户客户端 ---", flush=True)
    print(r.stdout.strip() or "(无输出)", flush=True)
    if r.stderr.strip():
        print("  stderr:", r.stderr.strip()[:300], flush=True)


threading.Thread(target=trigger, daemon=True).start()

print("--- 板子串口收到什么 ---", flush=True)
buf = b""
end = time.time() + CAPTURE
count = 0
while time.time() < end:
    n = s.in_waiting
    if n:
        buf += s.read(n)
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            txt = line.decode("utf-8", "replace").rstrip()
            if txt.strip():
                count += 1
                if count <= 20:
                    print("  " + txt[:118], flush=True)
    else:
        time.sleep(0.02)
print("  (共 %d 行)" % count, flush=True)
s.close()

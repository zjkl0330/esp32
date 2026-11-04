#!/usr/bin/env python
"""复位 ESP32 并抓取干净启动日志（先清缓冲，避开 CP210x 脏数据）。"""
import sys, time, serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM3"
secs = int(sys.argv[2]) if len(sys.argv) > 2 else 15

s = serial.Serial(port, 115200, timeout=0.2)

# --- 硬复位: DTR/RTS 脉冲 (自动复位电路) ---
s.setDTR(False)
s.setRTS(True)
time.sleep(0.15)
s.setRTS(False)
time.sleep(0.05)
s.setDTR(True)
time.sleep(0.05)
s.reset_input_buffer()
time.sleep(0.4)
s.reset_input_buffer()

print(f"--- reset & capture {secs}s on {port} ---", flush=True)
end = time.time() + secs
buf = b""
while time.time() < end:
    n = s.in_waiting
    if n:
        buf += s.read(n)
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            txt = line.decode("utf-8", "replace").rstrip("\r")
            if txt.strip():
                print(txt, flush=True)
    else:
        time.sleep(0.05)
s.close()
print("--- end ---", flush=True)

#!/usr/bin/env python3
"""
TLS 指纹探针（JA3）

为什么要自己做：
  公开的指纹查询服务（tls.peet.ws / browserleaks）在国内基本连不上，
  二手结论不可靠。JA3 的算法本身很简单 —— 就是对 ClientHello 里
  四个字段取 MD5：
    SSLVersion, Ciphers, Extensions, EllipticCurves, EllipticCurvePointFormats

  所以直接在 TCP 层读 ClientHello 字节自己算最可靠。

用法：
  python ja3-probe.py 8443 cert.pem key.pem

它会：
  1. 读 ClientHello，算出 JA3 指纹
  2. 完成握手，返回一个最小 HTTP 响应
  3. 打印 JA3 各字段，便于对比
"""
import hashlib
import socket
import ssl
import struct
import sys
import threading

GREASE = {0x0A0A, 0x1A1A, 0x2A2A, 0x3A3A, 0x4A4A, 0x5A5A, 0x6A6A, 0x7A7A,
          0x8A8A, 0x9A9A, 0xAAAA, 0xBABA, 0xCACA, 0xDADA, 0xEAEA, 0xFAFA}


def parse_client_hello(data):
    """从 TCP 前缀里解出 ClientHello，返回 (ja3字符串, 明细dict)"""
    # TLS record: type(1) version(2) length(2)
    if len(data) < 5 or data[0] != 0x16:
        return None, None
    # Handshake: type(1) length(3)
    p = 5
    if data[p] != 0x01:
        return None, None
    p += 4

    ver = struct.unpack('>H', data[p:p + 2])[0]
    p += 2
    p += 32  # random

    sid_len = data[p]
    p += 1 + sid_len

    cs_len = struct.unpack('>H', data[p:p + 2])[0]
    p += 2
    ciphers = []
    for i in range(0, cs_len, 2):
        cs = struct.unpack('>H', data[p + i:p + i + 2])[0]
        if cs not in GREASE:
            ciphers.append(cs)
    p += cs_len

    comp_len = data[p]
    p += 1 + comp_len

    exts = []
    curves = []
    point_formats = []
    if p + 2 <= len(data):
        ext_total = struct.unpack('>H', data[p:p + 2])[0]
        p += 2
        end = min(p + ext_total, len(data))
        while p + 4 <= end:
            etype, elen = struct.unpack('>HH', data[p:p + 4])
            p += 4
            body = data[p:p + elen]
            p += elen
            if etype in GREASE:
                continue
            exts.append(etype)
            if etype == 10 and len(body) >= 2:      # supported_groups
                for i in range(0, len(body) - 1, 2):
                    g = struct.unpack('>H', body[i:i + 2])[0]
                    if g not in GREASE:
                        curves.append(g)
            elif etype == 11 and len(body) >= 1:    # ec_point_formats
                n = body[0]
                point_formats = list(body[1:1 + n])

    ja3_str = "{},{},{},{},{}".format(
        ver,
        "-".join(str(c) for c in ciphers),
        "-".join(str(e) for e in exts),
        "-".join(str(c) for c in curves),
        "-".join(str(f) for f in point_formats),
    )
    ja3 = hashlib.md5(ja3_str.encode()).hexdigest()

    detail = {
        "ssl_version": ver,
        "tls": "1.3" if ver == 772 else ("1.2" if ver == 771 else str(ver)),
        "ciphers": ciphers,
        "extensions": exts,
        "curves": curves,
        "point_formats": point_formats,
        "ja3_str": ja3_str,
        "ja3": ja3,
    }
    return ja3, detail


def handle(conn, addr, ctx):
    try:
        conn.settimeout(10)
        raw = b''
        detail = None
        # ClientHello 可能分片，多读几次直到能解析
        for _ in range(6):
            try:
                chunk = conn.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            raw += chunk
            ja3, detail = parse_client_hello(raw)
            if detail:
                break
        if not detail:
            print("[probe] 未能解析 ClientHello (%d 字节)" % len(raw), flush=True)
            return

        print("\n=== 来自 %s:%d 的 ClientHello ===" % (addr[0], addr[1]), flush=True)
        print("  TLS 版本   : %s" % detail["tls"], flush=True)
        print("  密码套件数 : %d" % len(detail["ciphers"]), flush=True)
        print("  扩展数     : %d" % len(detail["extensions"]), flush=True)
        print("  扩展列表   : %s" % detail["extensions"], flush=True)
        print("  曲线       : %s" % (detail["curves"] or "无"), flush=True)
        print("  点格式     : %s" % (detail["point_formats"] or "无"), flush=True)
        print("  JA3 字符串 : %s" % detail["ja3_str"], flush=True)
        print("  JA3 哈希   : %s" % detail["ja3"], flush=True)

        # 手动驱动握手：用 MemoryBIO 把已经读走的 ClientHello 喂回去，
        # 否则 wrap_socket 接手时流已经错位，握手必然失败。
        incoming = ssl.MemoryBIO()
        outgoing = ssl.MemoryBIO()
        sslobj = ctx.wrap_bio(incoming, outgoing, server_side=True)
        incoming.write(raw)

        def flush_out():
            while True:
                data = outgoing.read()
                if not data:
                    break
                conn.sendall(data)

        try:
            while True:
                try:
                    sslobj.do_handshake()
                    break
                except ssl.SSLWantReadError:
                    flush_out()
                    chunk = conn.recv(4096)
                    if not chunk:
                        raise RuntimeError("对端提前关闭")
                    incoming.write(chunk)
            flush_out()
            req = sslobj.read(4096)
            body = b'{"ok":true}'
            resp = (
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                b"Content-Length: " + str(len(body)).encode() + b"\r\n"
                b"Connection: close\r\n\r\n" + body
            )
            sslobj.write(resp)
            flush_out()
            print("[probe] 握手完成，已返回 200", flush=True)
        except Exception as e:
            print("[probe] 握手阶段: %s" % e, flush=True)
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
    cert = sys.argv[2] if len(sys.argv) > 2 else "cert.pem"
    key = sys.argv[3] if len(sys.argv) > 3 else "key.pem"

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    try:
        ctx.set_alpn_protocols(['http/1.1'])
    except Exception:
        pass

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(8)
    print("[probe] 监听 0.0.0.0:%d" % port, flush=True)

    while True:
        conn, addr = srv.accept()
        threading.Thread(target=handle, args=(conn, addr, ctx), daemon=True).start()


if __name__ == "__main__":
    main()

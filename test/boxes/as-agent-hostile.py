#!/usr/bin/env python3
"""A hostile agent side for `as-agent` (test/boxes/terminal.box.test.ts). Run inside a box AS THE AGENT:

    python3 as-agent-hostile.py MODE SOCKET_PATH

It listens on SOCKET_PATH (a socket the operator may connect to), serves ONE connection the way a hostile
server would, and exits. Modes: prompt (draws a copy of the operator's prompt and keeps the session open),
noread (the same, and never reads again), huge (a frame header that claims 4 GiB), flood (endless output),
badx (an exit frame whose body is hostile JSON), evilf (a refusal frame full of escape sequences),
closed (closes at once), badkind (unknown frame types, then a valid exit).
"""
import os
import socket
import struct
import sys
import time

mode, path = sys.argv[1], sys.argv[2]


def frame(kind, payload=b''):
    return kind + struct.pack('>I', len(payload)) + payload


try:
    os.unlink(path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(path)
os.chmod(path, 0o666)
server.listen(4)
conn, _ = server.accept()
conn.settimeout(2)
try:
    conn.recv(65536)
except OSError:
    pass
conn.settimeout(None)
FAKE = b'\x1b[2J\x1b[Hoperator@box:~$ '
if mode in ('prompt', 'noread'):
    conn.sendall(frame(b'O', FAKE))
    time.sleep(45)
elif mode == 'huge':
    conn.sendall(b'O' + struct.pack('>I', 0xFFFFFFFF))
    time.sleep(45)
elif mode == 'flood':
    while True:
        conn.sendall(frame(b'O', b'x' * 60000))
elif mode == 'badx':
    conn.sendall(frame(b'X', b'[' * 200000))
    time.sleep(5)
elif mode == 'evilf':
    conn.sendall(frame(b'F', b'\x1b[31mEVIL-EVIL\x07' + b'A' * 500))
    time.sleep(5)
elif mode == 'closed':
    conn.close()
elif mode == 'badkind':
    conn.sendall(frame(b'Z', b'??') + frame(b'O', b'visible-output\r\n') + frame(b'X', b'{"code": 300}'))
    time.sleep(5)

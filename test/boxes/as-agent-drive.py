#!/usr/bin/env python3
"""Drives `as-agent` on a terminal as the OPERATOR against a socket of the test's choosing (test/boxes/terminal.box.test.ts).

    python3 as-agent-drive.py ACTION SOCKET_PATH

ACTION: wait (type nothing), escape (type Enter, ~, . once the banner is up), paste (type 3 MiB).
Prints one JSON line: whether the client exited, its status, how long it took and what it printed.
"""
import json
import os
import pty
import select
import sys
import time

action, sock = sys.argv[1], sys.argv[2]
env = {'PATH': '/opt/agora/bin:/usr/bin:/bin', 'TERM': 'xterm', 'HOME': '/home/operator', 'AGORA_AS_AGENT_SOCKET': sock}
pid, fd = pty.fork()
if pid == 0:
    os.execve('/usr/bin/python3', ['python3', '-I', '/usr/local/bin/as-agent', 'echo', 'hi'], env)
out = b''
start = time.time()
sent = False
status = None
paste = b'a' * (3 << 20)
while time.time() - start < 25 and status is None:
    r, w, _ = select.select([fd], [fd] if (action == 'paste' and sent and paste) else [], [], 0.2)
    if r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if data:
            out += data
            out = out[-20000:]
    if w and paste:
        try:
            n = os.write(fd, paste[:65536])
            paste = paste[n:]
        except OSError:
            paste = b''
    if not sent and b'AGENT SIDE' in out:
        time.sleep(1.0)       # as-agent drops keys typed in its first half second
        if action == 'escape':
            os.write(fd, b'\r~.')
        sent = True
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st)
        # what it printed last is still in the terminal's buffer
        end = time.time() + 0.5
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if not r:
                break
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out += data
if status is None:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
print(json.dumps({'exited': status is not None, 'status': status, 'seconds': round(time.time() - start, 1), 'output': out.decode('latin1')[-3000:]}))

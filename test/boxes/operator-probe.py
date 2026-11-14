#!/usr/bin/env python3
"""What the AGENT (uid 1000) tries against the OPERATOR's processes in a box (test/boxes/terminal.box.test.ts).

Run inside a box as the agent: python3 - RELAY_PID SHELL_PID PTY_PATH < operator-probe.py, with the relay credential's secret in the SECRET
environment variable. Prints one JSON object: attempt name -> "denied: <errno name>" or "ALLOWED: <detail>".
Every entry must say denied, except the cmdline ones, readable by design (they hold no secret).
Nothing here is destructive when it is denied; a signal that is not denied would have been delivered,
which is the failure the test reports.
"""
import ctypes
import errno
import json
import os
import signal
import sys

relay_pid, shell_pid, pty_path = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
secret = os.environ.get('SECRET', '')
out = {}


def attempt(name, fn):
    try:
        detail = fn()
        out[name] = 'ALLOWED: %s' % (str(detail)[:120],)
    except OSError as e:
        out[name] = 'denied: %s' % errno.errorcode.get(e.errno, e.errno)
    except Exception as e:  # noqa: BLE001
        out[name] = 'error: %s' % (type(e).__name__,)


def read(path, n=64):
    with open(path, 'rb') as f:
        return f.read(n)


libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
libc.ptrace.restype = ctypes.c_long


def ptrace(request, pid):
    r = libc.ptrace(request, pid, None, None)
    if r == -1:
        raise OSError(ctypes.get_errno(), 'ptrace')
    return 'ptrace %d on %d returned %d' % (request, pid, r)


def kill(pid, sig):
    os.kill(pid, sig)
    return 'signal %d delivered to %d' % (sig, pid)


def opens(path, flags):
    fd = os.open(path, flags | os.O_NOCTTY)
    os.close(fd)
    return 'opened %s' % path


for label, pid in (('shell', shell_pid), ('relay', relay_pid)):
    p = '/proc/%d' % pid
    attempt('%s: read environ' % label, lambda p=p: read(p + '/environ'))
    attempt('%s: read mem' % label, lambda p=p: read(p + '/mem'))
    attempt('%s: read maps' % label, lambda p=p: read(p + '/maps'))
    attempt('%s: list fd' % label, lambda p=p: os.listdir(p + '/fd'))
    attempt('%s: read fd/0' % label, lambda p=p: read(p + '/fd/0'))
    attempt('%s: readlink cwd' % label, lambda p=p: os.readlink(p + '/cwd'))
    attempt('%s: readlink exe' % label, lambda p=p: os.readlink(p + '/exe'))
    attempt('%s: read io' % label, lambda p=p: read(p + '/io'))
    attempt('%s: ptrace attach' % label, lambda pid=pid: ptrace(16, pid))      # PTRACE_ATTACH
    attempt('%s: ptrace seize' % label, lambda pid=pid: ptrace(0x4206, pid))   # PTRACE_SEIZE
    for name, sig in (('SIGSTOP', signal.SIGSTOP), ('SIGHUP', signal.SIGHUP), ('SIGTERM', signal.SIGTERM), ('SIGKILL', signal.SIGKILL), ('signal 0', 0)):
        attempt('%s: %s' % (label, name), lambda pid=pid, sig=sig: kill(pid, sig))

# The shell's terminal: neither end of it
attempt('pty: open for reading', lambda: opens(pty_path, os.O_RDONLY))
attempt('pty: open for writing', lambda: opens(pty_path, os.O_WRONLY))
attempt('pty: open read-write (TIOCSTI needs an open descriptor)', lambda: opens(pty_path, os.O_RDWR))


def tiocsti():
    import fcntl
    fd = os.open(pty_path, os.O_RDWR | os.O_NOCTTY)
    try:
        fcntl.ioctl(fd, 0x5412, b'x')   # TIOCSTI
    finally:
        os.close(fd)
    return 'TIOCSTI on %s' % pty_path


attempt('pty: TIOCSTI', tiocsti)

# The operator's home and the relay's credential
attempt('operator home: list', lambda: os.listdir('/home/operator'))
attempt('operator home: open a file', lambda: read('/home/operator/.bash_history'))
attempt('PID 1 environment (holds the credential)', lambda: read('/proc/1/environ'))
attempt('PID 1 memory', lambda: read('/proc/1/mem'))
attempt('PID 1: ptrace attach', lambda: ptrace(16, 1))
attempt('PID 1: SIGKILL', lambda: kill(1, signal.SIGKILL))
attempt('PID 1: SIGTERM', lambda: kill(1, signal.SIGTERM))


def hunt():
    """Count every readable place the relay credential's secret appears: every process's environment and command line, and every file under the places a box writes."""
    if not secret:
        return 'no secret given'
    needle = secret.encode()
    hits = []
    for entry in os.listdir('/proc'):
        # (the probe's own environment carries the needle it was given)
        if not entry.isdigit() or entry == str(os.getpid()):
            continue
        for part in ('environ', 'cmdline'):
            try:
                if needle in read('/proc/%s/%s' % (entry, part), 1 << 20):
                    hits.append('/proc/%s/%s' % (entry, part))
            except OSError:
                pass
    for root in ('/run', '/tmp', '/home/agent', '/opt/agora', '/etc', '/var'):
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                path = os.path.join(dirpath, name)
                try:
                    if os.path.islink(path) or os.path.getsize(path) > 8 << 20:
                        continue
                    if needle in read(path, 8 << 20):
                        hits.append(path)
                except OSError:
                    pass
    return hits


found = hunt()
out['credential found where the agent can read: %s' % ('nowhere' if found == [] else found)] = 'denied: none' if found == [] else 'ALLOWED: %s' % found

# What the agent may see, by design: the command line of another user's process (no secret in it)
try:
    out['(readable by design) shell cmdline'] = read('/proc/%d/cmdline' % shell_pid, 400).replace(b'\0', b' ').decode('utf8', 'replace')
    out['(readable by design) relay cmdline'] = read('/proc/%d/cmdline' % relay_pid, 400).replace(b'\0', b' ').decode('utf8', 'replace')
except OSError as e:
    out['(readable by design) cmdline'] = 'denied: %s' % errno.errorcode.get(e.errno, e.errno)
print(json.dumps(out))

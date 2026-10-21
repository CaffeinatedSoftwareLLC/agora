#!/usr/bin/env python3
"""Seed and verify a disposable Agora instance over its HTTP API (stdlib only).

  opsapi.py seed   --base URL --env ENVFILE --manifest OUT.json
  opsapi.py verify --base URL --env ENVFILE --manifest IN.json [--no-write] [--report OUT.json]
  opsapi.py provider-test --base URL --env ENVFILE --manifest IN.json [--expect decrypts|decrypt-error]

Every call also takes --state DIR (lib.sh passes e2e/ops/.state); env, manifest and report
paths must resolve inside it.

Fake data only: users ops-owner / ops-member, a provider whose key is a CANARY string and
whose base URL is a dead loopback port inside the API container (so a provider test proves
the key decrypts without anything leaving the container). Passwords come from the env file
and are never printed; the manifest holds ids, hashes and the fake canary key.
"""
import argparse
import hashlib
import json
import os
import struct
import sys
import urllib.error
import urllib.request
import uuid
import zlib

DECRYPT_ERROR = 'Stored API key could not be decrypted'
# The seeded provider: openai adapter on a loopback port that fetch refuses before connecting.
# Only adapter.testConnection can answer DEAD_PORT_BODY, and the test route checks the adapter,
# the base URL and decrypts the key before calling it (src/routes/ai-providers.ts).
PROVIDER_ADAPTER = 'openai'
DEAD_BASE_URL = 'http://127.0.0.1:9/v1'
DEAD_PORT_BODY = {'ok': False, 'error': 'fetch failed (bad port)'}
DECRYPT_ERROR_BODY = {'ok': False, 'error': DECRYPT_ERROR}
ALLOWED_BASES = ('http://127.0.0.1:3300', 'http://127.0.0.1:3400')


class Api:
    def __init__(self, base, auth=None):
        self.base = base.rstrip('/')
        self.auth = auth

    def with_auth(self, auth):
        return Api(self.base, auth)

    def raw(self, method, path, body=None, content_type=None):
        headers = {}
        if self.auth:
            headers['Authorization'] = self.auth
        data = None
        if body is not None:
            if isinstance(body, (bytes, bytearray)):
                data = bytes(body)
                headers['Content-Type'] = content_type
            else:
                data = json.dumps(body).encode()
                headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def req(self, method, path, body=None):
        status, raw = self.raw(method, path, body)
        try:
            data = json.loads(raw) if raw else None
        except ValueError:
            data = raw.decode(errors='replace')
        return status, data, raw

    def ok(self, method, path, body=None, expect=(200, 201, 204)):
        status, data, _ = self.req(method, path, body)
        if status not in expect:
            raise RuntimeError(f'{method} {path} -> {status} {json.dumps(data)[:300]}')
        return data

    def upload(self, channel_id, filename, content, mime):
        boundary = uuid.uuid4().hex
        parts = [
            f'--{boundary}\r\nContent-Disposition: form-data; name="channel_id"\r\n\r\n{channel_id}\r\n'.encode(),
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f'Content-Type: {mime}\r\n\r\n'.encode() + content + b'\r\n',
            f'--{boundary}--\r\n'.encode(),
        ]
        status, raw = self.raw('POST', '/files/upload', b''.join(parts), f'multipart/form-data; boundary={boundary}')
        if status != 201:
            raise RuntimeError(f'upload {filename} -> {status} {raw[:300]!r}')
        return json.loads(raw)


def read_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k] = v
    return env


def sha(b):
    return hashlib.sha256(b).hexdigest()


def png_bytes(seed):
    """A valid 32x32 RGB PNG whose pixels depend on `seed`."""
    w = h = 32
    rows = b''.join(b'\x00' + bytes(((x * 7 + y * 3 + seed) % 256) for x in range(w) for _ in range(3)) for y in range(h))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def login(api, user, password):
    status, data, _ = api.req('POST', '/auth/login', {'login': user, 'password': password})
    if status != 200 or not (data or {}).get('accessToken'):
        raise RuntimeError(f'login {user} -> {status}')
    return api.with_auth('Bearer ' + data['accessToken'])


def provider_test(owner, server_id, provider_id):
    status, data, _ = owner.req('POST', f'/servers/{server_id}/ai/providers/{provider_id}/test', {'model': 'gpt-ops-test'})
    return status, data


def decryption_proof(owner, server_id, provider_id):
    """(ok, detail): the provider is still the seeded openai one on the dead URL, and its
    test answers exactly DEAD_PORT_BODY. Preflight refusals (unknown adapter, base URL
    validation) and the decrypt error all fail this."""
    status, provs, _ = owner.req('GET', f'/servers/{server_id}/ai/providers')
    p = next((x for x in provs or [] if x.get('id') == provider_id), None) if status == 200 else None
    if not p or p.get('adapter') != PROVIDER_ADAPTER or p.get('baseUrl') != DEAD_BASE_URL or not p.get('hasApiKey'):
        return False, f'not the seeded {PROVIDER_ADAPTER} provider on {DEAD_BASE_URL}: {json.dumps(p) if p else status}'
    t_status, t_data = provider_test(owner, server_id, provider_id)
    return t_status == 200 and t_data == DEAD_PORT_BODY, f'HTTP {t_status} {json.dumps(t_data)}'


def seed(args):
    env = read_env(args.env)
    api = Api(args.base)
    tag = uuid.uuid4().hex[:6]
    api.ok('GET', '/health')
    st = api.ok('GET', '/instance/status')
    if not st.get('initialized'):
        api.ok('POST', '/instance/setup', {
            'setupToken': env['AGORA_SETUP_TOKEN'], 'username': 'ops-owner', 'email': 'ops-owner@example.test',
            'password': env['OPS_OWNER_PASSWORD'], 'instanceName': 'Agora Ops', 'registrationPolicy': 'open',
        }, expect=(201,))
    owner = login(api, 'ops-owner', env['OPS_OWNER_PASSWORD'])
    status, _, _ = api.req('POST', '/auth/register', {'username': 'ops-member', 'email': 'ops-member@example.test',
                                                      'password': env['OPS_MEMBER_PASSWORD']})
    if status not in (201, 409):
        raise RuntimeError(f'register ops-member -> {status}')
    member = login(api, 'ops-member', env['OPS_MEMBER_PASSWORD'])
    owner_id = owner.ok('GET', '/auth/session')['user']['id'].strip()
    member_id = member.ok('GET', '/auth/session')['user']['id'].strip()

    server_id = api.ok('GET', '/instance/status')['instanceServerId'].strip()
    channel_id = owner.ok('POST', f'/servers/{server_id}/channels', {'name': f'ops-data-{tag}', 'channelType': 3},
                          expect=(201,))['id'].strip()

    messages = []
    for i in range(4):
        who = member if i % 2 else owner
        content = f'OPS-MSG-{i}-{tag}: backup/restore fixture message {i}'
        m = who.ok('POST', f'/channels/{channel_id}/messages', {'content': content}, expect=(201,))
        messages.append({'id': m['id'].strip(), 'content': content, 'author': 'member' if i % 2 else 'owner'})

    specs = [
        (f'notes-{tag}.txt', ('Ops fixture text file.\n' * 120 + tag).encode(), 'text/plain'),
        (f'report-{tag}.md', ('# Report\n\n' + 'line of markdown\n' * 60).encode(), 'text/markdown'),
        (f'data-{tag}.json', json.dumps({'tag': tag, 'values': list(range(200))}).encode(), 'application/json'),
        (f'image-{tag}.png', png_bytes(7), 'image/png'),
        (f'table-{tag}.csv', ('a,b,c\n' + ''.join(f'{i},{i*i},{tag}\n' for i in range(150))).encode(), 'text/csv'),
        (f'image2-{tag}.png', png_bytes(91), 'image/png'),
    ]
    files = []
    for name, content, mime in specs:
        f = owner.upload(channel_id, name, content, mime)
        fid = f['id'].strip()
        m = owner.ok('POST', f'/channels/{channel_id}/messages',
                     {'content': f'OPS-FILE {name}', 'attachments': [fid]}, expect=(201,))
        status, raw = owner.raw('GET', f'/files/{fid}')
        if status != 200:
            raise RuntimeError(f'download {name} right after upload -> {status}')
        files.append({'id': fid, 'name': name, 'messageId': m['id'].strip(), 'uploadSha256': sha(content),
                      'sha256': sha(raw), 'size': len(raw)})

    # Encrypted provider config: fake key, dead loopback base URL inside the API container
    canary = f'sk-test-CANARY-{uuid.uuid4().hex}-SECRET'
    owner.ok('PATCH', '/admin/settings/ai', {'allowPrivateBaseUrls': True})
    prov = owner.ok('POST', f'/servers/{server_id}/ai/providers', {
        'adapter': PROVIDER_ADAPTER, 'label': f'ops-canary-{tag}', 'apiKey': canary, 'baseUrl': DEAD_BASE_URL,
    }, expect=(201,))
    provider_id = prov['id'].strip()
    t_status, t_data = provider_test(owner, server_id, provider_id)

    # Agent host, two profiles, sessions (no host process runs)
    host = owner.ok('POST', f'/servers/{server_id}/agent-hosts', {'name': f'ops-host-{tag}'}, expect=(201,))
    host_id = host['host']['id'].strip()
    agents = []
    for name, adapter in ((f'claude-ops-{tag}', 'claude'), (f'codex-ops-{tag}', 'codex')):
        r = owner.ok('POST', f'/servers/{server_id}/agents', {
            'name': name, 'adapter': adapter, 'hostId': host_id, 'workdirAlias': 'ops', 'channelId': channel_id,
        }, expect=(201,))
        agents.append({'name': name, 'adapter': adapter, 'profileId': r['profile']['id'].strip(), 'botId': r['bot']['id'].strip()})
    api.with_auth('AgentHost ' + host['token']).ok('POST', '/agent-hosts/@me/profiles', {'profiles': [
        {'name': agents[0]['name'], 'adapter': 'claude', 'authMode': 'api_key', 'apiKeyEnv': 'ANTHROPIC_API_KEY', 'runApproval': False},
        {'name': agents[1]['name'], 'adapter': 'codex', 'authMode': 'subscription', 'runApproval': False},
    ]})
    cmd = f'/channels/{channel_id}/agent-commands'
    owner.ok('POST', cmd, {'command': 'start', 'profile': agents[0]['name']}, expect=(200, 201, 202))
    owner.ok('POST', cmd, {'command': 'start', 'profile': agents[1]['name']}, expect=(200, 201, 202))
    owner.ok('POST', cmd, {'command': 'end', 'profile': agents[1]['name']}, expect=(200, 201, 202))
    sessions = [{'id': s['id'].strip(), 'state': s['state'], 'profile': s.get('profile')}
                for s in owner.ok('POST', cmd, {'command': 'sessions'})['sessions']]

    # #155: on servers before the fix, null limits were coerced to 0
    fs_status, fs_data, _ = owner.req('PATCH', '/admin/settings/files',
                                      {'files.retention_days': None, 'files.storage_quota_bytes': None})
    st_status, st_data, _ = owner.req('GET', '/admin/storage')

    manifest = {
        'tag': tag, 'base': args.base, 'serverId': server_id, 'channelId': channel_id,
        'users': {'owner': {'id': owner_id, 'username': 'ops-owner'}, 'member': {'id': member_id, 'username': 'ops-member'}},
        'messages': messages, 'files': files,
        'provider': {'id': provider_id, 'label': f'ops-canary-{tag}', 'canaryKey': canary,
                     'testAtSeed': {'status': t_status, 'body': t_data}},
        'hostId': host_id, 'agents': agents, 'sessions': sessions,
        'filesSettingsPatch': {'status': fs_status, 'body': fs_data},
        'storageStatsAtSeed': {'status': st_status, 'body': st_data},
    }
    with open(args.manifest, 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f'seeded: {len(messages)} messages, {len(files)} files, provider {provider_id}, '
          f'{len(agents)} profiles, {len(sessions)} sessions; provider test at seed: {t_status} {json.dumps(t_data)}')
    print(f'files settings PATCH: {fs_status}; GET /admin/storage: {st_status} {json.dumps(st_data)[:200]}')
    proved, detail = decryption_proof(owner, server_id, provider_id)
    if not proved:
        raise RuntimeError(f'decryption proof failed right after seeding: {detail}')


class Checks:
    def __init__(self):
        self.results = []

    def check(self, name, ok, detail=''):
        self.results.append({'check': name, 'ok': bool(ok), 'detail': detail})
        print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")

    @property
    def failed(self):
        return [r for r in self.results if not r['ok']]


def verify(args):
    env = read_env(args.env)
    man = json.load(open(args.manifest))
    api = Api(args.base)
    c = Checks()
    sid, ch = man['serverId'], man['channelId']

    st = api.ok('GET', '/instance/status')
    c.check('instance initialized', st.get('initialized') is True and st.get('instanceServerId', '').strip() == sid)
    try:
        owner = login(api, 'ops-owner', env['OPS_OWNER_PASSWORD'])
        member = login(api, 'ops-member', env['OPS_MEMBER_PASSWORD'])
        c.check('owner and member log in', True)
    except RuntimeError as e:
        c.check('owner and member log in', False, str(e))
        return finish(c, args)

    for who, cli in (('owner', owner), ('member', member)):
        status, msgs, _ = cli.req('GET', f'/channels/{ch}/messages?limit=100')
        if status != 200:
            c.check(f'{who} reads messages', False, f'HTTP {status} {json.dumps(msgs)[:200]}')
            continue
        by_id = {m['id'].strip(): m for m in msgs}
        missing = [m['id'] for m in man['messages'] if by_id.get(m['id'], {}).get('content') != m['content']]
        c.check(f'{who} reads {len(man["messages"])} seeded messages', not missing, f'missing/changed {missing}' if missing else f'{len(msgs)} in channel')
        att_ok = all(any((a.get('id') or '').strip() == f['id'] for a in (by_id.get(f['messageId']) or {}).get('attachments') or [])
                     for f in man['files'])
        c.check(f'{who} sees file attachments on their messages', att_ok)

    bad = []
    for f in man['files']:
        status, raw = member.raw('GET', f'/files/{f["id"]}')
        if status != 200 or sha(raw) != f['sha256']:
            bad.append(f'{f["name"]}: HTTP {status} sha={sha(raw)[:12] if status == 200 else "-"}')
    c.check(f'{len(man["files"])} files download and match sha256', not bad, '; '.join(bad))

    status, provs, raw = owner.req('GET', f'/servers/{sid}/ai/providers')
    p = next((x for x in provs or [] if x['id'] == man['provider']['id']), None) if status == 200 else None
    c.check('provider config present with hasApiKey', bool(p and p.get('hasApiKey')), json.dumps(p) if p else f'HTTP {status}')
    c.check('provider list never returns the key', man['provider']['canaryKey'].encode() not in raw)
    proved, detail = decryption_proof(owner, sid, man['provider']['id'])
    c.check(f'stored provider key decrypts (test answers exactly {json.dumps(DEAD_PORT_BODY)})', proved, detail)

    status, profs, _ = member.req('GET', f'/servers/{sid}/agent-profiles')
    names = {x.get('name') for x in profs} if status == 200 else set()
    want = {a['name'] for a in man['agents']}
    c.check('agent profiles present', want <= names, f'HTTP {status}, have {sorted(names & want)}')
    status, hosts, _ = owner.req('GET', f'/servers/{sid}/agent-hosts')
    c.check('agent host present', status == 200 and any(h['id'].strip() == man['hostId'] for h in hosts), f'HTTP {status}')
    status, sess, _ = owner.req('POST', f'/channels/{ch}/agent-commands', {'command': 'sessions'})
    have = {s['id'].strip(): s['state'] for s in (sess or {}).get('sessions', [])} if status == 200 else {}
    diff = [f'{s["id"]}:{s["state"]}->{have.get(s["id"])}' for s in man['sessions'] if have.get(s['id']) != s['state']]
    c.check(f'{len(man["sessions"])} agent sessions present with their state', not diff, '; '.join(diff) or ', '.join(f'{k}:{v}' for k, v in have.items()))

    st_status, st_data, _ = owner.req('GET', '/admin/storage')
    c.check('GET /admin/storage answers', st_status == 200, f'HTTP {st_status} {json.dumps(st_data)[:200]}')

    if not args.no_write:
        content = png_bytes(201)
        try:
            f = owner.upload(ch, f'after-{man["tag"]}.png', content, 'image/png')
            fid = f['id'].strip()
            owner.ok('POST', f'/channels/{ch}/messages', {'content': 'OPS-AFTER', 'attachments': [fid]}, expect=(201,))
            status, raw = member.raw('GET', f'/files/{fid}')
            c.check('new upload + message + download work', status == 200 and len(raw) > 0, f'HTTP {status}')
        except RuntimeError as e:
            c.check('new upload + message + download work', False, str(e))
    return finish(c, args)


def finish(c, args):
    if args.report:
        with open(args.report, 'w') as f:
            json.dump(c.results, f, indent=2)
    print(f'verify: {len(c.results) - len(c.failed)}/{len(c.results)} checks passed')
    return 1 if c.failed else 0


def cmd_provider_test(args):
    env = read_env(args.env)
    man = json.load(open(args.manifest))
    owner = login(Api(args.base), 'ops-owner', env['OPS_OWNER_PASSWORD'])
    if args.expect == 'decrypts':
        proved, detail = decryption_proof(owner, man['serverId'], man['provider']['id'])
    else:
        status, data = provider_test(owner, man['serverId'], man['provider']['id'])
        proved, detail = status == 200 and data == DECRYPT_ERROR_BODY, f'HTTP {status} {json.dumps(data)}'
    print(f"{'PASS' if proved else 'FAIL'} provider test answers as expected ({args.expect}): {detail}")
    return 0 if proved else 1


def cmd_approve_check(args):
    """#158 / migration 060: approving a pending user joins them to the instance server."""
    env = read_env(args.env)
    man = json.load(open(args.manifest))
    api = Api(args.base)
    owner = login(api, 'ops-owner', env['OPS_OWNER_PASSWORD'])
    c = Checks()
    owner.ok('PATCH', '/admin/instance', {'registrationPolicy': 'approval'})
    name = f'ops-pending-{uuid.uuid4().hex[:6]}'
    password = env['OPS_MEMBER_PASSWORD'] + '-p'
    reg = api.ok('POST', '/auth/register', {'username': name, 'email': f'{name}@example.test', 'password': password}, expect=(201,))
    uid = reg['user']['id'].strip()
    c.check('registration is pending under approval policy', reg.get('status') == 'pending')
    status, data, _ = owner.req('POST', f'/admin/approve-user/{uid}')
    c.check('admin approves the pending user', status == 200, f'HTTP {status} {json.dumps(data)[:200]}')
    owner.ok('PATCH', '/admin/instance', {'registrationPolicy': 'open'})
    try:
        user = login(api, name, password)
        status, _, _ = user.req('GET', f'/channels/{man["channelId"]}/messages?limit=1')
        c.check('approved user is a member of the instance server', status == 200, f'HTTP {status}')
    except RuntimeError as e:
        c.check('approved user is a member of the instance server', False, str(e))
    return finish(c, args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['seed', 'verify', 'provider-test', 'approve-check'])
    ap.add_argument('--base', required=True)
    ap.add_argument('--env', required=True)
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--report')
    ap.add_argument('--no-write', action='store_true')
    ap.add_argument('--expect', choices=['decrypts', 'decrypt-error'], default='decrypts')
    ap.add_argument('--state', required=True)
    args = ap.parse_args()
    if args.base.rstrip('/') not in ALLOWED_BASES:
        sys.exit(f'refusing base URL {args.base} (only the ops projects: {", ".join(ALLOWED_BASES)})')
    # Every file read or written must resolve inside e2e/ops/.state (symlinks resolved)
    state = os.path.realpath(args.state)
    for name in ('env', 'manifest', 'report'):
        value = getattr(args, name)
        if value is not None:
            real = os.path.realpath(value)
            if not real.startswith(state + os.sep):
                sys.exit(f'refusing --{name} {value}: outside {state}')
            setattr(args, name, real)
    if args.cmd == 'seed':
        seed(args)
        return 0
    if args.cmd == 'verify':
        return verify(args)
    if args.cmd == 'approve-check':
        return cmd_approve_check(args)
    return cmd_provider_test(args)


if __name__ == '__main__':
    sys.exit(main())

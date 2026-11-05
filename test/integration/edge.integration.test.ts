import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { config } from '../../src/config';
import { encryptString } from '../../src/lib/encryption';
import { verifyEdge } from '../../src/lib/boxes/contract';
import { decideEdgeRequest, type EdgeDecision } from '../../src/lib/boxes/edge-requests';
import type { BridgedEvent } from '../../src/lib/event-bridge';
import { createEdge, type Edge } from '../../src/boxes/edge/server';
import { silentLog } from '../../src/boxes/edge/common';
import { FLUSH, parseCommands, parseReport, pkt, type PushReport } from '../../src/boxes/edge/pktline';

/**
 * docs/agent-boxes.md §4, §5: the edge against a real database, a fake GitHub (git smart HTTP
 * and the REST API) and a fake Agora API.
 */

const SECRET = 'cd'.repeat(32);
const TOKEN = 'ghp_edge_test_token';
const sha = (c: string) => c.repeat(40);
const Z = sha('0');

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let boxId: string;
let edge: Edge;
let edgePort: number;
let proxyPort: number;
const published: BridgedEvent[] = [];

// ─── Fake GitHub ───
interface GhRequest { method: string; url: string; headers: http.IncomingHttpHeaders }
const gh = {
    refs: new Map<string, string>(),
    defaultBranch: 'main',
    requests: [] as GhRequest[],
    receivePacks: 0,
    /** normal | drop-before | drop-after | drop-first-only | reject:<ref> */
    receiveMode: 'normal',
    receiveDelayMs: 0,
    infoRefsRedirect: false,
    prs: [] as any[],
    prHeadOverride: null as string | null,
    prCreates: 0,
};
let ghServer: http.Server;
const fakeSockets = new Set<net.Socket>();
const trackSockets = (server: http.Server) => server.on('connection', s => { fakeSockets.add(s); s.on('close', () => fakeSockets.delete(s)); });
let ghBase: string;

function advertisement(service: string): Buffer {
    const refs = [...gh.refs.entries()];
    const lines = refs.length === 0
        ? [pkt(`${Z} capabilities^{}\0report-status delete-refs side-band-64k\n`)]
        : refs.map(([ref, oid], i) => pkt(i === 0 ? `${oid} ${ref}\0report-status delete-refs side-band-64k\n` : `${oid} ${ref}\n`));
    return Buffer.concat([pkt(`# service=${service}\n`), FLUSH, ...lines, FLUSH]);
}

async function readAll(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
}

function ghHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    gh.requests.push({ method: req.method!, url: req.url!, headers: req.headers });
    void (async () => {
        const url = new URL(req.url!, 'http://gh');
        const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (url.pathname.endsWith('/info/refs')) {
            if (gh.infoRefsRedirect) { res.writeHead(302, { location: 'http://elsewhere.example/x' }); return res.end(); }
            const service = url.searchParams.get('service')!;
            res.writeHead(200, { 'content-type': `application/x-${service}-advertisement` });
            return res.end(advertisement(service));
        }
        if (url.pathname.endsWith('/git-upload-pack')) {
            await readAll(req);
            res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
            return res.end('PACK-FROM-GITHUB');
        }
        if (url.pathname.endsWith('/git-receive-pack')) {
            gh.receivePacks++;
            const body = await readAll(req);
            if (gh.receiveDelayMs) await new Promise(r => setTimeout(r, gh.receiveDelayMs));
            const parsed = parseCommands(body);
            if (parsed.state !== 'done') { res.writeHead(400); return res.end('bad'); }
            if (gh.receiveMode === 'drop-before') return req.socket.destroy();
            const lines: Buffer[] = [pkt('unpack ok\n')];
            parsed.commands.forEach((c, i) => {
                const now = gh.refs.get(c.ref) ?? Z;
                const reject = gh.receiveMode === `reject:${c.ref}`;
                if (now !== c.old || reject || (gh.receiveMode === 'drop-first-only' && i > 0)) { lines.push(pkt(`ng ${c.ref} ${reject ? 'hook declined' : 'stale info'}\n`)); return; }
                if (/^0+$/.test(c.new)) gh.refs.delete(c.ref); else gh.refs.set(c.ref, c.new);
                lines.push(pkt(`ok ${c.ref}\n`));
            });
            if (gh.receiveMode.startsWith('drop')) return req.socket.destroy();
            const report = Buffer.concat([...lines, FLUSH]);
            const sideband = parsed.capabilities.includes('side-band-64k');
            res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
            return res.end(sideband ? Buffer.concat([pkt(Buffer.concat([Buffer.from([2]), Buffer.from('remote progress\n')])), pkt(Buffer.concat([Buffer.from([1]), report])), FLUSH]) : report);
        }
        let m: RegExpExecArray | null;
        if ((m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname))) return json(200, { full_name: `${m[1]}/${m[2]}`, default_branch: gh.defaultBranch });
        if ((m = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/.exec(url.pathname))) {
            const oid = gh.refs.get(`refs/heads/${decodeURIComponent(m[1])}`);
            return oid ? json(200, { ref: `refs/heads/${m[1]}`, object: { sha: oid, type: 'commit' } }) : json(404, { message: 'Not Found' });
        }
        if (/^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname) && req.method === 'GET') {
            const head = url.searchParams.get('head')?.split(':')[1]; const base = url.searchParams.get('base');
            return json(200, gh.prs.filter(p => (!head || p.head.ref === head) && (!base || p.base.ref === base) && p.state === 'open'));
        }
        if (/^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname) && req.method === 'POST') {
            gh.prCreates++;
            const input = JSON.parse((await readAll(req)).toString());
            const pr = {
                number: gh.prs.length + 1, state: 'open', title: input.title, draft: input.draft,
                html_url: `https://github.com/acme/widget/pull/${gh.prs.length + 1}`,
                head: { ref: input.head, sha: gh.prHeadOverride ?? gh.refs.get(`refs/heads/${input.head}`) }, base: { ref: input.base },
            };
            gh.prs.push(pr);
            return json(201, pr);
        }
        if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url.pathname)) return json(200, gh.prs[0] ?? {});
        json(404, { message: 'Not Found' });
    })().catch(() => res.destroy());
}

// ─── Fake Agora API ───
let apiServer: http.Server;
let apiSeen: http.IncomingHttpHeaders[] = [];
let upgradeSeen: http.IncomingHttpHeaders | null = null;
const afterRefusal: string[] = [];

/** Send raw bytes to the edge's :8080 and collect everything until it closes the connection. */
function rawToEdge(bytes: string, onData?: (buf: string, s: net.Socket) => void): Promise<string> {
    return new Promise((resolve, reject) => {
        const s = net.connect(edgePort, '127.0.0.1', () => s.write(bytes));
        let buf = '';
        const timer = setTimeout(() => { s.destroy(); reject(new Error('the edge left the connection open')); }, 5000);
        s.on('data', d => { buf += d.toString('latin1'); onData?.(buf, s); });
        s.on('close', () => { clearTimeout(timer); resolve(buf); });
        s.on('error', () => {});
    });
}

// ─── Helpers ───
async function inTx<T>(fn: (c: any) => Promise<T>): Promise<T> {
    const c = await ctx.db.connect();
    try {
        await c.query('BEGIN');
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
    } catch (err) {
        await c.query('ROLLBACK');
        throw err;
    } finally { c.release(); }
}
const decide = (id: string, decision: EdgeDecision) => inTx(c => decideEdgeRequest(c, id, decision, owner.userId));

async function requests(kind?: string) {
    return (await ctx.db.query(`SELECT id, kind, status, subject, result FROM box_edge_requests WHERE box_id = $1 ${kind ? 'AND kind = $2' : ''} ORDER BY created_at, id`,
        kind ? [boxId, kind] : [boxId])).rows.map(r => ({ ...r, id: r.id.trim() }));
}

function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: Buffer | string; port?: number } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: opts.port ?? edgePort, method, path, headers: opts.headers, agent: false }, res => {
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end(opts.body);
    });
}

const RP = '/git/github.com/acme/widget.git/git-receive-pack';
async function push(cmds: [string, string, string][], sideband = true): Promise<{ status: number; report: PushReport | null; raw: Buffer }> {
    const caps = `report-status${sideband ? ' side-band-64k' : ''} agent=git/2.43.0`;
    const body = Buffer.concat([
        ...cmds.map(([o, n, r], i) => pkt(i === 0 ? `${o} ${n} ${r}\0${caps}\n` : `${o} ${n} ${r}\n`)),
        FLUSH, Buffer.from('PACK\x00\x00\x00\x02fake-pack-bytes'),
    ]);
    const res = await call('POST', RP, { headers: { 'content-type': 'application/x-git-receive-pack-request' }, body });
    return { status: res.status, report: res.status === 200 ? parseReport(res.body, sideband) : null, raw: res.body };
}

const setPolicy = (autoPush: boolean, autoPr = false) => ctx.db.query(
    `INSERT INTO box_push_policies (box_id, channel_id, auto_push, auto_pr) VALUES ($1, $2, $3, $4)
     ON CONFLICT (box_id, channel_id) DO UPDATE SET auto_push = $3, auto_pr = $4`, [boxId, channelId, autoPush, autoPr]);

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'edgeowner');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'Edge Server'));

    const hostId = generateUlid(); const profileId = generateUlid(); boxId = generateUlid();
    await ctx.db.query(`INSERT INTO agent_hosts (id, server_id, name, secret_hash, kind) VALUES ($1, $2, 'box-host', 'x', 'box')`, [hostId, serverId]);
    await ctx.db.query(`INSERT INTO agent_profiles (id, server_id, name, bot_id, host_id, adapter, workdir_alias) VALUES ($1, $2, 'edgebox', $3, $4, 'claude', 'work')`,
        [profileId, serverId, owner.userId, hostId]);
    await ctx.db.query(
        `INSERT INTO agent_boxes (id, server_id, profile_id, host_id, home_channel_id, generation, subnet, allowed_domains, state)
         VALUES ($1, $2, $3, $4, $5, 4, '10.213.0.16/28', ARRAY['allowed.example.com'], 'running')`,
        [boxId, serverId, profileId, hostId, channelId]
    );
    await ctx.db.query(`INSERT INTO box_repos (box_id, owner, repo) VALUES ($1, 'acme', 'widget')`, [boxId]);
    const enc = encryptString(TOKEN, config.encryptionKey);
    await ctx.db.query(`INSERT INTO box_github_credentials (server_id, token_enc, token_iv, token_tag) VALUES ($1, $2, $3, $4)`, [serverId, enc.encrypted, enc.iv, enc.authTag]);

    ghServer = http.createServer(ghHandler);
    trackSockets(ghServer);
    await new Promise<void>(r => ghServer.listen(0, '127.0.0.1', r));
    ghBase = `http://127.0.0.1:${(ghServer.address() as AddressInfo).port}`;

    apiServer = http.createServer((req, res) => { apiSeen.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url })); });
    apiServer.on('upgrade', (req, socket) => {
        upgradeSeen = req.headers;
        if (req.url === '/refuse') {
            // Refuse but keep the connection: whatever the edge still sends would arrive here
            socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
            socket.on('data', d => { afterRefusal.push(d.toString('latin1')); });
            return;
        }
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        socket.on('data', d => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
    });
    trackSockets(apiServer);
    await new Promise<void>(r => apiServer.listen(0, '127.0.0.1', r));

    edge = createEdge({
        db: ctx.db, publish: async events => { published.push(...events); }, encryptionKey: config.encryptionKey, edgeSecret: SECRET,
        apiUpstream: `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`,
        githubBase: ghBase, githubApiBase: ghBase, log: silentLog,
        // Listeners on 127.0.0.1: every connection is this box
        identify: async () => edge.directory.byId(boxId), directoryTtlMs: 0,
        resolve: async () => ['93.184.216.34'], subnets: () => [],
        dial: () => net.connect({ host: '127.0.0.1', port: 9 }),
        // A login's request waits for its card this long, looking this often
        loginHoldMs: 1500, loginHoldPollMs: 50,
    });
    await edge.start({ agora: 0, proxy: 0, host: '127.0.0.1' });
    edgePort = (edge.agora.address() as AddressInfo).port;
    proxyPort = (edge.proxy.address() as AddressInfo).port;
});

afterAll(async () => {
    await edge?.close(1000);
    // Upgraded sockets aren't the HTTP server's to close
    for (const s of fakeSockets) s.destroy();
    for (const s of [ghServer, apiServer]) await new Promise<void>(r => s.close(() => r()));
    await ctx.close();
});

beforeEach(async () => {
    await ctx.db.query('TRUNCATE box_edge_requests, box_push_policies');
    await ctx.db.query(`UPDATE box_repos SET default_branch = NULL, default_checked_at = NULL WHERE box_id = $1`, [boxId]);
    gh.refs = new Map([['refs/heads/main', sha('1')]]);
    gh.requests = []; gh.receivePacks = 0; gh.receiveMode = 'normal'; gh.receiveDelayMs = 0; gh.infoRefsRedirect = false;
    gh.prs = []; gh.prHeadOverride = null; gh.prCreates = 0;
    published.length = 0;
});

describe('git fetch', () => {
    it('forwards info/refs and upload-pack for an attached repo with the owner\'s token', async () => {
        const refs = await call('GET', '/git/github.com/acme/widget.git/info/refs?service=git-upload-pack', { headers: { 'user-agent': 'git/2.43.0' } });
        expect(refs.status).toBe(200);
        expect(refs.body.toString()).toContain('refs/heads/main');
        const pack = await call('POST', '/git/github.com/acme/widget.git/git-upload-pack', { body: '0000', headers: { 'content-type': 'application/x-git-upload-pack-request' } });
        expect(pack.body.toString()).toBe('PACK-FROM-GITHUB');
        const auth = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
        expect(gh.requests.map(r => [r.method, r.url, r.headers.authorization])).toEqual([
            ['GET', '/acme/widget.git/info/refs?service=git-upload-pack', auth],
            ['POST', '/acme/widget.git/git-upload-pack', auth],
        ]);
    });

    it('matches the attached repo without regard to case and uses the stored spelling upstream', async () => {
        expect((await call('GET', '/git/github.com/ACME/Widget.git/info/refs?service=git-upload-pack')).status).toBe(200);
        expect(gh.requests[0].url).toBe('/acme/widget.git/info/refs?service=git-upload-pack');
    });

    it('404s unattached repos and odd paths before anything reaches GitHub', async () => {
        for (const path of [
            '/git/github.com/acme/other.git/info/refs?service=git-upload-pack',
            '/git/github.com/acme/widget.git/../../x/info/refs?service=git-upload-pack',
            '/git/github.com/acme%2fwidget.git/info/refs?service=git-upload-pack',
            '/git/github.com/acme/wid%2567et.git/info/refs?service=git-upload-pack',
            '/git/gitlab.com/acme/widget.git/info/refs?service=git-upload-pack',
            '/git/github.com/acme/widget.git/HEAD',
            '/github/repos/acme/widget/contents/x',
            '/github/repos/acme/other/pulls',
        ]) expect((await call('GET', path)).status, path).toBe(404);
        expect(gh.requests).toHaveLength(0);
    });

    it('never follows a redirect with credentials: 502', async () => {
        gh.infoRefsRedirect = true;
        const res = await call('GET', '/git/github.com/acme/widget.git/info/refs?service=git-receive-pack');
        expect(res.status).toBe(502);
        expect(gh.requests).toHaveLength(1);
    });
});

describe('git push', () => {
    it('an unauthorized push is not forwarded: ng report, a pending request and a card', async () => {
        const res = await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        expect(res.status).toBe(200);
        expect(res.raw.toString()).toContain('Agora: this push waits');
        const [req] = await requests('push');
        expect(req.status).toBe('pending');
        expect(req.subject.commands).toEqual([[sha('1'), sha('2'), 'refs/heads/main']]);
        expect(res.report!.unpackOk).toBe(true);
        expect(res.report!.ng.get('refs/heads/main')).toBe(`push needs the owner's approval (request ${req.id}); push again after it's approved`);
        expect(gh.receivePacks).toBe(0);
        expect(published.some(e => e.event === 'Message' && (e.data as any).systemEvent === 'box_edge_request')).toBe(true);
        // Same push again: the same request, no second card
        published.length = 0;
        await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        expect(await requests('push')).toHaveLength(1);
        expect(published).toHaveLength(0);
    });

    it('a plain (no side-band) refusal report is valid too', async () => {
        const res = await push([[sha('1'), sha('2'), 'refs/heads/main']], false);
        expect(res.report!.ng.has('refs/heads/main')).toBe(true);
    });

    it('auto-allow forwards a new branch, reading the default branch from GitHub', async () => {
        await setPolicy(true);
        const res = await push([[Z, sha('3'), 'refs/heads/feature']]);
        expect(res.report!.ok.has('refs/heads/feature')).toBe(true);
        expect(gh.refs.get('refs/heads/feature')).toBe(sha('3'));
        expect(gh.requests.some(r => r.url === '/repos/acme/widget')).toBe(true);
        expect((await ctx.db.query('SELECT default_branch FROM box_repos WHERE box_id = $1', [boxId])).rows[0].default_branch).toBe('main');
        expect(await requests('push')).toHaveLength(0);
    });

    it('mixed authorized and unauthorized refs: nothing is forwarded', async () => {
        await setPolicy(true);
        const res = await push([[Z, sha('3'), 'refs/heads/feature'], [sha('1'), sha('2'), 'refs/heads/main']]);
        expect([...res.report!.ng.keys()].sort()).toEqual(['refs/heads/feature', 'refs/heads/main']);
        expect(gh.receivePacks).toBe(0);
        expect(gh.refs.has('refs/heads/feature')).toBe(false);
        const [req] = await requests('push');
        expect(req.subject.commands).toHaveLength(2);
    });

    it('deletes, tags and the default branch are never auto-allowed', async () => {
        await setPolicy(true);
        gh.refs.set('refs/heads/old', sha('4'));
        for (const cmd of [[sha('4'), Z, 'refs/heads/old'], [Z, sha('5'), 'refs/tags/v1'], [sha('1'), sha('6'), 'refs/heads/main']] as [string, string, string][]) {
            const res = await push([cmd]);
            expect(res.report!.ng.has(cmd[2]), cmd[2]).toBe(true);
        }
        expect(gh.receivePacks).toBe(0);
        expect(await requests('push')).toHaveLength(3);
    });

    it('an approval matches only the exact command set, and is used once', async () => {
        await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        const [req] = await requests('push');
        await decide(req.id, 'allow');

        // A superset is a different push
        const bigger = await push([[sha('1'), sha('2'), 'refs/heads/main'], [Z, sha('3'), 'refs/heads/extra']]);
        expect(bigger.report!.ng.size).toBe(2);
        // Different new SHA: different push
        await push([[sha('1'), sha('7'), 'refs/heads/main']]);
        expect(gh.receivePacks).toBe(0);

        const exact = await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        expect(exact.report!.ok.has('refs/heads/main')).toBe(true);
        expect(gh.refs.get('refs/heads/main')).toBe(sha('2'));
        expect((await requests('push')).find(r => r.id === req.id)!.status).toBe('used');

        // Replay: refused, nothing forwarded
        const replay = await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        expect(replay.report!.ng.has('refs/heads/main')).toBe(true);
        expect(gh.receivePacks).toBe(1);
    });

    it('an approval for another generation is not used', async () => {
        await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        const [req] = await requests('push');
        await decide(req.id, 'allow');
        await ctx.db.query('UPDATE box_edge_requests SET generation = 3 WHERE id = $1', [req.id]);
        const res = await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        expect(res.report!.ng.has('refs/heads/main')).toBe(true);
        expect(gh.receivePacks).toBe(0);
    });

    it('two concurrent pushes on one approval: exactly one is forwarded', async () => {
        await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        const [req] = await requests('push');
        await decide(req.id, 'allow');
        gh.receiveDelayMs = 300;
        const [a, b] = await Promise.all([push([[sha('1'), sha('2'), 'refs/heads/main']]), push([[sha('1'), sha('2'), 'refs/heads/main']])]);
        expect(gh.receivePacks).toBe(1);
        const oks = [a, b].filter(r => r.report?.ok.has('refs/heads/main'));
        expect(oks).toHaveLength(1);
        expect((await requests('push')).find(r => r.id === req.id)!.status).toBe('used');
    });

    async function approved(cmds: [string, string, string][]) {
        await push(cmds);
        const req = (await requests('push')).find(r => r.status === 'pending')!;
        await decide(req.id, 'allow');
        return req.id;
    }

    it('ambiguous outcome, refs read back at new → used', async () => {
        const id = await approved([[sha('1'), sha('2'), 'refs/heads/main']]);
        gh.receiveMode = 'drop-after';
        await push([[sha('1'), sha('2'), 'refs/heads/main']]).catch(() => null);
        await vi.waitFor(async () => expect((await requests('push')).find(r => r.id === id)!.status).toBe('used'));
    });

    it('ambiguous outcome, refs read back at old → allowed again, and the retry goes through', async () => {
        const id = await approved([[sha('1'), sha('2'), 'refs/heads/main']]);
        gh.receiveMode = 'drop-before';
        await push([[sha('1'), sha('2'), 'refs/heads/main']]).catch(() => null);
        await vi.waitFor(async () => expect((await requests('push')).find(r => r.id === id)!.status).toBe('allowed'));
        gh.receiveMode = 'normal';
        const retry = await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        expect(retry.report!.ok.has('refs/heads/main')).toBe(true);
        expect((await requests('push')).find(r => r.id === id)!.status).toBe('used');
    });

    it('ambiguous outcome, refs read back mixed → unknown, never reusable', async () => {
        gh.refs.set('refs/heads/a', sha('a'));
        gh.refs.set('refs/heads/b', sha('b'));
        const cmds: [string, string, string][] = [[sha('a'), sha('c'), 'refs/heads/a'], [sha('b'), sha('d'), 'refs/heads/b']];
        const id = await approved(cmds);
        gh.receiveMode = 'drop-first-only';
        await push(cmds).catch(() => null);
        await vi.waitFor(async () => expect((await requests('push')).find(r => r.id === id)!.status).toBe('unknown'));
    });

    it('partial result → used for what it did; the rest becomes a new pending request at its current old value', async () => {
        gh.refs.set('refs/heads/a', sha('a'));
        gh.refs.set('refs/heads/b', sha('b'));
        const cmds: [string, string, string][] = [[sha('a'), sha('c'), 'refs/heads/a'], [sha('b'), sha('d'), 'refs/heads/b']];
        const id = await approved(cmds);
        gh.receiveMode = 'reject:refs/heads/b';
        const res = await push(cmds);
        expect(res.report!.ok.has('refs/heads/a')).toBe(true);
        expect(res.report!.ng.has('refs/heads/b')).toBe(true);
        const all = await requests('push');
        expect(all.find(r => r.id === id)!.status).toBe('used');
        const rest = all.find(r => r.status === 'pending')!;
        expect(rest.subject.commands).toEqual([[sha('b'), sha('d'), 'refs/heads/b']]);
    });

    it('a stale old SHA is refused by GitHub and nothing is spent', async () => {
        const id = await approved([[sha('1'), sha('2'), 'refs/heads/main']]);
        gh.refs.set('refs/heads/main', sha('9'));
        const res = await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        expect(res.report!.ng.get('refs/heads/main')).toBe('stale info');
        expect((await requests('push')).find(r => r.id === id)!.status).toBe('allowed');
    });

    it('malformed and v2 bodies are refused with 400, nothing forwarded', async () => {
        const bad = [
            Buffer.from('zzzz'),
            Buffer.concat([pkt('command=ls-refs\n'), Buffer.from('0001'), FLUSH]),
            Buffer.concat([pkt(`${sha('1')} ${sha('2')} refs/heads/main\0report-status push-options\n`), FLUSH]),
            Buffer.concat([pkt(`${sha('1')} ${sha('2')} refs/heads/main\0report-status\n`)]),
        ];
        for (const body of bad) expect((await call('POST', RP, { body })).status).toBe(400);
        const gz = await call('POST', RP, { body: 'x', headers: { 'content-encoding': 'gzip' } });
        expect(gz.status).toBe(415);
        expect(gh.receivePacks).toBe(0);
    });
});

describe('pull requests', () => {
    const PR = '/github/repos/acme/widget/pulls';
    const create = (body: object) => call('POST', PR, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const input = { title: 'Add widget', body: 'Details', head: 'feature', base: 'main' };

    beforeEach(() => { gh.refs.set('refs/heads/feature', sha('5')); });

    it('needs approval, then opens the PR at the approved head SHA (used)', async () => {
        const first = await create(input);
        expect(first.status).toBe(403);
        const id = first.headers['x-agora-edge-request'] as string;
        expect(JSON.parse(first.body.toString())).toMatchObject({ error: 'needs_approval', requestId: id });
        const [req] = await requests('pr');
        expect(req.subject).toMatchObject({ owner: 'acme', repo: 'widget', head: 'feature', headSha: sha('5'), base: 'main', baseSha: sha('1'), title: 'Add widget', draft: false });
        await decide(id, 'allow');
        const second = await create(input);
        expect(second.status).toBe(201);
        expect(second.headers['x-agora-edge-pr-status']).toBe('used');
        const [done] = await requests('pr');
        expect(done.status).toBe('used');
        expect(done.result).toMatchObject({ number: 1, headSha: sha('5') });
    });

    it('a changed title or a moved head is a new request', async () => {
        const id = (await create(input)).headers['x-agora-edge-request'] as string;
        await decide(id, 'allow');
        expect((await create({ ...input, title: 'Other title' })).status).toBe(403);
        gh.refs.set('refs/heads/feature', sha('6'));
        expect((await create(input)).status).toBe(403);
        expect(gh.prCreates).toBe(0);
        expect((await requests('pr')).filter(r => r.status === 'pending')).toHaveLength(2);
    });

    it('GitHub reporting a different head SHA → changed', async () => {
        const id = (await create(input)).headers['x-agora-edge-request'] as string;
        await decide(id, 'allow');
        gh.prHeadOverride = sha('8');
        const res = await create(input);
        expect(res.status).toBe(201);
        expect(res.headers['x-agora-edge-pr-status']).toBe('changed');
        expect((await requests('pr'))[0].status).toBe('changed');
    });

    it('a retry returns the PR this request created instead of opening another', async () => {
        const id = (await create(input)).headers['x-agora-edge-request'] as string;
        await decide(id, 'allow');
        const made = await create(input);
        expect(made.status).toBe(201);
        const again = await create(input);
        expect(again.status).toBe(200);
        expect(JSON.parse(again.body.toString()).number).toBe(JSON.parse(made.body.toString()).number);
        expect(gh.prCreates).toBe(1);
    });

    it('auto-allowed PRs open without a card and are idempotent too', async () => {
        await setPolicy(false, true);
        expect((await create(input)).status).toBe(201);
        expect((await create(input)).status).toBe(200);
        expect(gh.prCreates).toBe(1);
        expect((await requests('pr'))[0].status).toBe('used');
    });

    it('refuses cross-fork heads, unknown fields and missing branches', async () => {
        expect((await create({ ...input, head: 'someone:feature' })).status).toBe(400);
        expect((await create({ ...input, maintainer_can_modify: true })).status).toBe(400);
        expect((await create({ ...input, head: 'nope' })).status).toBe(422);
        expect(await requests('pr')).toHaveLength(0);
    });

    it('reads pass through with the token; anything else is 404', async () => {
        const res = await call('GET', '/github/repos/acme/widget/pulls/1?state=open');
        expect(res.status).toBe(200);
        const seen = gh.requests.find(r => r.url === '/repos/acme/widget/pulls/1?state=open')!;
        expect(seen.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect((await call('GET', '/github/repos/acme/widget/pulls/1/merge')).status).toBe(404);
        expect((await call('GET', '/github/repos/acme/widget/pulls?token=x')).status).toBe(404);
    });
});

describe('Agora reverse proxy', () => {
    it('strips spoofed edge and forwarded headers and signs for this box', async () => {
        apiSeen = [];
        const res = await call('GET', '/channels/x/messages', {
            headers: {
                authorization: 'Bot abc', 'x-agora-edge-box': '01J00000000000000000000OTH', 'x-agora-edge-gen': '99',
                'x-agora-edge-sig': 'f'.repeat(64), 'x-forwarded-for': '8.8.8.8', 'x-forwarded-host': 'evil',
            },
        });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body.toString())).toEqual({ path: '/channels/x/messages' });
        const h = apiSeen[0];
        expect(h.authorization).toBe('Bot abc');
        expect(h['x-forwarded-for']).toBe('127.0.0.1');
        expect(h['x-forwarded-host']).toBeUndefined();
        expect(verifyEdge(h as any, SECRET)).toEqual({ boxId, generation: 4 });
    });

    it('passes WebSocket upgrades through, signed', async () => {
        upgradeSeen = null;
        const out = await new Promise<string>((resolve, reject) => {
            const s = net.connect(edgePort, '127.0.0.1', () => {
                s.write('GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: edge:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Agora-Edge-Box: SPOOF\r\n\r\n');
            });
            let buf = '';
            s.on('data', d => {
                buf += d.toString();
                if (buf.includes('\r\n\r\n') && !buf.includes('hello')) s.write('hello');
                if (buf.includes('echo:hello')) { s.destroy(); resolve(buf); }
            });
            s.on('error', reject);
        });
        expect(out).toMatch(/^HTTP\/1.1 101/);
        expect(upgradeSeen!['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
        expect(verifyEdge(upgradeSeen as any, SECRET)).toEqual({ boxId, generation: 4 });
    });

    // Request smuggling: bytes after a request's head must never reach the API as a request of their own
    it('forwards a chunked GET body framed, so it can never become a second, unsigned request', async () => {
        apiSeen = [];
        const smuggled = 'GET /smuggled HTTP/1.1\r\nHost: api\r\nAuthorization: Bearer stolen\r\nContent-Length: 0\r\n\r\n';
        const out = await rawToEdge('GET /health HTTP/1.1\r\nHost: edge:8080\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
            + `${Buffer.byteLength(smuggled).toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`);
        expect(out).toMatch(/^HTTP\/1\.1 200/);
        await new Promise(r => setTimeout(r, 300));
        expect(apiSeen).toHaveLength(1);
        expect(apiSeen[0]['transfer-encoding']).toBe('chunked');
        expect(verifyEdge(apiSeen[0] as any, SECRET)).toEqual({ boxId, generation: 4 });
    });

    it('refuses a request with both Content-Length and Transfer-Encoding', async () => {
        apiSeen = [];
        const out = await rawToEdge('POST /x HTTP/1.1\r\nHost: edge:8080\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n');
        expect(out).toMatch(/^HTTP\/1\.1 400/);
        expect(apiSeen).toHaveLength(0);
    });

    it('sends nothing more after a refused upgrade, and closes the connection', async () => {
        afterRefusal.length = 0;
        let sentLater = false;
        const out = await rawToEdge('GET /refuse HTTP/1.1\r\nHost: edge:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
            + 'GET /smuggled HTTP/1.1\r\nHost: api\r\nAuthorization: Bearer stolen\r\n\r\n', (buf, s) => {
            if (!sentLater && buf.includes('\r\n\r\n')) { sentLater = true; s.write('GET /smuggled-later HTTP/1.1\r\nHost: api\r\n\r\n'); }
        });
        expect(out).toMatch(/^HTTP\/1\.1 400/);
        await new Promise(r => setTimeout(r, 300));
        expect(afterRefusal.join('')).toBe('');
    });

    it('answers /healthz from loopback without touching the API', async () => {
        apiSeen = [];
        const res = await call('GET', '/healthz');
        expect(res.status).toBe(200);
        expect(apiSeen).toHaveLength(0);
    });
});

describe('forward proxy', () => {
    function connect(authority: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
            let buf = '';
            s.on('data', d => { buf += d.toString(); });
            s.on('close', () => resolve(buf));
            s.on('error', reject);
        });
    }

    it('CONNECT to an unlisted domain → 403 with the request ID, a pending request and a card', async () => {
        const out = await connect('unlisted.example.org:443');
        expect(out).toMatch(/^HTTP\/1.1 403/);
        const [req] = await requests('domain');
        expect(req).toMatchObject({ status: 'pending', subject: { host: 'unlisted.example.org' } });
        expect(out).toContain(`X-Agora-Edge-Request: ${req.id}`);
        expect(out).toContain(`domain unlisted.example.org needs the owner's approval; request ${req.id} was sent`);
        expect(published.some(e => e.event === 'Message')).toBe(true);
    });

    it('after Allow the domain is reachable; after Deny no new card for it', async () => {
        await connect('later.example.org:443');
        const [req] = await requests('domain');
        await decide(req.id, 'allow');
        // The dialer in this test goes nowhere: a 502 from the dial means the allowlist passed
        expect(await connect('later.example.org:443')).not.toMatch(/^HTTP\/1.1 403/);

        await connect('denied.example.org:443');
        const denied = (await requests('domain')).find(r => r.subject.host === 'denied.example.org')!;
        await decide(denied.id, 'deny');
        published.length = 0;
        const out = await connect('denied.example.org:443');
        expect(out).toContain('was denied by the owner');
        expect((await requests('domain')).filter(r => r.subject.host === 'denied.example.org')).toHaveLength(1);
        expect(published).toHaveLength(0);
    });

    it('IP literals → 403 and no request', async () => {
        expect(await connect('10.213.0.3:443')).toMatch(/^HTTP\/1.1 403/);
        expect(await connect('[::1]:443')).toMatch(/^HTTP\/1.1 403/);
        expect(await requests('domain')).toHaveLength(0);
    });
});

describe('forward proxy: telemetry, wildcards and logins', () => {
    const setAllowlist = (domains: string[]) => ctx.db.query('UPDATE agent_boxes SET allowed_domains = $2 WHERE id = $1', [boxId, domains]);
    function connect(authority: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
            let buf = '';
            s.on('data', d => { buf += d.toString(); });
            s.on('close', () => resolve(buf));
            s.on('error', reject);
        });
    }
    async function openLogin() {
        await ctx.db.query(
            `INSERT INTO box_login_requests (id, box_id, status, expires_at) VALUES ($1, $2, 'code_sent', NOW() + interval '10 minutes')`,
            [generateUlid(), boxId]
        );
    }
    async function waitForCard(host: string) {
        for (let i = 0; i < 100; i++) {
            const r = (await requests('domain')).find(x => x.subject.host === host);
            if (r) return r;
            await new Promise(res => setTimeout(res, 20));
        }
        throw new Error(`no card for ${host}`);
    }
    beforeEach(async () => {
        await setAllowlist(['allowed.example.com']);
        await ctx.db.query('DELETE FROM box_login_requests WHERE box_id = $1', [boxId]);
    });
    afterAll(async () => {
        await setAllowlist(['allowed.example.com']);
        await ctx.db.query('DELETE FROM box_login_requests WHERE box_id = $1', [boxId]);
    });

    it('telemetry hosts are refused without a card, even under an allowed wildcard', async () => {
        await setAllowlist(['allowed.example.com', '*.chatgpt.com']);
        for (const host of ['ab.chatgpt.com', 'o33249.ingest.us.sentry.io', 'http-intake.logs.us5.datadoghq.com', 'statsig.anthropic.com']) {
            const out = await connect(`${host}:443`);
            expect(out).toMatch(/^HTTP\/1.1 403/);
            expect(out).toContain(`domain ${host} sends telemetry`);
        }
        expect(await requests('domain')).toHaveLength(0);
        expect(published).toHaveLength(0);
        // The wildcard still covers the provider's other hosts
        expect(await connect('files.chatgpt.com:443')).not.toMatch(/^HTTP\/1.1 403/);
    });

    it('a telemetry host the owner listed by its exact name goes through', async () => {
        await setAllowlist(['allowed.example.com', 'ab.chatgpt.com']);
        expect(await connect('ab.chatgpt.com:443')).not.toMatch(/^HTTP\/1.1 403/);
    });

    it('a domain card offers the bounded wildcard; allowing it answers the other cards it covers', async () => {
        await connect('eu.files.example.org:443');
        await connect('us.files.example.org:443');
        const cards = await requests('domain');
        expect(cards).toHaveLength(2);
        const card = published.find(e => e.event === 'Message' && (e as any).data?.systemData?.subject?.host === 'eu.files.example.org');
        expect((card as any)?.data?.systemData?.wildcard).toBe('*.example.org');

        await decide(cards[0].id, 'wildcard');
        expect((await requests('domain')).map(r => r.status)).toEqual(['allowed', 'allowed']);
        const box = (await ctx.db.query('SELECT allowed_domains FROM agent_boxes WHERE id = $1', [boxId])).rows[0];
        expect(box.allowed_domains).toContain('*.example.org');
        expect(box.allowed_domains).not.toContain('eu.files.example.org');
        // Another name under it goes through without a card; the bare registrable domain doesn't
        expect(await connect('asia.files.example.org:443')).not.toMatch(/^HTTP\/1.1 403/);
        expect(await connect('example.org:443')).toMatch(/^HTTP\/1.1 403/);
    });

    it('two wildcards decided at once on one box: no deadlock, one wins', async () => {
        await connect('a.one.example.net:443');
        await connect('b.one.example.net:443');
        const [c1, c2] = await requests('domain');
        const results = await Promise.allSettled([decide(c1.id, 'wildcard'), decide(c2.id, 'wildcard')]);
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        // The second finds its card already answered by the first; never a deadlock (40P01)
        for (const f of failed) expect(f.reason).toMatchObject({ status: 409, code: 'already_decided' });
        expect(failed.length).toBeLessThanOrEqual(1);
        expect((await requests('domain')).map(r => r.status)).toEqual(['allowed', 'allowed']);
    });

    it('no card offers a wildcard that covers other people\'s suffixes', async () => {
        for (const host of ['sts.amazonaws.com', 'a.b.windows.net', 's3.amazonaws.com']) {
            await connect(`${host}:443`);
            const msg = published.find(e => e.event === 'Message' && (e as any).data?.systemData?.subject?.host === host);
            expect((msg as any)?.data?.systemData?.wildcard, host).toBeNull();
            const card = (await requests('domain')).find(r => r.subject.host === host)!;
            await expect(decide(card.id, 'wildcard')).rejects.toMatchObject({ status: 400, code: 'no_wildcard' });
        }
    });

    it('no wildcard for a registrable domain itself or a name under a public suffix', async () => {
        for (const host of ['example.org', 'evil.github.io']) {
            await connect(`${host}:443`);
            const card = (await requests('domain')).find(r => r.subject.host === host)!;
            await expect(decide(card.id, 'wildcard')).rejects.toMatchObject({ status: 400, code: 'no_wildcard' });
            expect((await requests('domain')).find(r => r.id === card.id)!.status).toBe('pending');
        }
        const box = (await ctx.db.query('SELECT allowed_domains FROM agent_boxes WHERE id = $1', [boxId])).rows[0];
        expect(box.allowed_domains).toEqual(['allowed.example.com']);
    });

    it('during a login, the CLI provider\'s domain waits for its card and goes through once allowed', async () => {
        await openLogin();
        const pending = connect('platform.claude.com:443');
        const card = await waitForCard('platform.claude.com');
        await decide(card.id, 'allow');
        expect(await pending).not.toMatch(/^HTTP\/1.1 403/);
    });

    it('during a login, a denied card ends the wait with a 403', async () => {
        await openLogin();
        const pending = connect('sso.claude.com:443');
        const card = await waitForCard('sso.claude.com');
        await decide(card.id, 'deny');
        expect(await pending).toMatch(/^HTTP\/1.1 403/);
    });

    it('the wait is bounded, and only a login\'s own provider domains wait', async () => {
        await openLogin();
        const started = Date.now();
        expect(await connect('platform.claude.com:443')).toMatch(/^HTTP\/1.1 403/);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
        // Another site is refused at once, login or not
        const quick = Date.now();
        expect(await connect('elsewhere.example.org:443')).toMatch(/^HTTP\/1.1 403/);
        expect(Date.now() - quick).toBeLessThan(1000);
    });

    it('without a login, a provider domain is refused at once', async () => {
        const started = Date.now();
        expect(await connect('platform.claude.com:443')).toMatch(/^HTTP\/1.1 403/);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});

describe('maintenance', () => {
    it('expires allowed approvals past their time and refreshes the card', async () => {
        await push([[sha('1'), sha('2'), 'refs/heads/main']]);
        const [req] = await requests('push');
        await decide(req.id, 'allow');
        await ctx.db.query(`UPDATE box_edge_requests SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [req.id]);
        published.length = 0;
        await edge.maintain();
        expect((await requests('push'))[0].status).toBe('expired');
        expect(published.some(e => e.event === 'MessageUpdate')).toBe(true);
    });
});

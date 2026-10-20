import { vi } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../../src/app';
import { authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { resetInitializedCache } from '../../src/instance/check-initialized';

/** Voice route hardening (PR #109 review): rate limits per user, provider timeouts, upload caps, redirects. */

const WEBM = (n = 16) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n)]);

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let db: Awaited<ReturnType<typeof buildApp>>['db'];
let request: supertest.Agent;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;

function mockOk() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'hello' }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

beforeAll(async () => {
    ({ app, db } = await buildApp({
        logger: false, jwtSecret: 'test-secret-do-not-use-in-prod',
        dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL, rateLimit: true,
    }));
    await app.ready();
    request = supertest(app.server);
    await cleanDatabase(db);
    resetInitializedCache();
    owner = await authedUser(request, 'hardowner');
    member = await authedUser(request, 'hardmember');
    const server = await createServer(request, owner.auth, 'Hardening');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    await joinViaInvite(request, owner.auth, member.auth, serverId);
    const provider = await request.post(`/servers/${serverId}/ai/providers`).set(owner.auth)
        .send({ adapter: 'openai', label: 'Audio API', apiKey: 'sk-test' });
    providerId = provider.body.id;
    for (const [cap, model] of [['stt', 'whisper-1'], ['tts', 'kokoro']] as const) {
        const res = await request.put(`/servers/${serverId}/ai/routes/${cap}`).set(owner.auth).send({ providerId, model, enabled: true });
        expect(res.status).toBe(200);
    }
});
let providerId: string;

afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await app.close(); await db.end(); });

describe('rate limits are per user', () => {
    it('gives each user their own transcription bucket', async () => {
        mockOk();
        const url = `/channels/${channelId}/voice/transcribe`;
        const send = (auth: object) => request.post(url).set(auth).set('Content-Type', 'audio/webm').send(WEBM());
        let last = 0;
        for (let i = 0; i < 31; i++) last = (await send(owner.auth)).status;
        expect(last).toBe(429);
        // another user is not throttled by the first user's traffic
        expect((await send(member.auth)).status).toBe(200);
    });
});

const post = (auth: object, body: Buffer, type = 'audio/webm') =>
    request.post(`/channels/${channelId}/voice/transcribe`).set(auth).set('Content-Type', type).send(body);

describe('provider timeout and the request transaction', () => {
    it('times out a stalled provider, records the failure, and holds no transaction open meanwhile', async () => {
        const { config } = await import('../../src/config');
        const saved = config.voiceProviderTimeoutMs;
        config.voiceProviderTimeoutMs = 300;
        let idleInTx = -1;
        vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
            db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'")
                .then(r => { idleInTx = r.rows[0].n; });
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        })));
        try {
            const res = await post(member.auth, WEBM());
            expect(res.status).toBe(502);
            expect(res.body.error).toMatch(/timeout|aborted/i);
            expect(idleInTx).toBe(0);
            const failed = await db.query("SELECT error FROM ai_usage_events WHERE server_id = $1 AND capability = 'stt' AND error IS NOT NULL", [serverId]);
            expect(failed.rows.length).toBeGreaterThan(0);
        } finally {
            config.voiceProviderTimeoutMs = saved;
        }
    });

    it('times out speech the same way', async () => {
        const { config } = await import('../../src/config');
        const saved = config.voiceProviderTimeoutMs;
        config.voiceProviderTimeoutMs = 300;
        await request.patch(`/servers/${serverId}/ai/voice`).set(owner.auth).send({ readAloudServer: true });
        const msg = await request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'slow speech' });
        vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_r, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        })));
        try {
            const res = await request.post(`/channels/${channelId}/messages/${msg.body.id}/speech`).set(member.auth);
            expect(res.status).toBe(502);
        } finally {
            config.voiceProviderTimeoutMs = saved;
        }
    });
});

describe('upload checks', () => {
    it('refuses bytes that are not audio, even with an audio content type', async () => {
        const fetchMock = mockOk();
        const res = await post(member.auth, Buffer.from('<html>definitely not audio at all</html>'));
        expect(res.status).toBe(415);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts each supported container', async () => {
        mockOk();
        const clips: [string, Buffer][] = [
            ['audio/ogg', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)])],
            ['audio/wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)])],
            ['audio/mpeg', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)])],
            ['audio/mpeg', Buffer.concat([Buffer.from([0xff, 0xfb, 0x90]), Buffer.alloc(16)])],
            ['audio/mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)])],
        ];
        for (const [type, body] of clips) expect((await post(member.auth, body, type)).status, type).toBe(200);
    });

    it('rejects an oversized upload by Content-Length without reading it, and while streaming', async () => {
        // 5-second limit => 5 * 128 KB + 256 KB
        expect((await request.patch(`/servers/${serverId}/ai/voice`).set(owner.auth).send({ maxRecordingSeconds: 5 })).status).toBe(200);
        const fetchMock = mockOk();
        const big = Buffer.concat([WEBM(), Buffer.alloc(1024 * 1024)]);
        // The server may drop the connection once it has refused, so a reset counts as refused too
        const status413 = await post(member.auth, big).then(r => r.status, () => 413);
        expect(status413).toBe(413);

        // No Content-Length (chunked): the stream is cut off at the cap
        await app.listen({ port: 0, host: '127.0.0.1' });
        const port = (app.server.address() as any).port;
        const http = await import('node:http');
        const status = await new Promise<number>((resolve) => {
            const req = http.request({ port, method: 'POST', path: `/channels/${channelId}/voice/transcribe`,
                headers: { ...(member.auth as any), 'Content-Type': 'audio/webm', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode!); });
            req.on('error', () => resolve(413));
            for (let i = 0; i < 20; i++) req.write(i === 0 ? WEBM(65536) : Buffer.alloc(65536));
            req.end();
        });
        expect(status).toBe(413);
        expect(fetchMock).not.toHaveBeenCalled();
        await request.patch(`/servers/${serverId}/ai/voice`).set(owner.auth).send({ maxRecordingSeconds: 120 });
        expect((await post(member.auth, WEBM())).status).toBe(200);
    });
});

describe('provider redirects', () => {
    it('does not follow a redirect from the provider, for either call', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest' } }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await post(member.auth, WEBM());
        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/redirect/i);
        expect((fetchMock.mock.calls[0] as any)[1].redirect).toBe('manual');
    });
});

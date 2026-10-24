import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HANDLE_RE } from '../src/crypto.js';
import { FakeSender, INSTANCE, IOS_TOKEN, makeRelay, push, pushBody, register, type TestRelay } from './helpers.js';

// docs/planning/mobile-apps.md section 8, "Push relay".
let relay: TestRelay;
beforeEach(async () => {
    relay = await makeRelay();
});
afterEach(async () => {
    await relay.close();
});

const android = () => relay.senders.android as FakeSender;
const ios = () => relay.senders.ios as FakeSender;

async function handleFor(body: Record<string, unknown> = {}): Promise<string> {
    const res = await register(relay, body);
    expect(res.statusCode).toBe(201);
    return res.json().handle as string;
}

describe('POST /v1/register', () => {
    it('201 with a 43-character base64url handle', async () => {
        const res = await register(relay);
        expect(res.statusCode).toBe(201);
        expect(Object.keys(res.json())).toEqual(['handle']);
        expect(res.json().handle).toMatch(HANDLE_RE);
    });

    it('returns the same handle for the same token and instance', async () => {
        const a = await handleFor();
        const b = await handleFor();
        // The origin is normalised, so these are the same instance.
        const c = await handleFor({ instance: 'https://AGORA.example.com/' });
        expect(b).toBe(a);
        expect(c).toBe(a);
        expect(relay.store.count()).toBe(1);
    });

    it('gives a different handle for another instance or another token', async () => {
        const a = await handleFor();
        const other = await handleFor({ instance: 'https://other.example.com' });
        const token = await handleFor({ token: 'another-token' });
        expect(new Set([a, other, token]).size).toBe(3);
    });

    it('re-registering after DELETE returns the same handle again', async () => {
        const a = await handleFor();
        await relay.app.inject({ method: 'DELETE', url: '/v1/handles', headers: { authorization: `Bearer ${a}` } });
        expect(await handleFor()).toBe(a);
    });

    it('accepts an iOS hex token', async () => {
        const res = await register(relay, { platform: 'ios', token: IOS_TOKEN });
        expect(res.statusCode).toBe(201);
    });

    it.each([
        ['an http origin', { instance: 'http://agora.example.com' }],
        ['an origin with a path', { instance: 'https://agora.example.com/app' }],
        ['an origin with a query', { instance: 'https://agora.example.com/?x=1' }],
        ['credentials in the origin', { instance: 'https://u:p@agora.example.com' }],
        ['not a URL', { instance: 'agora.example.com' }],
    ])('400 for %s', async (_name, body) => {
        const res = await register(relay, body);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_instance' });
    });

    it.each([
        ['an unknown platform', { platform: 'web' }],
        ['a missing token', { token: undefined }],
        ['an empty token', { token: '' }],
        ['a token with spaces', { token: 'has space' }],
        ['a token over 4096 characters', { token: 'a'.repeat(4097) }],
    ])('400 for %s', async (_name, body) => {
        const res = await register(relay, body);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_body' });
    });

    it('400 for an iOS token that is not hex', async () => {
        const res = await register(relay, { platform: 'ios', token: 'not-hex' });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_token' });
    });

    it('503 when the platform has no provider configured', async () => {
        await relay.close();
        relay = await makeRelay({ senders: { android: new FakeSender() } });
        const res = await register(relay, { platform: 'ios', token: IOS_TOKEN });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'platform_unavailable' });
    });

    it('429 per client IP, with Retry-After, and the window resets', async () => {
        await relay.close();
        relay = await makeRelay({ registerPerMinute: 3 });
        for (let i = 0; i < 3; i++) expect((await register(relay, {}, '198.51.100.7')).statusCode).toBe(201);
        const limited = await register(relay, {}, '198.51.100.7');
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toEqual({ error: 'rate_limited' });
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        // Invalid bodies count too, and other IPs are unaffected.
        expect((await register(relay, { platform: 'web' }, '198.51.100.7')).statusCode).toBe(429);
        expect((await register(relay, {}, '198.51.100.8')).statusCode).toBe(201);
        relay.clock.now += 60_000;
        expect((await register(relay, {}, '198.51.100.7')).statusCode).toBe(201);
    });

    it('allows cross-origin calls (CORS) and answers the preflight', async () => {
        const res = await register(relay);
        expect(res.headers['access-control-allow-origin']).toBe('*');
        const pre = await relay.app.inject({ method: 'OPTIONS', url: '/v1/register', headers: { origin: INSTANCE, 'access-control-request-method': 'POST' } });
        expect(pre.statusCode).toBe(204);
        expect(pre.headers['access-control-allow-methods']).toContain('POST');
    });
});

describe('POST /v1/push', () => {
    it('202 and sends type, title, body, url and the registered instance', async () => {
        const handle = await handleFor({ instance: 'https://Agora.Example.com/' });
        const res = await push(relay, handle, pushBody({ instance: 'https://agora.example.com' }));
        expect(res.statusCode).toBe(202);
        expect(android().calls).toEqual([
            {
                token: expect.stringMatching(/^fcm-token/),
                message: { type: 'approval', title: 'Approval waiting', body: 'In #general', url: '/channels/01ABC/threads/01DEF', instance: INSTANCE },
            },
        ]);
    });

    it('routes iOS handles to the iOS sender', async () => {
        const handle = await handleFor({ platform: 'ios', token: IOS_TOKEN });
        expect((await push(relay, handle)).statusCode).toBe(202);
        expect(ios().calls[0].token).toBe(IOS_TOKEN);
        expect(android().calls).toHaveLength(0);
    });

    it.each([
        ['no Authorization header', null],
        ['a malformed handle', 'short'],
        ['an unknown handle', 'A'.repeat(43)],
    ])('401 for %s', async (_name, handle) => {
        const res = await push(relay, handle);
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'unknown_handle' });
        expect(android().calls).toHaveLength(0);
    });

    it('401 for a non-Bearer scheme', async () => {
        const handle = await handleFor();
        const res = await relay.app.inject({ method: 'POST', url: '/v1/push', headers: { authorization: `Basic ${handle}` }, payload: pushBody() });
        expect(res.statusCode).toBe(401);
    });

    it('403 when instance does not match the origin the handle was registered with', async () => {
        const handle = await handleFor();
        for (const instance of ['https://evil.example.com', 'https://agora.example.com:8443', 'http://agora.example.com', 'garbage']) {
            const res = await push(relay, handle, pushBody({ instance }));
            expect(res.statusCode).toBe(403);
            expect(res.json()).toEqual({ error: 'instance_mismatch' });
        }
        expect(android().calls).toHaveLength(0);
    });

    it('410 when the provider reports the token gone, and deletes the handle', async () => {
        const handle = await handleFor();
        android().next = { ok: false, gone: true, reason: 'fcm_404_UNREGISTERED' };
        const res = await push(relay, handle);
        expect(res.statusCode).toBe(410);
        expect(res.json()).toEqual({ error: 'gone' });
        expect(relay.store.count()).toBe(0);
        android().next = { ok: true };
        expect((await push(relay, handle)).statusCode).toBe(401);
    });

    it('502 for other provider failures, and keeps the handle', async () => {
        const handle = await handleFor();
        android().next = { ok: false, gone: false, reason: 'fcm_503_UNAVAILABLE' };
        const res = await push(relay, handle);
        expect(res.statusCode).toBe(502);
        expect(res.json()).toEqual({ error: 'provider_error' });
        expect(relay.store.count()).toBe(1);
    });

    it('429 after 30 a minute per handle, with Retry-After; other handles are unaffected', async () => {
        const handle = await handleFor();
        const other = await handleFor({ token: 'other-token' });
        for (let i = 0; i < 30; i++) expect((await push(relay, handle)).statusCode).toBe(202);
        const limited = await push(relay, handle);
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toEqual({ error: 'rate_limited' });
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        expect(android().calls).toHaveLength(30);
        expect((await push(relay, other)).statusCode).toBe(202);
        relay.clock.now += 60_000;
        expect((await push(relay, handle)).statusCode).toBe(202);
    });

    it('a mismatched instance does not use up the handle owner’s rate limit', async () => {
        const handle = await handleFor();
        for (let i = 0; i < 40; i++) await push(relay, handle, pushBody({ instance: 'https://evil.example.com' }));
        expect((await push(relay, handle)).statusCode).toBe(202);
    });

    it('does not send CORS headers (instances call it server to server)', async () => {
        const handle = await handleFor();
        const res = await push(relay, handle);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
});

describe('payload limits', () => {
    let handle: string;
    beforeEach(async () => {
        handle = await handleFor();
    });

    it('accepts a title and body of exactly 120 characters, and an empty body', async () => {
        expect((await push(relay, handle, pushBody({ title: 't'.repeat(120), body: 'b'.repeat(120) }))).statusCode).toBe(202);
        expect((await push(relay, handle, pushBody({ body: '' }))).statusCode).toBe(202);
    });

    it('accepts the instance UI paths, with a query', async () => {
        for (const url of ['/app/01ABC', '/app/01ABC?thread=01DEF']) {
            expect((await push(relay, handle, pushBody({ url }))).statusCode).toBe(202);
        }
    });

    it.each([
        ['title over 120', { title: 't'.repeat(121) }],
        ['body over 120', { body: 'b'.repeat(121) }],
        ['empty title', { title: '' }],
        ['type over 64', { type: 'x'.repeat(65) }],
        ['missing url', { url: undefined }],
        ['absolute url', { url: 'https://evil.example.com/x' }],
        ['protocol-relative url', { url: '//evil.example.com/x' }],
        ['backslash url', { url: '/\\evil.example.com' }],
        ['javascript url', { url: 'javascript:alert(1)' }],
        ['url with whitespace', { url: '/channels/a b' }],
        ['non-string title', { title: 42 }],
    ])('400 for %s', async (_name, over) => {
        const res = await push(relay, handle, pushBody(over));
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_body' });
        expect(android().calls).toHaveLength(0);
    });

    it('413 for a body over the 8 KiB limit', async () => {
        const res = await relay.app.inject({
            method: 'POST',
            url: '/v1/push',
            headers: { authorization: `Bearer ${handle}`, 'content-type': 'application/json' },
            payload: JSON.stringify({ ...pushBody(), padding: 'x'.repeat(9000) }),
        });
        expect(res.statusCode).toBe(413);
        expect(res.json()).toEqual({ error: 'payload_too_large' });
    });

    it('400 for invalid JSON', async () => {
        const res = await relay.app.inject({
            method: 'POST',
            url: '/v1/push',
            headers: { authorization: `Bearer ${handle}`, 'content-type': 'application/json' },
            payload: '{"title": ',
        });
        expect(res.statusCode).toBe(400);
    });
});

describe('DELETE /v1/handles', () => {
    it('204, after which the handle is unknown; a repeat is also 204', async () => {
        const handle = await handleFor();
        const del = () => relay.app.inject({ method: 'DELETE', url: '/v1/handles', headers: { authorization: `Bearer ${handle}` } });
        const res = await del();
        expect(res.statusCode).toBe(204);
        expect(res.body).toBe('');
        expect((await push(relay, handle)).statusCode).toBe(401);
        expect((await del()).statusCode).toBe(204);
    });

    it('401 without a well-formed bearer handle', async () => {
        const res = await relay.app.inject({ method: 'DELETE', url: '/v1/handles' });
        expect(res.statusCode).toBe(401);
    });
});

describe('GET /healthz', () => {
    it('reports ok and which providers are configured', async () => {
        const res = await relay.app.inject({ method: 'GET', url: '/healthz' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'ok', providers: { android: true, ios: true } });
    });

    it('404 for anything else', async () => {
        const res = await relay.app.inject({ method: 'GET', url: '/v1/handles' });
        expect(res.statusCode).toBe(404);
    });
});

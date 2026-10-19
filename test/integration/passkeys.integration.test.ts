import { buildApp } from '../../src/app';
import { getRedis } from '../../src/auth/token-blacklist';
import { ceremonyKey } from '../../src/auth/passkeys';
import { setupTestApp, authedUser, cleanDatabase } from '../helpers';
import { SoftPasskey } from '../webauthn-authenticator';
import { config } from '../../src/config';

// Passkeys (#78), driven by a software authenticator so @simplewebauthn/server's real
// verification runs on every path
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
const ORIGIN = 'http://localhost:5173';
const COOKIE_MODE = { 'X-Agora-Session': 'cookie' };

type Auth = Record<string, string>;
let alice: { userId: string; auth: Auth };
let bob: { userId: string; auth: Auth };

async function registerOptions(auth: Auth, origin = ORIGIN) {
    return ctx.request.post('/auth/passkeys/register/options').set(auth).set('Origin', origin).send();
}

async function addPasskey(auth: Auth, name = 'Laptop', key = new SoftPasskey({ origin: ORIGIN })) {
    const opts = await registerOptions(auth);
    expect(opts.status).toBe(200);
    const res = await ctx.request.post('/auth/passkeys/register/verify').set(auth).set('Origin', ORIGIN)
        .send({ flowId: opts.body.flowId, name, response: key.register(opts.body.options) });
    expect(res.status).toBe(201);
    return { key, passkey: res.body.passkey };
}

async function loginOptions(body: Record<string, unknown> = {}) {
    const res = await ctx.request.post('/auth/passkeys/login/options').set('Origin', ORIGIN).send(body);
    expect(res.status).toBe(200);
    return res.body as { flowId: string; options: any };
}

function loginVerify(flowId: string, response: unknown, headers: Record<string, string> = {}) {
    return ctx.request.post('/auth/passkeys/login/verify').set(headers).set('Origin', ORIGIN).send({ flowId, response });
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    alice = await authedUser(ctx.request, 'pk_alice');
    bob = await authedUser(ctx.request, 'pk_bob');
});
afterAll(async () => { await ctx.close(); });

describe('registration', () => {
    test('adds a passkey, lists it, and the challenge is single use', async () => {
        const key = new SoftPasskey({ origin: ORIGIN });
        const opts = await registerOptions(alice.auth);
        expect(opts.body.options.rp.id).toBe('localhost');
        expect(opts.body.options.authenticatorSelection.userVerification).toBe('required');
        const response = key.register(opts.body.options);
        const ok = await ctx.request.post('/auth/passkeys/register/verify').set(alice.auth).set('Origin', ORIGIN)
            .send({ flowId: opts.body.flowId, name: 'YubiKey', response });
        expect(ok.status).toBe(201);
        expect(ok.body.passkey).toMatchObject({ name: 'YubiKey', rpId: 'localhost', backedUp: true, lastUsedAt: null });
        expect(ok.body.passkey.id).toHaveLength(26);

        const replay = await ctx.request.post('/auth/passkeys/register/verify').set(alice.auth).set('Origin', ORIGIN)
            .send({ flowId: opts.body.flowId, name: 'Again', response });
        expect(replay.status).toBe(400);
        expect(replay.body.error).toBe('challenge_invalid');

        const list = await ctx.request.get('/auth/passkeys').set(alice.auth);
        expect(list.status).toBe(200);
        expect(list.body.passkeys.map((p: any) => p.name)).toContain('YubiKey');
    });

    test('an expired challenge is refused', async () => {
        const key = new SoftPasskey({ origin: ORIGIN });
        const opts = await registerOptions(alice.auth);
        await getRedis().pexpire(ceremonyKey(opts.body.flowId), 1);
        await new Promise(r => setTimeout(r, 20));
        const res = await ctx.request.post('/auth/passkeys/register/verify').set(alice.auth).set('Origin', ORIGIN)
            .send({ flowId: opts.body.flowId, response: key.register(opts.body.options) });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('challenge_invalid');
    });

    test("another user can't finish someone else's registration", async () => {
        const key = new SoftPasskey({ origin: ORIGIN });
        const opts = await registerOptions(alice.auth);
        const res = await ctx.request.post('/auth/passkeys/register/verify').set(bob.auth).set('Origin', ORIGIN)
            .send({ flowId: opts.body.flowId, response: key.register(opts.body.options) });
        expect(res.status).toBe(400);
        expect((await ctx.request.get('/auth/passkeys').set(bob.auth)).body.passkeys).toHaveLength(0);
    });

    test('origin must be configured, and the response must come from the same origin', async () => {
        expect((await registerOptions(alice.auth, 'https://evil.example')).status).toBe(400);
        const noOrigin = await ctx.request.post('/auth/passkeys/register/options').set(alice.auth).send();
        expect(noOrigin.body.error).toBe('origin_not_allowed');

        const key = new SoftPasskey({ origin: ORIGIN });
        const opts = await registerOptions(alice.auth);
        const res = await ctx.request.post('/auth/passkeys/register/verify').set(alice.auth).set('Origin', ORIGIN)
            .send({ flowId: opts.body.flowId, response: key.register(opts.body.options, { origin: 'https://evil.example' }) });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('passkey_invalid');
    });

    test('the same authenticator cannot be registered twice', async () => {
        const { key } = await addPasskey(alice.auth, 'Phone');
        const opts = await registerOptions(alice.auth);
        expect(opts.body.options.excludeCredentials.map((c: any) => c.id)).toContain(key.id);
        const bobOpts = await registerOptions(bob.auth);
        const dup = await ctx.request.post('/auth/passkeys/register/verify').set(bob.auth).set('Origin', ORIGIN)
            .send({ flowId: bobOpts.body.flowId, response: key.register(bobOpts.body.options) });
        expect(dup.status).toBe(409);
        expect(dup.body.error).toBe('passkey_exists');
    });

    test('schema rejects malformed bodies and auth is required', async () => {
        expect((await ctx.request.post('/auth/passkeys/register/verify').set(alice.auth).send({ flowId: 'x' })).status).toBe(400);
        expect((await ctx.request.post('/auth/passkeys/register/verify').set(alice.auth)
            .send({ flowId: 'x', response: { id: 'not base64!', rawId: 'a', type: 'public-key', response: { clientDataJSON: 'a' } } })).status).toBe(400);
        expect((await ctx.request.get('/auth/passkeys')).status).toBe(401);
        expect((await ctx.request.post('/auth/passkeys/register/options').set('Origin', ORIGIN).send()).status).toBe(401);
    });
});

describe('delete', () => {
    test('only the owner can delete a passkey, and a deleted passkey no longer signs in', async () => {
        const { key, passkey } = await addPasskey(alice.auth, 'Old laptop');
        const notMine = await ctx.request.delete(`/auth/passkeys/${passkey.id}`).set(bob.auth);
        expect(notMine.status).toBe(404);

        const del = await ctx.request.delete(`/auth/passkeys/${passkey.id}`).set(alice.auth);
        expect(del.status).toBe(204);
        expect((await ctx.request.get('/auth/passkeys').set(alice.auth)).body.passkeys.map((p: any) => p.id)).not.toContain(passkey.id);
        expect((await ctx.request.delete(`/auth/passkeys/${passkey.id}`).set(alice.auth)).status).toBe(404);

        const { flowId, options } = await loginOptions();
        expect((await loginVerify(flowId, key.authenticate(options))).status).toBe(401);
    });
});

describe('sign-in', () => {
    let key: SoftPasskey;
    beforeAll(async () => { ({ key } = await addPasskey(alice.auth, 'Sign-in key')); });

    test('username-less sign-in issues the same cookie session as a password login', async () => {
        const { flowId, options } = await loginOptions();
        expect(options.allowCredentials ?? []).toHaveLength(0);
        expect(options.userVerification).toBe('required');
        const res = await loginVerify(flowId, key.authenticate(options), COOKIE_MODE);
        expect(res.status).toBe(200);
        expect(res.body.accessToken).toBeUndefined();
        expect(res.body.user).toMatchObject({ id: alice.userId, username: 'pk_alice' });
        const setCookies: string[] = res.headers['set-cookie'];
        const session = setCookies.find(c => c.startsWith('agora_session='))!;
        expect(session).toMatch(/HttpOnly/);
        expect(session).toMatch(/Max-Age=86400/);
        const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
        const who = await ctx.request.get('/auth/session').set('Cookie', cookie);
        expect(who.status).toBe(200);
        expect(who.body.user.id).toBe(alice.userId);

        const list = await ctx.request.get('/auth/passkeys').set(alice.auth);
        expect(list.body.passkeys.find((p: any) => p.name === 'Sign-in key').lastUsedAt).not.toBeNull();

        // The challenge is single use
        expect((await loginVerify(flowId, key.authenticate(options))).body.error).toBe('challenge_invalid');
    });

    test('with a username, only that account\'s passkeys are offered and accepted', async () => {
        const { flowId, options } = await loginOptions({ login: 'PK_ALICE' });
        expect(options.allowCredentials.map((c: any) => c.id)).toContain(key.id);
        const bobKey = (await addPasskey(bob.auth, 'Bob key')).key;
        expect((await loginVerify(flowId, bobKey.authenticate(options))).status).toBe(401);

        // An unknown account gets a discoverable prompt, indistinguishable from a real one
        const unknown = await loginOptions({ login: 'nobody' });
        expect(unknown.options.allowCredentials ?? []).toHaveLength(0);

        const again = await loginOptions({ login: 'pk_alice' });
        const res = await loginVerify(again.flowId, key.authenticate(again.options));
        expect(res.status).toBe(200);
        expect(typeof res.body.accessToken).toBe('string');
        expect((await ctx.request.get('/auth/session').set('Authorization', `Bearer ${res.body.accessToken}`)).body.user.id).toBe(alice.userId);
    });

    test('an expired sign-in challenge is refused', async () => {
        const { flowId, options } = await loginOptions();
        await getRedis().pexpire(ceremonyKey(flowId), 1);
        await new Promise(r => setTimeout(r, 20));
        const res = await loginVerify(flowId, key.authenticate(options));
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('challenge_invalid');
    });

    test('a registration flow cannot be used to sign in', async () => {
        const reg = await registerOptions(alice.auth);
        const { options } = await loginOptions();
        expect((await loginVerify(reg.body.flowId, key.authenticate(options))).body.error).toBe('challenge_invalid');
    });

    test('a signature counter that goes backwards is refused (cloned authenticator)', async () => {
        const first = await loginOptions();
        expect((await loginVerify(first.flowId, key.authenticate(first.options, { counter: 50 }))).status).toBe(200);
        const second = await loginOptions();
        expect((await loginVerify(second.flowId, key.authenticate(second.options, { counter: 10 }))).status).toBe(401);
    });

    test('a wrong user handle, wrong origin or missing user verification is refused', async () => {
        let f = await loginOptions();
        expect((await loginVerify(f.flowId, key.authenticate(f.options, { userHandle: Buffer.from(bob.userId).toString('base64url') }))).status).toBe(401);
        f = await loginOptions();
        expect((await loginVerify(f.flowId, key.authenticate(f.options, { origin: 'https://evil.example' }))).status).toBe(401);
        const noUv = (await addPasskey(alice.auth, 'No UV', new SoftPasskey({ origin: ORIGIN }))).key;
        (noUv.opts as any).userVerified = false;
        f = await loginOptions();
        expect((await loginVerify(f.flowId, noUv.authenticate(f.options))).status).toBe(401);
    });

    test('a passkey registered on one hostname does not work on another', async () => {
        const TAILNET = 'https://agora-home.example.ts.net';
        expect((await ctx.request.post('/auth/passkeys/login/options').set('Origin', TAILNET).send({})).status).toBe(400);
        config.webauthn.origins.push(TAILNET);
        try {
            const res = await ctx.request.post('/auth/passkeys/login/options').set('Origin', TAILNET).send({});
            expect(res.status).toBe(200);
            expect(res.body.options.rpId).toBe('agora-home.example.ts.net');
            // The localhost passkey answers honestly for the tailnet RP ID; the server
            // still refuses it, because it was registered for "localhost"
            const verify = await ctx.request.post('/auth/passkeys/login/verify').set('Origin', TAILNET)
                .send({ flowId: res.body.flowId, response: key.authenticate(res.body.options, { origin: TAILNET }) });
            expect(verify.status).toBe(401);
        } finally {
            config.webauthn.origins.pop();
        }
    });

    test('a suspended account cannot sign in with a passkey', async () => {
        await ctx.db.query("UPDATE users SET account_status = 'suspended' WHERE id = $1", [alice.userId]);
        try {
            const { flowId, options } = await loginOptions();
            // Past the counter the backwards-counter test left behind
            const res = await loginVerify(flowId, key.authenticate(options, { counter: 1000 }));
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('account_suspended');
        } finally {
            await ctx.db.query("UPDATE users SET account_status = 'active' WHERE id = $1", [alice.userId]);
        }
    });
});

test('passkey endpoints are rate limited', async () => {
    const { app, db } = await buildApp({ logger: false, jwtSecret: 'test-secret-do-not-use-in-prod', dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test' });
    try {
        await app.ready();
        const opts = () => app.inject({ method: 'POST', url: '/auth/passkeys/login/options', headers: { origin: ORIGIN }, payload: {} });
        for (let i = 0; i < 20; i++) expect((await opts()).statusCode).toBe(200);
        expect((await opts()).statusCode).toBe(429);

        const verify = () => app.inject({ method: 'POST', url: '/auth/passkeys/login/verify', headers: { origin: ORIGIN },
            payload: { flowId: 'nope', response: { id: 'abc', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 'abc' } } } });
        for (let i = 0; i < 10; i++) expect((await verify()).statusCode).toBe(400);
        expect((await verify()).statusCode).toBe(429);

        const reg = () => app.inject({ method: 'POST', url: '/auth/passkeys/register/options', headers: { origin: ORIGIN, ...alice.auth } });
        for (let i = 0; i < 10; i++) expect((await reg()).statusCode).toBe(200);
        expect((await reg()).statusCode).toBe(429);
    } finally { await app.close(); await db.end(); }
});

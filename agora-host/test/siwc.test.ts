import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    attemptSecrets, authorizeUrl, checkCallback, listenForCallback, pkce, SCOPES, SiwcError, verifyIdToken,
} from '../src/siwc/oauth.js';
import { hostId, readRecord, writeRecord, type CredentialRecord } from '../src/siwc/store.js';
import { accessToken, login, logout, planState } from '../src/siwc/session.js';
import { PROVIDER_ARGS, startAppServer, type AppServerPlan } from '../src/siwc/appserver.js';
import { handlePlanRequest } from '../src/siwc/requests.js';
import { configSchema, type Config } from '../src/config.js';
import { prepare, type Launch } from '../src/adapters.js';
import { checkTerms, TermsRefusal } from '../src/terms.js';
import type { HostApi } from '../src/types.js';
import { claim, id, tempDir } from './helpers.js';
import { git } from '../src/workspaces.js';

/**
 * Sign in with ChatGPT (agora-host/src/siwc) against mocked OpenAI endpoints: no real network.
 * https://developers.openai.com/siwc/token-sharing-open-source
 */

const ISSUER = 'https://auth.openai.test';
const ISSUED = 'oaiapp_test123';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };

function idToken(claims: Record<string, unknown>): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: ISSUED, sub: 'user-sub-1', email: 'plan@example.com', iat: now, exp: now + 3600, ...claims })).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
}

interface Mock { fetch: typeof fetch; tokenCalls: URLSearchParams[]; revokeCalls: URLSearchParams[]; tokenResponse: (body: URLSearchParams) => { status: number; json: unknown } }
function mockOpenAI(): Mock {
    const m: Mock = { tokenCalls: [], revokeCalls: [], tokenResponse: () => ({ status: 500, json: {} }), fetch: undefined as any };
    m.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({
            issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
            revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`, jwks_uri: `${ISSUER}/jwks.json`,
        });
        if (url === `${ISSUER}/jwks.json`) return Response.json({ keys: [jwk] });
        if (url === `${ISSUER}/api/accounts/oauth/token`) {
            const body = new URLSearchParams(String(init.body));
            m.tokenCalls.push(body);
            const r = m.tokenResponse(body);
            return Response.json(r.json, { status: r.status });
        }
        if (url === `${ISSUER}/api/accounts/oauth/revoke`) { m.revokeCalls.push(new URLSearchParams(String(init.body))); return new Response('', { status: 200 }); }
        throw new Error(`unexpected network call: ${url}`);
    }) as typeof fetch;
    return m;
}

const tokenJson = (scope = SCOPES, extra: Record<string, unknown> = {}) => ({
    access_token: 'at_1', refresh_token: 'rt_1', id_token: idToken({ nonce: extra.nonce }), token_type: 'Bearer', expires_in: 3600, scope, ...extra,
});

/** A browser that follows the authorize URL straight to the loopback callback with a code. */
function browser(opts: { clientId?: string | null; error?: string } = {}) {
    const seen: URL[] = [];
    const open = async (raw: string) => {
        const url = new URL(raw); seen.push(url);
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('state', url.searchParams.get('state')!);
        if (opts.error) back.searchParams.set('error', opts.error);
        else {
            back.searchParams.set('code', 'code_1');
            if (opts.clientId !== null) back.searchParams.set('client_id', opts.clientId ?? ISSUED);
        }
        // Fire and forget, as a browser would
        void fetch(back).then(r => r.text()).catch(() => {});
    };
    return { open, seen };
}

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => { tmp = await tempDir(); });
afterEach(async () => { await tmp.cleanup(); });

describe('PKCE, state and nonce', () => {
    it('makes an S256 challenge of the verifier, base64url without padding', () => {
        const { verifier, challenge } = pkce();
        expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
        expect(challenge).not.toContain('=');
    });
    it('makes fresh state, nonce and verifier for every attempt', () => {
        const a = attemptSecrets(), b = attemptSecrets();
        expect(a.state).not.toBe(b.state); expect(a.nonce).not.toBe(b.nonce); expect(a.verifier).not.toBe(b.verifier);
        expect(a.state).not.toBe(a.nonce);
    });
});

describe('authorization request', () => {
    const base = { authorizationEndpoint: 'https://auth.openai.com/api/accounts/authorize', hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555',
        redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 's', nonce: 'n', challenge: 'c' };
    it('registers dynamically the first time, with the app name and host id', () => {
        const url = new URL(authorizeUrl(base));
        expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
        const q = Object.fromEntries(url.searchParams);
        expect(q).toMatchObject({ client_id: 'dynamic_agent_client', agent_name_hint: 'Agora', ext_agent_host_id: base.hostId, response_type: 'code',
            redirect_uri: 'http://127.0.0.1:1455/auth/callback', resource: 'https://api.openai.com/v1', state: 's', nonce: 'n',
            code_challenge_method: 'S256', code_challenge: 'c' });
        expect(q.scope).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
        expect(q.id_token_hint).toBeUndefined();
    });
    it('reuses the issued client id later, without agent_name_hint', () => {
        const q = new URL(authorizeUrl({ ...base, clientId: ISSUED, loginHint: 'a@example.com' })).searchParams;
        expect(q.get('client_id')).toBe(ISSUED);
        expect(q.has('agent_name_hint')).toBe(false);
        expect(q.get('ext_agent_host_id')).toBe(base.hostId);
        expect(q.get('login_hint')).toBe('a@example.com');
    });
});

describe('callback validation', () => {
    const port = 50123, state = 'expected-state';
    const at = (q: string, host = `127.0.0.1:${port}`) => checkCallback(`/auth/callback?${q}`, host, port, state, undefined);
    it('ignores a state mismatch without consuming the attempt', () => {
        expect(at(`code=c&state=wrong&client_id=${ISSUED}`)).toEqual({ status: 400, outcome: null });
        expect(at(`code=c&state=${state}&state=${state}&client_id=${ISSUED}`).outcome).toBeNull();
    });
    it('only answers the exact redirect: 127.0.0.1, its port, /auth/callback', () => {
        expect(checkCallback(`/callback?code=c&state=${state}`, `127.0.0.1:${port}`, port, state, undefined)).toEqual({ status: 404, outcome: null });
        expect(at(`code=c&state=${state}&client_id=${ISSUED}`, `localhost:${port}`)).toEqual({ status: 404, outcome: null });
        expect(at(`code=c&state=${state}&client_id=${ISSUED}`, `127.0.0.1:1`)).toEqual({ status: 404, outcome: null });
    });
    it('stops on a declined consent', () => {
        const r = at(`error=access_denied&state=${state}`);
        expect(r.outcome).toBeInstanceOf(SiwcError);
        expect((r.outcome as SiwcError).code).toBe('consent_declined');
    });
    it('needs the issued client id on a first registration, never dynamic_agent_client', () => {
        expect((at(`code=c&state=${state}`).outcome as SiwcError).code).toBe('registration_incomplete');
        expect((at(`code=c&state=${state}&client_id=dynamic_agent_client`).outcome as SiwcError).code).toBe('registration_incomplete');
        expect(at(`code=c&state=${state}&client_id=${ISSUED}`).outcome).toEqual({ code: 'c', clientId: ISSUED });
    });
    it('keeps the saved client id on reauthorization and rejects a different one', () => {
        expect(checkCallback(`/auth/callback?code=c&state=${state}`, `127.0.0.1:${port}`, port, state, ISSUED).outcome).toEqual({ code: 'c', clientId: ISSUED });
        expect((checkCallback(`/auth/callback?code=c&state=${state}&client_id=oaiapp_other`, `127.0.0.1:${port}`, port, state, ISSUED).outcome as SiwcError).code).toBe('registration_incomplete');
    });
    it('listens on 127.0.0.1 and survives a stray request with the wrong state', async () => {
        const l = await listenForCallback(0, state, undefined, 5000);
        try {
            expect(l.redirectUri).toBe(`http://127.0.0.1:${l.port}/auth/callback`);
            expect((await fetch(`${l.redirectUri}?code=x&state=nope&client_id=${ISSUED}`)).status).toBe(400);
            expect((await fetch(`${l.redirectUri}?code=x&state=${state}&client_id=${ISSUED}`)).status).toBe(200);
            await expect(l.result).resolves.toEqual({ code: 'x', clientId: ISSUED });
        } finally { l.close(); }
    });
});

describe('sign-in against mocked OpenAI endpoints', () => {
    it('exchanges the code with PKCE and no secret, verifies the ID token and saves the issued client id', async () => {
        const m = mockOpenAI(); const b = browser();
        m.tokenResponse = body => ({ status: 200, json: tokenJson(SCOPES, { nonce: new URL(String(b.seen[0])).searchParams.get('nonce') }) });
        const result = await login({ dir: tmp.dir, profile: 'builder', port: 0, openBrowser: b.open, fetch: m.fetch, issuer: ISSUER, agoraUserId: id(10) });
        expect(result.state).toBe('connected');
        expect(result.email).toBe('plan@example.com');
        const auth = b.seen[0].searchParams;
        const exchange = m.tokenCalls[0];
        expect(Object.fromEntries(exchange)).toMatchObject({ grant_type: 'authorization_code', client_id: ISSUED, code: 'code_1',
            redirect_uri: auth.get('redirect_uri'), resource: 'https://api.openai.com/v1' });
        expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(auth.get('code_challenge'));
        expect(exchange.has('client_secret')).toBe(false);
        const record = (await readRecord(tmp.dir, 'builder'))!;
        expect(record).toMatchObject({ client_id: ISSUED, subject: 'user-sub-1', access_token: 'at_1', refresh_token: 'rt_1', agora_user_id: id(10) });
        expect(record.ext_agent_host_id).toBe(await hostId(tmp.dir));

        // A returning sign-in uses the saved client id and host id, without agent_name_hint
        const again = browser({ clientId: null });
        m.tokenResponse = () => ({ status: 200, json: tokenJson(SCOPES, { nonce: new URL(String(again.seen[0])).searchParams.get('nonce') }) });
        await login({ dir: tmp.dir, profile: 'builder', port: 0, openBrowser: again.open, fetch: m.fetch, issuer: ISSUER });
        expect(again.seen[0].searchParams.get('client_id')).toBe(ISSUED);
        expect(again.seen[0].searchParams.has('agent_name_hint')).toBe(false);
        expect(again.seen[0].searchParams.get('ext_agent_host_id')).toBe(record.ext_agent_host_id);
        expect((await readRecord(tmp.dir, 'builder'))!.agora_user_id).toBe(id(10));
    });

    it('keeps the sign-in but marks plan use off when chatgpt.tokens.use.direct was not granted', async () => {
        const m = mockOpenAI(); const b = browser();
        m.tokenResponse = () => ({ status: 200, json: tokenJson('openid profile email offline_access', { nonce: new URL(String(b.seen[0])).searchParams.get('nonce') }) });
        const result = await login({ dir: tmp.dir, profile: 'builder', port: 0, openBrowser: b.open, fetch: m.fetch, issuer: ISSUER });
        expect(result.state).toBe('scope_missing');
        expect((await planState({ dir: tmp.dir, profile: 'builder' })).state).toBe('scope_missing');
        await expect(accessToken({ dir: tmp.dir, profile: 'builder', fetch: m.fetch, issuer: ISSUER })).rejects.toMatchObject({ code: 'siwc_scope_missing' });
    });

    it('rejects an ID token with the wrong nonce or audience', async () => {
        const m = mockOpenAI();
        await expect(verifyIdToken(idToken({ nonce: 'other' }), ISSUED, 'mine', { fetch: m.fetch, issuer: ISSUER })).rejects.toMatchObject({ code: 'invalid_id_token' });
        await expect(verifyIdToken(idToken({ nonce: 'mine', aud: 'oaiapp_else' }), ISSUED, 'mine', { fetch: m.fetch, issuer: ISSUER })).rejects.toMatchObject({ code: 'invalid_id_token' });
        await expect(verifyIdToken(idToken({ nonce: 'mine' }), ISSUED, 'mine', { fetch: m.fetch, issuer: ISSUER })).resolves.toMatchObject({ subject: 'user-sub-1' });
        // A tampered payload fails the signature
        const [h, , s] = idToken({ nonce: 'mine' }).split('.');
        const forged = Buffer.from(JSON.stringify({ iss: ISSUER, aud: ISSUED, sub: 'evil', iat: 1, exp: 9999999999, nonce: 'mine' })).toString('base64url');
        await expect(verifyIdToken(`${h}.${forged}.${s}`, ISSUED, 'mine', { fetch: m.fetch, issuer: ISSUER })).rejects.toMatchObject({ code: 'invalid_id_token' });
    });

    it('stops without a token exchange when consent is declined', async () => {
        const m = mockOpenAI();
        await expect(login({ dir: tmp.dir, profile: 'builder', port: 0, openBrowser: browser({ error: 'access_denied' }).open, fetch: m.fetch, issuer: ISSUER }))
            .rejects.toMatchObject({ code: 'consent_declined' });
        expect(m.tokenCalls).toHaveLength(0);
    });
});

function record(extra: Partial<CredentialRecord> = {}): CredentialRecord {
    return { version: 1, issuer: ISSUER, subject: 'user-sub-1', email: 'plan@example.com', client_id: ISSUED, ext_agent_host_id: 'urn:uuid:11111111-2222-4333-8444-555555555555',
        id_token: 'x.y.z', access_token: 'at_old', refresh_token: 'rt_old', token_type: 'Bearer', expires_in: 3600, expires_at: Date.now() + 3600_000,
        scopes: SCOPES.split(' '), saved_at: new Date().toISOString(), ...extra };
}

describe('token storage', () => {
    it('keeps a stable opaque host id', async () => {
        const first = await hostId(tmp.dir);
        expect(first).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(await hostId(tmp.dir)).toBe(first);
    });
    it('writes credentials atomically, leaving no temp files', async () => {
        await writeRecord(tmp.dir, 'builder', record());
        await writeRecord(tmp.dir, 'builder', record({ access_token: 'at_2' }));
        expect((await readRecord(tmp.dir, 'builder'))!.access_token).toBe('at_2');
        expect(await readdir(join(tmp.dir, 'profiles'))).toEqual(['builder.json']);
    });
    it.skipIf(process.platform === 'win32')('is readable by the owner only (0600 file, 0700 directory)', async () => {
        await writeRecord(tmp.dir, 'builder', record());
        expect((await stat(join(tmp.dir, 'profiles', 'builder.json'))).mode & 0o777).toBe(0o600);
        expect((await stat(join(tmp.dir, 'profiles'))).mode & 0o777).toBe(0o700);
    });
    it('rejects a profile name that could escape the directory', async () => {
        await expect(writeRecord(tmp.dir, '../evil', record())).rejects.toThrow('invalid_profile_name');
    });
    it('signs out by revoking the refresh token, clearing tokens and keeping the registration', async () => {
        const m = mockOpenAI();
        await writeRecord(tmp.dir, 'builder', record({ agora_user_id: id(10) }));
        expect(await logout({ dir: tmp.dir, profile: 'builder', fetch: m.fetch, issuer: ISSUER })).toEqual({ revoked: true });
        expect(Object.fromEntries(m.revokeCalls[0])).toEqual({ token: 'rt_old', token_type_hint: 'refresh_token', client_id: ISSUED });
        const kept = (await readRecord(tmp.dir, 'builder'))!;
        expect(kept.client_id).toBe(ISSUED);
        expect(kept.access_token).toBeUndefined(); expect(kept.refresh_token).toBeUndefined(); expect(kept.agora_user_id).toBeUndefined();
    });
});

describe('refresh', () => {
    it('refreshes near expiry with the issued client id and saves the rotated refresh token', async () => {
        const m = mockOpenAI();
        await writeRecord(tmp.dir, 'builder', record({ expires_at: Date.now() + 60_000 }));
        m.tokenResponse = () => ({ status: 200, json: { access_token: 'at_new', refresh_token: 'rt_new', token_type: 'Bearer', expires_in: 3600 } });
        const t = await accessToken({ dir: tmp.dir, profile: 'builder', fetch: m.fetch, issuer: ISSUER });
        expect(t.accessToken).toBe('at_new');
        expect(Object.fromEntries(m.tokenCalls[0])).toEqual({ grant_type: 'refresh_token', client_id: ISSUED, refresh_token: 'rt_old', resource: 'https://api.openai.com/v1' });
        expect((await readRecord(tmp.dir, 'builder'))!).toMatchObject({ access_token: 'at_new', refresh_token: 'rt_new', scopes: SCOPES.split(' ') });
        // Still fresh: no second call
        await accessToken({ dir: tmp.dir, profile: 'builder', fetch: m.fetch, issuer: ISSUER });
        expect(m.tokenCalls).toHaveLength(1);
    });
    it('clears an unusable refresh token and asks for a new sign-in', async () => {
        const m = mockOpenAI();
        await writeRecord(tmp.dir, 'builder', record({ expires_at: Date.now() - 1 }));
        m.tokenResponse = () => ({ status: 400, json: { error: 'refresh_token_reused' } });
        await expect(accessToken({ dir: tmp.dir, profile: 'builder', fetch: m.fetch, issuer: ISSUER })).rejects.toMatchObject({ code: 'siwc_reauth_required' });
        const kept = (await readRecord(tmp.dir, 'builder'))!;
        expect(kept.refresh_token).toBeUndefined(); expect(kept.client_id).toBe(ISSUED);
    });
    it('keeps the credentials when the token endpoint is down', async () => {
        const m = mockOpenAI();
        await writeRecord(tmp.dir, 'builder', record({ expires_at: Date.now() - 1 }));
        m.tokenResponse = () => ({ status: 503, json: {} });
        await expect(accessToken({ dir: tmp.dir, profile: 'builder', fetch: m.fetch, issuer: ISSUER })).rejects.toMatchObject({ code: 'siwc_refresh_unavailable', retryable: true });
        expect((await readRecord(tmp.dir, 'builder'))!.refresh_token).toBe('rt_old');
    });
});

function siwcConfig(dir: string): Config {
    return configSchema.parse({ instance: 'http://127.0.0.1:3000', hostToken: 'ah_host.secret',
        mcp: { executable: process.execPath, entrypoint: join(dir, 'mcp.js') },
        profiles: { builder: { adapter: 'codex', auth: 'siwc', executable: process.execPath, workdir: dir, workdirAlias: 'agora', stateDir: join(dir, 'state') } },
        botTokens: { [id(5)]: 'bot_selected.secret' }, siwc: { dir: join(dir, 'siwc'), callbackPort: 0 } });
}
const OWNER = id(10);
function planClaim() {
    const c = claim();
    c.profile.authMode = 'siwc'; c.profile.planOwnerId = OWNER; c.session.startedByOwner = true;
    c.inbox = [{ ...c.inbox[0], reason: 'direct', authorBot: false, authorId: OWNER, authority: 'owner' }];
    return c;
}

describe('app-server launch', () => {
    it('passes the access token in the environment only, with OpenAI\'s provider overrides', async () => {
        await git(tmp.dir, ['init']);
        await git(tmp.dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
        const config = siwcConfig(tmp.dir);
        await writeRecord(config.siwc.dir!, 'builder', record({ access_token: 'at_secret_value', agora_user_id: OWNER }));
        const launch = await prepare(config, planClaim());
        try {
            expect(launch.appServer).toBeDefined();
            expect(launch.args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
            for (const arg of PROVIDER_ARGS) expect(launch.args).toContain(arg);
            expect(launch.args).toContain('model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"');
            expect(launch.args).toContain('model_providers.openai_chatgpt_plan.requires_openai_auth=false');
            expect(launch.args).toContain('model_providers.openai_chatgpt_plan.supports_websockets=false');
            expect(launch.args.join(' ')).not.toContain('at_secret_value');
            expect(launch.stdin).not.toContain('at_secret_value');
            expect(launch.env.ACCESS_TOKEN).toBe('at_secret_value');
            expect(launch.env.CODEX_HOME).toBe(join(tmp.dir, 'state'));
            // Codex asks before leaving its sandbox (#93); "never" would deny silently
            expect(launch.args).toContain('approval_policy="on-request"');
            expect(launch.args).not.toContain('approval_policy="never"');
        } finally { await launch.cleanup(); }
    });
    it('refuses before launching when the plan is not connected or bound to someone else', async () => {
        const config = siwcConfig(tmp.dir);
        await expect(prepare(config, planClaim())).rejects.toMatchObject({ code: 'siwc_not_connected' });
        await writeRecord(config.siwc.dir!, 'builder', record({ agora_user_id: id(11) }));
        await expect(prepare(config, planClaim())).rejects.toMatchObject({ code: 'siwc_plan_owner_mismatch' });
    });
});

describe('plan owner rule on the host', () => {
    const local = () => siwcConfig(process.cwd()).profiles.builder;
    it('runs for the plan owner\'s own messages and hand-offs in sessions they started', () => {
        expect(() => checkTerms(local(), planClaim(), OWNER)).not.toThrow();
        const handoff = planClaim(); handoff.inbox = [{ ...handoff.inbox[0], reason: 'handoff', authorBot: true, authorId: id(12), authority: null }];
        expect(() => checkTerms(local(), handoff)).not.toThrow();
    });
    it('refuses anyone else, a session someone else started, and an unbound plan', () => {
        const other = planClaim(); other.inbox[0].authorId = id(13); other.inbox[0].authority = 'director';
        expect(() => checkTerms(local(), other)).toThrow(TermsRefusal);
        const started = planClaim(); started.session.startedByOwner = false;
        expect(() => checkTerms(local(), started)).toThrow(/plan owner/);
        const unbound = planClaim(); unbound.profile.planOwnerId = null;
        expect(() => checkTerms(local(), unbound)).toThrow(expect.objectContaining({ code: 'siwc_not_connected' }));
    });
});

describe('app-server conversation (fake app-server)', () => {
    const fixture = join(__dirname, 'fixtures', 'fake-app-server.mjs');
    async function run(mode: string, plan: Partial<AppServerPlan> = {}, token = 'at_current') {
        const log = join(tmp.dir, 'fake.log');
        const launch: Launch & { appServer: AppServerPlan } = {
            executable: process.execPath, args: [fixture, 'app-server', '--listen', 'stdio://', ...PROVIDER_ARGS], cwd: tmp.dir,
            env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ACCESS_TOKEN: token, FAKE_LOG: log, FAKE_MODE: mode },
            stdin: '', adapter: 'codex', cleanup: async () => {},
            appServer: { threadId: null, prompt: 'Do the work', outputSchema: { type: 'object' }, model: 'gpt-test', effort: 'high', sandbox: 'workspace-write',
                refresh: async () => 'at_fresh', rpcTimeoutMs: 10000, rules: [], roots: [], ...plan },
        };
        const result = await startAppServer(launch).result;
        const lines = (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
        return { result, lines };
    }

    it('starts a thread and a turn, maps completion, usage and changed files', async () => {
        const { result, lines } = await run('ok');
        expect(result).toMatchObject({ success: true, nativeSessionId: '0199a000-0000-7000-8000-000000000001', tokensUsed: 155, summary: 'Done on the plan', changedPaths: ['src/a.ts'] });
        const start = lines.find(l => l.start);
        expect(start.token).toBe('at_current');
        expect(start.argv.join(' ')).not.toContain('at_current');
        const init = lines.find(l => l.method === 'initialize');
        expect(init.params.clientInfo).toMatchObject({ name: 'Agora', title: 'Agora' });
        expect(lines.some(l => l.method === 'initialized')).toBe(true);
        expect(lines.find(l => l.method === 'thread/start').params).toMatchObject({ model: 'gpt-test', approvalPolicy: 'on-request', sandbox: 'workspace-write', cwd: tmp.dir });
        expect(lines.find(l => l.method === 'turn/start').params).toMatchObject({ input: [{ type: 'text', text: 'Do the work' }], effort: 'high' });
        // An approval request no rule allows and no card can answer is declined
        expect(lines.find(l => l.id === 900).result).toEqual({ decision: 'decline' });
    });

    it('resumes a saved thread', async () => {
        const { lines } = await run('ok', { threadId: '0199a000-0000-7000-8000-0000000000aa' });
        expect(lines.find(l => l.method === 'thread/resume').params).toMatchObject({ threadId: '0199a000-0000-7000-8000-0000000000aa', excludeTurns: true });
        expect(lines.some(l => l.method === 'thread/start')).toBe(false);
    });

    it('on a 401 refreshes, restarts app-server with the new token, initializes and resumes the thread', async () => {
        const refresh = vi.fn(async () => 'new');
        const { result, lines } = await run('expire', { refresh }, 'old');
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(true);
        const starts = lines.filter(l => l.start);
        expect(starts.map(s => s.token)).toEqual(['old', 'new']);
        expect(starts.every(s => !s.argv.join(' ').includes('new') && !s.argv.join(' ').includes('old'))).toBe(true);
        expect(lines.filter(l => l.method === 'initialize')).toHaveLength(2);
        const resume = lines.find(l => l.method === 'thread/resume');
        expect(resume.params.threadId).toBe('0199a000-0000-7000-8000-000000000001');
    });

    it('reports a sign-in problem when the refresh fails', async () => {
        const refresh = vi.fn(async () => { throw new SiwcError('siwc_reauth_required', 'expired'); });
        const { result } = await run('expire', { refresh }, 'old');
        expect(result).toMatchObject({ success: false, error: 'siwc_reauth_required' });
    });

    it('maps 403 subscription_sharing_user_not_eligible to a clear, non-retried error', async () => {
        const { result } = await run('ineligible');
        expect(result).toMatchObject({ success: false, error: 'siwc_not_eligible' });
    });

    it('treats the plan usage limit as a rate limit', async () => {
        const { result } = await run('limit');
        expect(result).toMatchObject({ success: false, error: 'siwc_usage_limit', rateLimit: { resetAt: null } });
    });
});

describe('Settings → Agents connect request', () => {
    it('signs in on this host, reports connected with the account email and saves the binding', async () => {
        const config = siwcConfig(tmp.dir);
        const m = mockOpenAI(); const b = browser();
        m.tokenResponse = () => ({ status: 200, json: tokenJson(SCOPES, { nonce: new URL(String(b.seen[0])).searchParams.get('nonce') }) });
        const reportPlan = vi.fn(async () => ({ planOwnerId: OWNER }));
        const api = { reportPlan } as unknown as HostApi;
        await handlePlanRequest(config, api, { profile: 'builder', action: 'connect', requestedBy: OWNER },
            { signal: new AbortController().signal, log: () => {}, pause: async () => {}, stopping: () => false, open: b.open, fetch: m.fetch, issuer: ISSUER });
        expect(reportPlan).toHaveBeenCalledWith('builder', { status: 'connected', accountLabel: 'plan@example.com' }, expect.anything());
        expect(JSON.stringify(reportPlan.mock.calls)).not.toContain('at_1');
        expect((await readRecord(config.siwc.dir!, 'builder'))!.agora_user_id).toBe(OWNER);
    });
    it('reports a fixed error code when sign-in fails', async () => {
        const config = siwcConfig(tmp.dir);
        const m = mockOpenAI();
        const reportPlan = vi.fn(async () => ({ planOwnerId: null }));
        await handlePlanRequest(config, { reportPlan } as unknown as HostApi, { profile: 'builder', action: 'connect', requestedBy: OWNER },
            { signal: new AbortController().signal, log: () => {}, pause: async () => {}, stopping: () => false, open: browser({ error: 'access_denied' }).open, fetch: m.fetch, issuer: ISSUER });
        expect(reportPlan).toHaveBeenCalledWith('builder', { status: 'failed', error: 'consent_declined' }, expect.anything());
    });
});

import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { signEdge } from '../../src/lib/boxes/contract';
import { rotateBoxTokens } from '../../src/lib/boxes/tokens';
import { recordEdgeRequest } from '../../src/lib/boxes/edge-requests';

/**
 * CLI login inside a box (docs/agent-boxes.md §8.2; src/routes/boxes.ts, src/routes/box-hosts.ts):
 * the owner asks, the box's host claims, reports the URL and code, reads a pasted code once, and
 * reports the result. Nothing of it stays in Agora after the login ends.
 */

const EDGE_SECRET = '12'.repeat(32);
process.env.AGORA_EDGE_SECRET = EDGE_SECRET;

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;

type Box = { id: string; host: Record<string, string> };
async function makeBox(name: string, adapter: 'claude' | 'codex'): Promise<Box> {
    const res = await ctx.request.post(`/servers/${serverId}/boxes`).set(owner.auth).send({ name, adapter, homeChannelId: channelId });
    expect(res.status).toBe(201);
    const t = await rotateBoxTokens(ctx.db, res.body.box.id);
    // A host request through its own edge, as the box's agora-host makes it
    return { id: res.body.box.id, host: { Authorization: `AgentHost ${t.hostToken}`, ...signEdge(EDGE_SECRET, res.body.box.id, t.generation) } };
}
const ownerLogin = async (box: Box) => (await ctx.request.get(`/boxes/${box.id}/login`).set(owner.auth)).body.login;
const boxState = async (box: Box) => (await ctx.db.query(`SELECT login_state FROM agent_boxes WHERE id = $1`, [box.id])).rows[0].login_state;
const report = (box: Box, id: string, body: object) => ctx.request.post(`/agent-hosts/@me/box-login/${id}`).set(box.host).send(body);
/** The box as Settings → Agents lists it (members may list boxes too). */
const listed = async (box: Box) => (await ctx.request.get(`/servers/${serverId}/boxes`).set(member.auth)).body.boxes.find((x: any) => x.id === box.id);

beforeAll(async () => { ctx = await setupTestApp(); });
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'loginowner');
    member = await authedUser(ctx.request, 'loginmember');
    const s = await createServer(ctx.request, owner.auth, 'Logins');
    serverId = s.serverId; channelId = s.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
});
afterAll(async () => { await ctx.close(); });

test('Claude: request, claim, URL, pasted code read once, success clears everything', async () => {
    const box = await makeBox('alpha', 'claude');
    expect((await ctx.request.get('/agent-hosts/@me/box-login').set(box.host)).status).toBe(204);
    expect(await ownerLogin(box)).toBeNull();

    const started = await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth);
    expect(started.status).toBe(201);
    const id = started.body.login.id;
    expect(started.body.login).toMatchObject({ status: 'requested', verificationUrl: null, userCode: null });
    expect(await boxState(box)).toBe('pending');
    // Only the owner starts one
    expect((await ctx.request.post(`/boxes/${box.id}/login`).set(member.auth)).status).toBe(403);

    // A report before the claim is refused
    expect((await report(box, id, { status: 'awaiting_code', verificationUrl: 'https://claude.ai/oauth?x=1' })).body).toEqual({ error: 'login_closed' });
    const claim = await ctx.request.get('/agent-hosts/@me/box-login').set(box.host);
    expect(claim.body).toEqual({ id, adapter: 'claude', profile: 'alpha' });
    expect((await ctx.request.get('/agent-hosts/@me/box-login').set(box.host)).status).toBe(204);
    expect((await ownerLogin(box)).status).toBe('claimed');

    // Pasting before the CLI asks for it is refused
    expect((await ctx.request.post(`/boxes/${box.id}/login/code`).set(owner.auth).send({ code: 'early' })).status).toBe(409);
    expect((await report(box, id, { status: 'awaiting_code', verificationUrl: 'http://claude.ai/plain' })).status).toBe(400);
    // A box could report any page; the owner is only sent to the provider's own hosts
    for (const verificationUrl of ['https://claude-ai.evil.example/oauth', 'https://claude.ai.evil.example/x', 'https://evil.example/?claude.ai', 'https://chatgpt.com/device', 'https://user@claude.ai/x']) {
        const r = await report(box, id, { status: 'awaiting_code', verificationUrl });
        expect([verificationUrl, r.status, r.body.error]).toEqual([verificationUrl, 400, 'verification_url_not_allowed']);
    }
    expect((await report(box, id, { status: 'awaiting_code', verificationUrl: 'https://claude.ai/oauth?x=1' })).body).toEqual({ ok: true });
    expect(await ownerLogin(box)).toMatchObject({ id, status: 'awaiting_code', verificationUrl: 'https://claude.ai/oauth?x=1', userCode: null });

    // No code yet
    expect((await ctx.request.get(`/agent-hosts/@me/box-login/${id}/code`).set(box.host)).status).toBe(204);
    expect((await ctx.request.post(`/boxes/${box.id}/login/code`).set(member.auth).send({ code: 'abc#def' })).status).toBe(403);
    const pasted = await ctx.request.post(`/boxes/${box.id}/login/code`).set(owner.auth).send({ code: 'abc#def' });
    expect(pasted.status).toBe(200);
    expect(JSON.stringify(pasted.body)).not.toContain('abc#def');
    const stored = (await ctx.db.query(`SELECT pasted_code_enc FROM box_login_requests WHERE id = $1`, [id])).rows[0];
    expect(stored.pasted_code_enc).not.toContain('abc#def');

    const code = await ctx.request.get(`/agent-hosts/@me/box-login/${id}/code`).set(box.host);
    expect(code.body).toEqual({ code: 'abc#def' });
    // Once
    expect((await ctx.request.get(`/agent-hosts/@me/box-login/${id}/code`).set(box.host)).status).toBe(204);
    expect((await ownerLogin(box)).status).toBe('code_sent');
    expect((await ctx.db.query(`SELECT pasted_code_enc FROM box_login_requests WHERE id = $1`, [id])).rows[0].pasted_code_enc).toBeNull();

    expect((await report(box, id, { status: 'succeeded' })).body).toEqual({ ok: true });
    expect(await boxState(box)).toBe('logged_in');
    expect(await ownerLogin(box)).toMatchObject({ status: 'succeeded', verificationUrl: null, userCode: null });
    const row = (await ctx.db.query(`SELECT verification_url, user_code, pasted_code_enc FROM box_login_requests WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ verification_url: null, user_code: null, pasted_code_enc: null });
    // Ended: further reports are refused
    expect((await report(box, id, { status: 'failed', error: 'late' })).body).toEqual({ error: 'login_closed' });
    const list = await ctx.request.get(`/servers/${serverId}/boxes`).set(owner.auth);
    expect(list.body.boxes[0].loginState).toBe('logged_in');
});

test('Codex: URL and device code shown to the owner; failure, cancel and expiry', async () => {
    const box = await makeBox('beta', 'codex');
    const first = (await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth)).body.login.id;
    expect((await ctx.request.get('/agent-hosts/@me/box-login').set(box.host)).body).toMatchObject({ id: first, adapter: 'codex', profile: 'beta' });
    expect((await report(box, first, { status: 'awaiting_user', verificationUrl: 'https://auth.openai.com/codex/device' })).body).toEqual({ error: 'userCode is required' });
    expect((await report(box, first, { status: 'awaiting_user', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' })).status).toBe(200);
    expect(await ownerLogin(box)).toMatchObject({ status: 'awaiting_user', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
    expect((await report(box, first, { status: 'awaiting_code', verificationUrl: 'https://x.io' })).body).toMatchObject({ error: 'bad_transition' });
    expect((await report(box, first, { status: 'failed', error: 'Bad Code' })).status).toBe(400);
    expect((await report(box, first, { status: 'failed', error: 'login_timeout' })).status).toBe(200);
    expect(await boxState(box)).toBe('failed');
    expect(await ownerLogin(box)).toMatchObject({ status: 'failed', error: 'login_timeout', verificationUrl: null, userCode: null });

    // Cancel: the host's next report is refused and the box isn't left pending
    const second = (await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth)).body.login.id;
    await ctx.request.get('/agent-hosts/@me/box-login').set(box.host);
    expect((await ctx.request.delete(`/boxes/${box.id}/login`).set(owner.auth)).status).toBe(204);
    expect((await report(box, second, { status: 'succeeded' })).body).toEqual({ error: 'login_closed' });
    expect(await boxState(box)).toBe('none');

    // A new Log in replaces an open one
    const third = (await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth)).body.login.id;
    const fourth = (await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth)).body.login.id;
    expect((await ctx.db.query(`SELECT status FROM box_login_requests WHERE id = $1`, [third])).rows[0].status).toBe('cancelled');

    // Expiry after 10 minutes clears it
    await ctx.request.get('/agent-hosts/@me/box-login').set(box.host);
    await report(box, fourth, { status: 'awaiting_user', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'WXYZ-0000' });
    await ctx.db.query(`UPDATE box_login_requests SET expires_at = NOW() - interval '1 second' WHERE id = $1`, [fourth]);
    expect(await ownerLogin(box)).toMatchObject({ id: fourth, status: 'expired', verificationUrl: null, userCode: null });
    expect((await report(box, fourth, { status: 'succeeded' })).body).toEqual({ error: 'login_closed' });
    expect(await boxState(box)).toBe('failed');

    // Another box's host can't see or report this box's logins
    const other = await makeBox('gamma', 'codex');
    const fifth = (await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth)).body.login.id;
    expect((await ctx.request.get('/agent-hosts/@me/box-login').set(other.host)).status).toBe(204);
    expect((await report(other, fifth, { status: 'succeeded' })).status).toBe(404);
    expect((await ctx.request.get(`/agent-hosts/@me/box-login/${fifth}/code`).set(other.host)).status).toBe(404);
});

test('deleting the box ends its open login', async () => {
    const box = await makeBox('delta', 'claude');
    const id = (await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth)).body.login.id;
    await ctx.request.delete(`/boxes/${box.id}`).set(owner.auth);
    expect((await ctx.db.query(`SELECT status FROM box_login_requests WHERE id = $1`, [id])).rows[0].status).toBe('cancelled');
    expect((await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth)).body).toEqual({ error: 'box_deleted' });
});

// Security review #1: the agent in a box can read its own host token, so a box never sets its
// own auth: a report that differs from what the owner chose is refused and changes nothing
it('a box host cannot change its profile auth (subscription stays owner-only)', async () => {
    const box = await makeBox('gamma', 'claude');
    const name = (await ctx.db.query(`SELECT p.name FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id WHERE b.id = $1`, [box.id])).rows[0].name;
    const flip = await ctx.request.post('/agent-hosts/@me/profiles').set(box.host)
        .send({ profiles: [{ name, adapter: 'claude', authMode: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY', runApproval: false }] });
    expect([flip.status, flip.body.error]).toEqual([409, 'box_auth_is_owner_set']);
    expect((await ctx.db.query(`SELECT p.auth_mode FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id WHERE b.id = $1`, [box.id])).rows[0].auth_mode).toBe('subscription');
    const same = await ctx.request.post('/agent-hosts/@me/profiles').set(box.host)
        .send({ profiles: [{ name, adapter: 'claude', authMode: 'subscription', apiKeyEnv: null, runApproval: false }] });
    expect([same.status, same.body.updated]).toEqual([200, [name]]);
});

// Seen live: Claude's code exchange at platform.claude.com was refused by the edge, and the
// owner only saw "login_failed". The login now says which domain it waits on, and fails as such.
it('a login blocked on a domain says which, while it runs and when it fails', async () => {
    const box = await makeBox('delta2', 'claude');
    const id = (await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth)).body.login.id;
    expect((await ctx.request.get('/agent-hosts/@me/box-login').set(box.host)).status).toBe(200);
    expect((await report(box, id, { status: 'awaiting_code', verificationUrl: 'https://claude.ai/oauth/authorize?x=1' })).status).toBe(200);
    expect((await ownerLogin(box)).blockedHosts).toEqual([]);
    // The edge refuses the CLI's token exchange
    const gen = Number((await ctx.db.query(`SELECT generation FROM agent_boxes WHERE id = $1`, [box.id])).rows[0].generation);
    const client = await ctx.db.connect();
    try {
        await client.query('BEGIN');
        await recordEdgeRequest(client, { boxId: box.id, generation: gen, kind: 'domain', subject: { host: 'platform.claude.com' } });
        await client.query('COMMIT');
    } finally { client.release(); }
    expect(await ownerLogin(box)).toMatchObject({ status: 'awaiting_code', blockedHosts: ['platform.claude.com'] });
    expect((await report(box, id, { status: 'failed', error: 'login_failed' })).status).toBe(200);
    expect(await ownerLogin(box)).toMatchObject({ status: 'failed', error: 'needs_domain', blockedHosts: ['platform.claude.com'] });
    // The box list says so too: not "running" next to "login failed", but what to allow
    expect(await listed(box)).toMatchObject({ loginState: 'failed', loginError: 'needs_domain', loginBlockedHosts: ['platform.claude.com'] });
    // Not the code, not the URL
    const row = (await ctx.db.query(`SELECT verification_url, user_code FROM box_login_requests WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ verification_url: null, user_code: null });

    // A retry without allowing it: the card is older than this login, and still blocks it
    const id2 = (await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth)).body.login.id;
    expect((await ctx.request.get('/agent-hosts/@me/box-login').set(box.host)).status).toBe(200);
    expect((await report(box, id2, { status: 'awaiting_code', verificationUrl: 'https://claude.ai/oauth/authorize?x=2' })).status).toBe(200);
    expect((await ownerLogin(box)).blockedHosts).toEqual(['platform.claude.com']);
    // A host code other than the CLI's own failure stays as it is
    expect((await report(box, id2, { status: 'failed', error: 'invalid_code' })).status).toBe(200);
    expect(await ownerLogin(box)).toMatchObject({ status: 'failed', error: 'invalid_code', blockedHosts: [] });
    expect(await listed(box)).toMatchObject({ loginState: 'failed', loginError: 'invalid_code', loginBlockedHosts: [] });
});

it('only the CLI provider domains count as a login blocker', async () => {
    const box = await makeBox('delta3', 'claude');
    const gen = Number((await ctx.db.query(`SELECT generation FROM agent_boxes WHERE id = $1`, [box.id])).rows[0].generation);
    const client = await ctx.db.connect();
    try {
        await client.query('BEGIN');
        await recordEdgeRequest(client, { boxId: box.id, generation: gen, kind: 'domain', subject: { host: 'example.com' } });
        await client.query('COMMIT');
    } finally { client.release(); }
    const id = (await ctx.request.post(`/boxes/${box.id}/login`).set(owner.auth)).body.login.id;
    expect((await ctx.request.get('/agent-hosts/@me/box-login').set(box.host)).status).toBe(200);
    expect((await report(box, id, { status: 'awaiting_code', verificationUrl: 'https://claude.ai/oauth/authorize?x=3' })).status).toBe(200);
    expect((await ownerLogin(box)).blockedHosts).toEqual([]);
    expect((await report(box, id, { status: 'failed', error: 'login_failed' })).status).toBe(200);
    expect((await ownerLogin(box)).error).toBe('login_failed');
});

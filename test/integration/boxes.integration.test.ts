import { vi } from 'vitest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { defaultAllowlist, signEdge } from '../../src/lib/boxes/contract';
import { recordEdgeRequest } from '../../src/lib/boxes/edge-requests';
import { rotateBoxTokens } from '../../src/lib/boxes/tokens';
import { decryptString } from '../../src/lib/encryption';
import { config } from '../../src/config';

/**
 * Owner API for agent boxes (src/routes/boxes.ts, docs/agent-boxes.md): who may do what,
 * what create writes, actions and their pending_action contract with boxd, delete revoking
 * tokens at once, restore and purge, push policies, the GitHub credential, edge decisions.
 */

const EDGE_SECRET = 'ab'.repeat(32);
process.env.AGORA_EDGE_SECRET = EDGE_SECRET;

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let outsider: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let botAuth: { Authorization: string };

async function createBox(body: Record<string, unknown> = {}, auth = owner.auth) {
    return ctx.request.post(`/servers/${serverId}/boxes`).set(auth)
        .send({ name: 'alpha', adapter: 'claude', homeChannelId: channelId, ...body });
}

beforeAll(async () => {
    ctx = await setupTestApp();
});
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'boxowner');
    member = await authedUser(ctx.request, 'boxmember');
    outsider = await authedUser(ctx.request, 'boxoutsider');
    const s = await createServer(ctx.request, owner.auth, 'Boxes');
    serverId = s.serverId; channelId = s.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'plainbot' });
    const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
    botAuth = { Authorization: `Bot ${token.body.token}` };
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await ctx.close(); });

describe('create and list', () => {
    test('owner creates a box: bot with home channel access, box host, profile, default allowlist, repos', async () => {
        const res = await createBox({ repos: ['acme/web', 'acme/web', 'acme/api'], model: 'claude-x' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const box = res.body.box;
        expect(box).toMatchObject({
            name: 'alpha', adapter: 'claude', auth: 'subscription', state: 'creating', desiredState: 'running', pendingAction: null,
            generation: 0, loginState: 'none', homeChannelId: channelId, allowedDomains: defaultAllowlist('claude'),
            repos: ['acme/api', 'acme/web'], cpus: 2, memoryMb: 4096, pids: 1024, deletedAt: null, policies: [],
        });

        const row = (await ctx.db.query(
            `SELECT b.host_id, p.bot_id, p.host_mode, p.workdir_alias, p.auth_mode, p.model, h.kind, h.box_id, h.box_generation, h.revoked_at
             FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id JOIN agent_hosts h ON h.id = b.host_id WHERE b.id = $1`, [box.id]
        )).rows[0];
        expect(row).toMatchObject({ host_mode: false, workdir_alias: 'work', auth_mode: 'subscription', model: 'claude-x', kind: 'box', box_generation: null, revoked_at: null });
        expect(row.box_id.trim()).toBe(box.id);
        // boxd mints the tokens at its first container creation: none yet
        expect((await ctx.db.query(`SELECT 1 FROM bot_tokens WHERE bot_id = $1`, [row.bot_id])).rows).toHaveLength(0);
        const access = await ctx.db.query(`SELECT channel_id FROM bot_channel_access WHERE bot_id = $1`, [row.bot_id]);
        expect(access.rows.map(r => r.channel_id.trim())).toEqual([channelId]);

        // The profile shows as boxed in Settings → Agents, and isn't host mode
        const profiles = await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(member.auth);
        expect(profiles.body.find((p: any) => p.name === 'alpha')).toMatchObject({ boxed: true, hostMode: false, workdirAlias: 'work' });

        const list = await ctx.request.get(`/servers/${serverId}/boxes`).set(member.auth);
        expect(list.status).toBe(200);
        expect(list.body.boxes.map((b: any) => b.id)).toEqual([box.id]);
    });

    test('codex default allowlist, api_key auth stores the key encrypted', async () => {
        expect((await createBox({ name: 'beta', adapter: 'codex', auth: 'api_key' })).body).toEqual({ error: 'api_key_required' });
        expect((await createBox({ name: 'beta', adapter: 'codex', apiKey: 'sk-test-1234567890' })).body).toEqual({ error: 'api_key_needs_api_key_auth' });
        const res = await createBox({ name: 'beta', adapter: 'codex', auth: 'api_key', apiKey: 'sk-test-1234567890' });
        expect(res.status).toBe(201);
        expect(res.body.box.allowedDomains).toEqual(defaultAllowlist('codex'));
        expect(JSON.stringify(res.body)).not.toContain('sk-test');
        const row = (await ctx.db.query(`SELECT b.api_key_env, b.api_key_enc, b.api_key_iv, b.api_key_tag, p.api_key_env AS profile_env FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id WHERE b.id = $1`, [res.body.box.id])).rows[0];
        expect(row.api_key_env).toBe('CODEX_API_KEY');
        expect(row.profile_env).toBe('CODEX_API_KEY');
        expect(row.api_key_enc).not.toContain('sk-test');
        expect(decryptString(row.api_key_enc, config.encryptionKey, row.api_key_iv, row.api_key_tag)).toBe('sk-test-1234567890');
    });

    test('opencode: an OpenRouter key and a model, never a subscription; nothing to log in', async () => {
        // API key only (box adapter registry): its default sign-in, a subscription is refused
        expect((await createBox({ name: 'qwen', adapter: 'opencode', model: 'qwen/qwen3-coder' })).body).toEqual({ error: 'api_key_required' });
        expect((await createBox({ name: 'qwen', adapter: 'opencode', auth: 'subscription', model: 'qwen/qwen3-coder' })).body)
            .toMatchObject({ error: 'auth_not_supported' });
        expect((await createBox({ name: 'qwen', adapter: 'opencode', auth: 'api_key', apiKey: 'sk-or-test-1234567890' })).body)
            .toMatchObject({ error: 'model_required' });
        // A model agora-host can't claim with would never wake, and the box's profile can't be edited
        for (const model of ['qwen/qwen3-coder ', 'qwen qwen3', '/qwen'])
            expect((await createBox({ name: 'qwen', adapter: 'opencode', apiKey: 'sk-or-test-1234567890', model })).status, model).toBe(400);
        // An :online model searches the web on OpenRouter's side, around the edge
        for (const model of ['qwen/qwen3-coder:online', 'openrouter/qwen/qwen3-coder:ONLINE'])
            expect((await createBox({ name: 'qwen', adapter: 'opencode', apiKey: 'sk-or-test-1234567890', model })).body, model)
                .toMatchObject({ error: 'model_not_allowed' });
        expect((await createBox({ name: 'gpt', adapter: 'codex', model: 'gpt-x:online' })).body).toMatchObject({ error: 'model_not_allowed' });
        const res = await createBox({ name: 'qwen', adapter: 'opencode', apiKey: 'sk-or-test-1234567890', model: 'qwen/qwen3-coder' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.box).toMatchObject({ adapter: 'opencode', auth: 'api_key', loginState: 'none' });
        expect(res.body.box.allowedDomains).toEqual(['openrouter.ai', 'models.opencode.ai', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']);
        expect(JSON.stringify(res.body)).not.toContain('sk-or-test');
        const row = (await ctx.db.query(
            `SELECT b.api_key_env, b.api_key_enc, b.api_key_iv, b.api_key_tag, p.api_key_env AS profile_env, p.auth_mode, p.model
             FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id WHERE b.id = $1`, [res.body.box.id])).rows[0];
        expect(row).toMatchObject({ api_key_env: 'OPENROUTER_API_KEY', profile_env: 'OPENROUTER_API_KEY', auth_mode: 'api_key', model: 'qwen/qwen3-coder' });
        expect(decryptString(row.api_key_enc, config.encryptionKey, row.api_key_iv, row.api_key_tag)).toBe('sk-or-test-1234567890');
        // opencode has no login of its own: Log in is refused, and no request is left for the box's host
        const login = await ctx.request.post(`/boxes/${res.body.box.id}/login`).set(owner.auth);
        expect(login.status).toBe(409);
        expect(login.body).toEqual({ error: 'login_not_supported' });
        expect((await ctx.db.query(`SELECT 1 FROM box_login_requests WHERE box_id = $1`, [res.body.box.id])).rows).toHaveLength(0);
    });

    test('names are unique across users, bots and profiles; channels and repos are checked', async () => {
        expect((await createBox()).status).toBe(201);
        expect((await createBox()).status).toBe(409);
        expect((await createBox({ name: 'boxmember' })).body).toEqual({ error: 'name_taken' });
        expect((await createBox({ name: 'gamma', homeChannelId: '01JBQXAAAAAAAAAAAAAAAAAAAA' })).body).toEqual({ error: 'unknown_channel' });
        expect((await createBox({ name: 'gamma', repos: ['acme/..'] })).status).toBe(400);
        expect((await createBox({ name: 'gamma', repos: ['https://github.com/acme/web'] })).status).toBe(400);
        expect((await createBox({ name: 'gamma', adapter: 'gemini' })).status).toBe(400);
        expect((await createBox({ name: 'Gamma' })).status).toBe(400);
    });

    test('a box host takes no other profile, and its profile is managed through the box', async () => {
        const box = (await createBox()).body.box;
        const hostId = (await ctx.db.query(`SELECT host_id FROM agent_boxes WHERE id = $1`, [box.id])).rows[0].host_id.trim();
        const add = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth).send({ hostModeAck: true, name: 'extra', adapter: 'claude', hostId, workdirAlias: 'x' });
        expect(add.body).toEqual({ error: 'Unknown host' });
        const profileId = (await ctx.db.query(`SELECT profile_id FROM agent_boxes WHERE id = $1`, [box.id])).rows[0].profile_id.trim();
        expect((await ctx.request.patch(`/servers/${serverId}/agent-profiles/${profileId}`).set(owner.auth).send({ model: 'x' })).status).toBe(409);
        expect((await ctx.request.delete(`/servers/${serverId}/agent-profiles/${profileId}`).set(owner.auth)).status).toBe(409);
        expect((await ctx.db.query(`SELECT 1 FROM agent_boxes WHERE id = $1`, [box.id])).rows).toHaveLength(1);
    });
});

describe('owner only', () => {
    test('member, non-member and bot are refused; non-members cannot list', async () => {
        const box = (await createBox()).body.box;
        const calls: Array<[string, string, object?]> = [
            ['post', `/servers/${serverId}/boxes`, { name: 'zeta', adapter: 'claude', homeChannelId: channelId }],
            ['patch', `/boxes/${box.id}`, { cpus: 1 }],
            ['post', `/boxes/${box.id}/actions`, { action: 'restart' }],
            ['delete', `/boxes/${box.id}`],
            ['post', `/boxes/${box.id}/restore`],
            ['post', `/boxes/${box.id}/purge`],
            ['put', `/boxes/${box.id}/policies/${channelId}`, { autoPush: true, autoPr: false }],
            ['post', `/boxes/${box.id}/login`],
            ['get', `/boxes/${box.id}/login`],
            ['post', `/boxes/${box.id}/login/code`, { code: 'abc' }],
            ['delete', `/boxes/${box.id}/login`],
            ['put', `/servers/${serverId}/github-credential`, { token: 'ghp_' + 'a'.repeat(36) }],
            ['get', `/servers/${serverId}/github-credential`],
            ['delete', `/servers/${serverId}/github-credential`],
        ];
        for (const auth of [member.auth, outsider.auth, botAuth]) {
            for (const [method, url, body] of calls) {
                const req = (ctx.request as any)[method](url).set(auth);
                const res = body ? await req.send(body) : await req;
                expect(res.status, `${method} ${url}`).toBe(403);
            }
        }
        expect((await ctx.request.get(`/servers/${serverId}/boxes`).set(outsider.auth)).status).toBe(403);
        expect((await ctx.request.get(`/servers/${serverId}/boxes`).set(botAuth)).status).toBe(403);
        // Nothing changed
        const row = (await ctx.db.query(`SELECT desired_state, pending_action, cpus FROM agent_boxes WHERE id = $1`, [box.id])).rows[0];
        expect(row).toEqual({ desired_state: 'running', pending_action: null, cpus: '2.00' });
        expect((await ctx.db.query(`SELECT 1 FROM box_login_requests`)).rows).toHaveLength(0);
    });

    test('unknown box is 404 for the owner', async () => {
        expect((await ctx.request.patch(`/boxes/01JBQXAAAAAAAAAAAAAAAAAAAA`).set(owner.auth).send({ cpus: 1 })).status).toBe(404);
    });
});

describe('settings and actions', () => {
    test('PATCH sets allowlist, repos, limits and home channel', async () => {
        const box = (await createBox({ repos: ['acme/web'] })).body.box;
        await ctx.db.query(`UPDATE box_repos SET default_branch = 'main' WHERE box_id = $1`, [box.id]);
        const other = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'work', channelType: 3 });
        expect(other.status).toBe(201);
        const res = await ctx.request.patch(`/boxes/${box.id}`).set(owner.auth).send({
            allowedDomains: ['api.anthropic.com', '*.example.com', '*.example.com'], repos: ['acme/web', 'acme/docs'],
            cpus: 1.5, memoryMb: 2048, pids: 256, homeChannelId: other.body.id,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.box).toMatchObject({ allowedDomains: ['api.anthropic.com', '*.example.com'], repos: ['acme/docs', 'acme/web'], cpus: 1.5, memoryMb: 2048, pids: 256, homeChannelId: other.body.id });
        // The kept repo keeps its cached default branch
        expect((await ctx.db.query(`SELECT default_branch FROM box_repos WHERE box_id = $1 AND repo = 'web'`, [box.id])).rows[0].default_branch).toBe('main');
        const access = await ctx.db.query(`SELECT a.channel_id FROM bot_channel_access a JOIN agent_profiles p ON p.bot_id = a.bot_id JOIN agent_boxes b ON b.profile_id = p.id WHERE b.id = $1`, [box.id]);
        expect(access.rows.map(r => r.channel_id.trim()).sort()).toEqual([channelId, other.body.id].sort());

        for (const bad of [{ allowedDomains: ['*'] }, { allowedDomains: ['10.0.0.1'] }, { cpus: 0 }, { memoryMb: 100 }, { pids: 1 }, {}]) {
            expect((await ctx.request.patch(`/boxes/${box.id}`).set(owner.auth).send(bad)).status, JSON.stringify(bad)).toBe(400);
        }
        // A wildcard over a public suffix would reach everyone's sites under it
        for (const wide of ['*.co.uk', '*.github.io', '*.herokuapp.com', '*.amazonaws.com', '*.windows.net']) {
            const res = await ctx.request.patch(`/boxes/${box.id}`).set(owner.auth).send({ allowedDomains: ['api.anthropic.com', wide] });
            expect(res.status, wide).toBe(400);
            expect(res.body.error).toBe('invalid_domain');
        }
        // An operator's own domain is fine
        expect((await ctx.request.patch(`/boxes/${box.id}`).set(owner.auth).send({ allowedDomains: ['*.oaiusercontent.com', '*.evil.github.io'] })).status).toBe(200);
    });

    test('a changed repo list queues a rebuild (the box reads it at creation); same-name repos are refused', async () => {
        const box = (await createBox()).body.box;
        const pending = async () => (await ctx.db.query(`SELECT pending_action FROM agent_boxes WHERE id = $1`, [box.id])).rows[0].pending_action;
        expect(await pending()).toBeNull();
        expect((await ctx.request.patch(`/boxes/${box.id}`).set(owner.auth).send({ repos: ['acme/web'] })).status).toBe(200);
        expect(await pending()).toBe('rebuild');
        // The same list again changes nothing; a pending reset is never weakened
        await ctx.db.query(`UPDATE agent_boxes SET pending_action = 'reset' WHERE id = $1`, [box.id]);
        expect((await ctx.request.patch(`/boxes/${box.id}`).set(owner.auth).send({ repos: ['acme/web', 'acme/docs'] })).status).toBe(200);
        expect(await pending()).toBe('reset');
        // ownerA/web and ownerB/web would both clone to ~/work/web
        const clash = await ctx.request.patch(`/boxes/${box.id}`).set(owner.auth).send({ repos: ['acme/web', 'other/web'] });
        expect([clash.status, clash.body.error]).toEqual([400, 'repo_name_collision']);
        expect((await createBox({ name: 'clash', repos: ['a/x', 'b/X'] })).body.error).toBe('repo_name_collision');
    });

    test('actions set desired_state or pending_action with its timestamp; reset needs the name', async () => {
        const box = (await createBox()).body.box;
        const act = (body: object) => ctx.request.post(`/boxes/${box.id}/actions`).set(owner.auth).send(body);
        const row = async () => (await ctx.db.query(`SELECT desired_state, pending_action, action_requested_at, login_state FROM agent_boxes WHERE id = $1`, [box.id])).rows[0];

        expect((await act({ action: 'stop' })).body.box.desiredState).toBe('stopped');
        expect((await act({ action: 'start' })).body.box).toMatchObject({ desiredState: 'running', pendingAction: null });
        const restart = await act({ action: 'restart' });
        expect(restart.body.box.pendingAction).toBe('restart');
        expect((await row()).action_requested_at).not.toBeNull();
        expect((await act({ action: 'rebuild' })).body.box.pendingAction).toBe('rebuild');
        // A weaker action doesn't replace a stronger pending one
        expect((await act({ action: 'restart' })).body.box.pendingAction).toBe('rebuild');

        expect((await act({ action: 'reset' })).body).toMatchObject({ error: 'confirm_required' });
        expect((await act({ action: 'reset', confirm: 'wrong' })).status).toBe(400);
        expect((await row()).pending_action).toBe('rebuild');
        await ctx.db.query(`UPDATE agent_boxes SET login_state = 'logged_in' WHERE id = $1`, [box.id]);
        expect((await act({ action: 'reset', confirm: 'alpha' })).body.box).toMatchObject({ pendingAction: 'reset', loginState: 'none' });

        // A failed box is left alone by boxd until an action is set: start restarts it
        await ctx.db.query(`UPDATE agent_boxes SET state = 'failed', pending_action = NULL, action_requested_at = NULL, desired_state = 'stopped' WHERE id = $1`, [box.id]);
        expect((await act({ action: 'start' })).body.box).toMatchObject({ desiredState: 'running', pendingAction: 'restart' });
        expect((await row()).action_requested_at).not.toBeNull();
        expect((await act({ action: 'explode' })).status).toBe(400);
    });

    test('push policies per channel', async () => {
        const box = (await createBox()).body.box;
        const res = await ctx.request.put(`/boxes/${box.id}/policies/${channelId}`).set(owner.auth).send({ autoPush: true, autoPr: false });
        expect(res.body).toEqual({ policy: { channelId, autoPush: true, autoPr: false } });
        await ctx.request.put(`/boxes/${box.id}/policies/${channelId}`).set(owner.auth).send({ autoPush: true, autoPr: true });
        const list = await ctx.request.get(`/servers/${serverId}/boxes`).set(owner.auth);
        expect(list.body.boxes[0].policies).toEqual([{ channelId, autoPush: true, autoPr: true }]);
        expect((await ctx.request.put(`/boxes/${box.id}/policies/01JBQXAAAAAAAAAAAAAAAAAAAA`).set(owner.auth).send({ autoPush: true, autoPr: true })).status).toBe(400);
    });
});

describe('delete, restore, purge', () => {
    test('delete revokes the box host and bot tokens at once; restore and purge follow the grace period', async () => {
        const box = (await createBox()).body.box;
        const tokens = await rotateBoxTokens(ctx.db, box.id);
        const edge = () => signEdge(EDGE_SECRET, box.id, tokens.generation);
        const bot = { Authorization: `Bot ${tokens.botToken}` };
        const host = { Authorization: `AgentHost ${tokens.hostToken}` };
        expect((await ctx.request.get('/bots/@me').set(bot).set(edge())).status).toBe(200);
        expect((await ctx.request.get('/agent-hosts/@me/box-login').set(host).set(edge())).status).toBe(204);

        const del = await ctx.request.delete(`/boxes/${box.id}`).set(owner.auth);
        expect(del.status).toBe(204);
        expect((await ctx.request.get('/bots/@me').set(bot).set(edge())).status).toBe(401);
        expect((await ctx.request.get('/agent-hosts/@me/box-login').set(host).set(edge())).status).toBe(401);
        const row = (await ctx.db.query(`SELECT desired_state, deleted_at, volume_purge_after > NOW() + interval '6 days' AS grace FROM agent_boxes WHERE id = $1`, [box.id])).rows[0];
        expect(row.desired_state).toBe('deleted');
        expect(row.deleted_at).not.toBeNull();
        expect(row.grace).toBe(true);
        expect((await ctx.db.query(`SELECT action FROM audit_log WHERE target_id = $1 AND action = 'box_delete'`, [box.id])).rows).toHaveLength(1);

        expect((await ctx.request.post(`/boxes/${box.id}/actions`).set(owner.auth).send({ action: 'start' })).body).toEqual({ error: 'box_deleted' });
        expect((await ctx.request.delete(`/boxes/${box.id}`).set(owner.auth)).status).toBe(409);

        const restored = await ctx.request.post(`/boxes/${box.id}/restore`).set(owner.auth);
        expect(restored.body.box).toMatchObject({ desiredState: 'running', pendingAction: 'rebuild', deletedAt: null, volumePurgeAfter: null });
        expect((await ctx.request.post(`/boxes/${box.id}/restore`).set(owner.auth)).body).toEqual({ error: 'not_restorable' });
        expect((await ctx.request.post(`/boxes/${box.id}/purge`).set(owner.auth)).body).toEqual({ error: 'not_deleted' });

        // Delete again, then delete now
        await ctx.request.delete(`/boxes/${box.id}`).set(owner.auth);
        const purged = await ctx.request.post(`/boxes/${box.id}/purge`).set(owner.auth);
        expect(purged.status).toBe(200);
        expect(new Date(purged.body.box.volumePurgeAfter).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
        expect((await ctx.request.post(`/boxes/${box.id}/restore`).set(owner.auth)).body).toEqual({ error: 'not_restorable' });
    });
});

describe('GitHub credential', () => {
    test('checked against GitHub, stored encrypted, never returned', async () => {
        const token = 'ghp_' + 'a'.repeat(36);
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ login: 'octocat' }), { status: 200 }));
        const put = await ctx.request.put(`/servers/${serverId}/github-credential`).set(owner.auth).send({ token });
        expect(put.body).toEqual({ accountLogin: 'octocat' });
        expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.github.com/user');
        expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe(`Bearer ${token}`);
        const row = (await ctx.db.query(`SELECT * FROM box_github_credentials WHERE server_id = $1`, [serverId])).rows[0];
        expect(row.token_enc).not.toContain('ghp_');
        expect(decryptString(row.token_enc, config.encryptionKey, row.token_iv, row.token_tag)).toBe(token);
        const get = await ctx.request.get(`/servers/${serverId}/github-credential`).set(owner.auth);
        expect(get.body).toMatchObject({ set: true, accountLogin: 'octocat' });
        expect(JSON.stringify(get.body)).not.toContain('ghp_');

        fetchMock.mockResolvedValue(new Response('{"message":"Bad credentials"}', { status: 401 }));
        expect((await ctx.request.put(`/servers/${serverId}/github-credential`).set(owner.auth).send({ token: 'ghp_' + 'b'.repeat(36) })).body).toEqual({ error: 'github_token_invalid' });
        fetchMock.mockRejectedValue(new Error('offline'));
        expect((await ctx.request.put(`/servers/${serverId}/github-credential`).set(owner.auth).send({ token: 'ghp_' + 'b'.repeat(36) })).status).toBe(502);
        // The stored one is unchanged
        expect((await ctx.request.get(`/servers/${serverId}/github-credential`).set(owner.auth)).body.accountLogin).toBe('octocat');

        expect((await ctx.request.delete(`/servers/${serverId}/github-credential`).set(owner.auth)).status).toBe(204);
        expect((await ctx.request.get(`/servers/${serverId}/github-credential`).set(owner.auth)).body).toEqual({ set: false, accountLogin: null, setAt: null });
    });
});

describe('edge request decisions', () => {
    async function pending(boxId: string, kind: 'domain' | 'push', subject: any) {
        // As the edge does: in a transaction (notify() needs one for its savepoint)
        const c = await ctx.db.connect();
        let r;
        try {
            await c.query('BEGIN');
            r = await recordEdgeRequest(c, { boxId, generation: 1, kind, subject });
            await c.query('COMMIT');
        } finally { c.release(); }
        expect(r.created).toBe(true);
        return r.id;
    }
    const card = async (id: string) => (await ctx.db.query(
        `SELECT m.content, m.system_data, m.channel_id FROM box_edge_requests r JOIN messages m ON m.id = r.message_id WHERE r.id = $1`, [id])).rows[0];
    const decide = (id: string, decision: string, auth = owner.auth) => ctx.request.post(`/box-edge-requests/${id}`).set(auth).send({ decision });

    test('allow adds the domain; deny keeps it out; non-owners and bots are refused; one decision only', async () => {
        const box = (await createBox()).body.box;
        const id = await pending(box.id, 'domain', { host: 'example.com' });
        expect((await card(id)).system_data).toMatchObject({ requestId: id, boxId: box.id, boxName: 'alpha', kind: 'domain', status: 'pending', canAlways: false });
        expect((await card(id)).channel_id.trim()).toBe(channelId);

        expect((await decide(id, 'allow', member.auth)).status).toBe(403);
        expect((await decide(id, 'allow', outsider.auth)).status).toBe(403);
        expect((await decide(id, 'allow', botAuth)).status).toBe(403);
        expect((await decide(id, 'maybe')).status).toBe(400);
        expect((await decide('01JBQXAAAAAAAAAAAAAAAAAAAA', 'allow')).status).toBe(404);

        const res = await decide(id, 'allow');
        expect(res.body).toEqual({ status: 'allowed' });
        const after = await card(id);
        expect(after.system_data.status).toBe('allowed');
        expect(after.content).toContain('allowed');
        const list = await ctx.request.get(`/servers/${serverId}/boxes`).set(owner.auth);
        expect(list.body.boxes[0].allowedDomains).toContain('example.com');
        expect((await decide(id, 'deny')).body).toEqual({ error: 'already_decided' });
        expect((await ctx.db.query(`SELECT action FROM audit_log WHERE target_id = $1`, [id])).rows.map(r => r.action)).toEqual(['box_edge_allow']);

        const denied = await pending(box.id, 'domain', { host: 'evil.example.org' });
        expect((await decide(denied, 'deny')).body).toEqual({ status: 'denied' });
        expect((await ctx.request.get(`/servers/${serverId}/boxes`).set(owner.auth)).body.boxes[0].allowedDomains).not.toContain('evil.example.org');
    });

    test('always on a push turns on auto-push for the home channel', async () => {
        const box = (await createBox()).body.box;
        const id = await pending(box.id, 'push', { owner: 'acme', repo: 'web', commands: [['0'.repeat(40), 'a'.repeat(40), 'refs/heads/feature']] });
        expect((await decide(id, 'always')).body).toEqual({ status: 'allowed' });
        const policy = (await ctx.db.query(`SELECT channel_id, auto_push, auto_pr FROM box_push_policies WHERE box_id = $1`, [box.id])).rows[0];
        expect(policy).toMatchObject({ auto_push: true, auto_pr: false });
        expect(policy.channel_id.trim()).toBe(channelId);
        expect((await card(id)).system_data).toMatchObject({ kind: 'push', status: 'allowed', canAlways: true });
    });

    test('the card update reaches the channel over Socket.IO after commit', async () => {
        const { io } = await import('socket.io-client');
        // Any free port: other suites may hold 4999
        await ctx.app.listen({ port: 0, host: '127.0.0.1' });
        const port = (ctx.app.server.address() as any).port;
        const box = (await createBox()).body.box;
        const id = await pending(box.id, 'domain', { host: 'docs.example.com' });
        const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], auth: { token: owner.token }, reconnection: false });
        try {
            await new Promise<void>((resolve, reject) => { socket.once('Ready', () => resolve()); socket.once('connect_error', reject); });
            const update = new Promise<any>((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('no MessageUpdate')), 3000);
                socket.on('MessageUpdate', (e: any) => { if (e.systemData?.requestId === id) { clearTimeout(t); resolve(e); } });
            });
            expect((await decide(id, 'allow')).status).toBe(200);
            const e = await update;
            expect(e).toMatchObject({ channelId, systemData: { requestId: id, status: 'allowed' } });
        } finally {
            socket.disconnect();
        }
    });
});

describe('host mode (§10)', () => {
    const DIRECT = (1n << 29n).toString();
    const cmd = (auth: object, body: object) => ctx.request.post(`/channels/${channelId}/agent-commands`).set(auth).send(body);

    test('a machine-host profile needs hostModeAck and is host mode, owner-only whatever its auth; a box profile is not', async () => {
        const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Orchestrator', permissions: DIRECT });
        await ctx.request.put(`/servers/${serverId}/members/${member.userId}/roles/${role.body.id}`).set(owner.auth);
        const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
        const hostId = host.body.host.id;
        const agent = (name: string, extra: object = {}) => ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
            .send({ name, adapter: 'claude', hostId, workdirAlias: 'agora', channelId, ...extra });

        expect((await agent('nope', { hostModeAck: false })).status).toBe(400);
        expect((await agent('legacy')).status).toBe(400);
        const unboxed = await agent('unboxed', { hostModeAck: true });
        expect(unboxed.body.profile).toMatchObject({ hostMode: true, boxed: false });
        const ack = (await ctx.db.query(`SELECT host_mode_ack_at, host_mode_ack_by FROM agent_profiles WHERE id = $1`, [unboxed.body.profile.id])).rows[0];
        expect(ack.host_mode_ack_at).not.toBeNull();
        expect(ack.host_mode_ack_by.trim()).toBe(owner.userId);
        // A box profile is never host mode
        const box = await createBox();
        expect(box.status, JSON.stringify(box.body)).toBe(201);
        const boxProfile = (await ctx.request.get(`/servers/${serverId}/agent-profiles`).set(owner.auth)).body.find((p: any) => p.name === 'alpha');
        expect(boxProfile).toMatchObject({ hostMode: false, boxed: true });
        // Both run on an API key: the ordinary rules would let a director start them
        await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'ANTHROPIC_API_KEY' WHERE server_id = $1`, [serverId]);

        const boxSession = await cmd(member.auth, { command: 'start', profile: 'alpha' });
        expect(boxSession.status, JSON.stringify(boxSession.body)).toBe(201);
        const refused = await cmd(member.auth, { command: 'start', profile: 'unboxed' });
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe('subscription_owner_only');
        const started = await cmd(owner.auth, { command: 'start', profile: 'unboxed' });
        expect(started.status).toBe(201);
        expect(started.body.session).toMatchObject({ hostMode: true, boxed: false, authMode: 'api_key' });

        // A director's mention doesn't wake it; the owner's does
        const inbox = async (id = started.body.session.id) => (await ctx.db.query(`SELECT 1 FROM agent_inbox WHERE session_id = $1 AND reason = 'direct'`, [id])).rows.length;
        await ctx.request.post(`/channels/${channelId}/messages`).set(member.auth).send({ content: '@unboxed deploy it' });
        expect(await inbox()).toBe(0);
        // Control: the same mention wakes the boxed profile
        await ctx.request.post(`/channels/${channelId}/messages`).set(member.auth).send({ content: '@alpha deploy it' });
        expect(await inbox(boxSession.body.session.id)).toBe(1);
        await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@unboxed deploy it' });
        expect(await inbox()).toBe(1);

        // PATCH may repeat the acknowledgement; false is refused
        const patched = await ctx.request.patch(`/servers/${serverId}/agent-profiles/${unboxed.body.profile.id}`).set(owner.auth).send({ hostModeAck: true });
        expect(patched.body).toMatchObject({ hostMode: true, boxed: false });
        expect((await ctx.request.patch(`/servers/${serverId}/agent-profiles/${unboxed.body.profile.id}`).set(owner.auth).send({ hostModeAck: false })).status).toBe(400);

        // Hosts carry their kind; a box's host isn't revoked from the Hosts list
        const hosts = await ctx.request.get(`/servers/${serverId}/agent-hosts`).set(owner.auth);
        expect(hosts.body.map((h: any) => h.kind).sort()).toEqual(['box', 'machine']);
        const boxHost = hosts.body.find((h: any) => h.kind === 'box');
        expect((await ctx.request.delete(`/servers/${serverId}/agent-hosts/${boxHost.id}`).set(owner.auth)).status).toBe(404);
    });
});

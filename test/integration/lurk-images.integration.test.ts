import { setupTestApp, cleanDatabase, authedUser, createServer, joinViaInvite } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { Permissions } from '../../src/permissions';
import { decryptFile } from '../../src/lib/encryption';
import { config } from '../../src/config';
import { storage } from '../../src/lib/storage';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>, member: typeof owner;
let channel: string, server: string, hostId: string, hostAuth: Record<string, string>;
let a: any, b: any;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

async function agent(name: string) {
    const r = await ctx.request.post(`/servers/${server}/agents`).set(owner.auth)
        .send({ name, adapter: 'codex', hostId, workdirAlias: 'agora', channelId: channel });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: r.body.bot.id, profileId: r.body.profile.id, name, auth: { Authorization: `Bot ${r.body.token}` } };
}
async function session(agent: any, lurk: string | null = null) {
    const id = generateUlid();
    await ctx.db.query(`INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, lurk_mode)
        VALUES ($1,$2,$3,$4,$5,$6)`, [id, server, channel, agent.id, agent.profileId, lurk]);
    return id;
}
async function post(auth: object, content: string, thread?: string) {
    const url = `/channels/${channel}/messages${thread ? `/${thread}/replies` : ''}`;
    const r = await ctx.request.post(url).set(auth).send({ content });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id;
}
async function ready() { await ctx.db.query(`UPDATE agent_inbox SET created_at = NOW() - interval '3 seconds' WHERE reason = 'lurk'`); }
async function claim() { return ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth); }
async function finish(c: any, fields = {}) {
    return ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth).send({ claimToken: c.run.claimToken, ...fields });
}
async function inbox(id: string) { return (await ctx.db.query('SELECT btrim(message_id) AS id, reason FROM agent_inbox WHERE session_id = $1 ORDER BY id', [id])).rows; }
function command(auth: object, body: object) { return ctx.request.post(`/channels/${channel}/agent-commands`).set(auth).send(body); }
function discover(c: any, auth = hostAuth, token = c.run.claimToken) {
    return ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/images/discover`).set(auth).send({ claimToken: token });
}
function upload(c: any, messageId: string, reference = 'shot.png', bytes = png, auth = hostAuth, token = c.run.claimToken) {
    return ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/images`).set(auth)
        .field('claimToken', token).field('messageId', messageId).field('reference', reference)
        .attach('file', bytes, { filename: 'shot.png', contentType: 'image/png' });
}

beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'lurkowner');
    member = await authedUser(ctx.request, 'lurkmember');
    const s = await createServer(ctx.request, owner.auth, 'Lurk images'); server = s.serverId; channel = s.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, server);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000, max_thread_bot_hops = 0 WHERE id = $1', [channel]);
    const host = await ctx.request.post(`/servers/${server}/agent-hosts`).set(owner.auth).send({ name: 'lurkhost' });
    hostId = host.body.host.id; hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    a = await agent('lurker'); b = await agent('peer');
});
afterAll(async () => { await ctx?.close(); });
beforeEach(async () => {
    await ctx.db.query('TRUNCATE agent_sessions CASCADE');
    await ctx.db.query(`UPDATE agent_profiles SET wake_budget = 50, token_budget = 2000000 WHERE id = ANY($1)`, [[a.profileId, b.profileId]]);
});

describe('lurk routing and budgets', () => {
    it('hears non-director channel posts and unbound thread replies, batching a burst into one wake', async () => {
        const id = await session(a, 'balanced');
        const first = await post(member.auth, 'check this claim');
        const second = await post(member.auth, 'and this missed step', first);
        expect(await inbox(id)).toEqual([{ id: first, reason: 'lurk' }, { id: second, reason: 'lurk' }]);
        expect((await claim()).status).toBe(204);
        await ready();
        const c = await claim(); expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body.session.lurkMode).toBe('balanced');
        expect(c.body.inbox.map((m: any) => m.messageId)).toEqual([first, second]);
        expect(c.body.inbox[1].threadId).toBe(first);
        expect((await finish(c.body, { summary: '[pass]', tokensUsed: 17 })).status).toBe(200);
        expect((await ctx.db.query('SELECT wakes_used, tokens_used FROM agent_sessions WHERE id = $1', [id])).rows[0])
            .toMatchObject({ wakes_used: 1, tokens_used: '17' });
        expect((await ctx.db.query('SELECT error, status FROM agent_runs WHERE id = $1', [c.body.run.id])).rows[0])
            .toMatchObject({ error: null, status: 'succeeded' });
        expect((await claim()).status).toBe(204);
    });
    it('excludes its own posts and other lurk bots in channel and thread, but hears ordinary bots', async () => {
        const id = await session(a, 'quiet'); const peer = await session(b, 'vocal');
        const own = await post(a.auth, 'my own observation');
        await post(b.auth, 'another lurker'); await post(b.auth, 'another lurker reply', own);
        expect(await inbox(id)).toEqual([]); expect(await inbox(peer)).toEqual([]);
        await ctx.db.query('UPDATE agent_sessions SET lurk_mode = NULL WHERE id = $1', [peer]);
        const heard = await post(b.auth, 'ordinary bot');
        expect(await inbox(id)).toEqual([{ id: heard, reason: 'lurk' }]);
    });
    it('keeps direct and protocol routing ahead of passive routing without duplicates or delay', async () => {
        const id = await session(a, 'balanced'); await session(b);
        const direct = await post(owner.auth, '@lurker fix this');
        expect(await inbox(id)).toEqual([{ id: direct, reason: 'direct' }]);
        const c = await claim(); expect(c.status).toBe(200); await finish(c.body);
        // Normal direct wakes still warn when the agent produces no post.
        expect((await ctx.db.query('SELECT error FROM agent_runs WHERE id = $1', [c.body.run.id])).rows[0].error).toBe('nothing_posted');
        const start = await post(b.auth, '[AGORA/v1 MODE=review STATE=START]\nparticipants: [peer, lurker]\ntask: Review');
        expect((await inbox(id)).filter((r: any) => r.id === start)).toEqual([{ id: start, reason: 'protocol' }]);
    });
    it('silence without a summary is also successful; token budget shelves a lurker', async () => {
        const id = await session(a, 'quiet');
        await ctx.db.query('UPDATE agent_sessions SET token_budget = 10 WHERE id = $1', [id]);
        await post(member.auth, 'observe'); await ready(); const c = (await claim()).body;
        expect((await finish(c, { tokensUsed: 10 })).status).toBe(200);
        expect((await ctx.db.query('SELECT error FROM agent_runs WHERE id = $1', [c.run.id])).rows[0].error).toBeNull();
        expect((await ctx.db.query('SELECT state, end_reason FROM agent_sessions WHERE id = $1', [id])).rows[0])
            .toMatchObject({ state: 'shelved', end_reason: 'budget' });
    });
    it('retains passive observations when a bound collaboration thread closes', async () => {
        const id = await session(a, 'balanced'); await session(b);
        const start = await post(b.auth, '[AGORA/v1 MODE=review STATE=START]\nparticipants: [peer, lurker]\ntask: Review');
        const observation = await post(member.auth, 'a new observation', start);
        await post(b.auth, '[AGORA/v1 MODE=review STATE=DONE]\nFinished', start);
        const pending = await ctx.db.query(`SELECT btrim(message_id) AS id FROM agent_inbox
            WHERE session_id = $1 AND reason = 'lurk' AND acked_at IS NULL`, [id]);
        expect(pending.rows.map((r: any) => r.id)).toContain(observation);
    });
    it('does not claim an already exhausted lurker', async () => {
        const id = await session(a, 'quiet');
        await ctx.db.query('UPDATE agent_sessions SET token_budget = 10, tokens_used = 10 WHERE id = $1', [id]);
        await post(member.auth, 'observe'); await ready();
        expect((await claim()).status).toBe(204);
        expect((await ctx.db.query('SELECT state FROM agent_sessions WHERE id = $1', [id])).rows[0].state).toBe('shelved');
    });
    it('keeps silence successful if a direct row in the same batch lost its authority before claim', async () => {
        await session(a, 'balanced'); await session(b);
        await ctx.db.query('UPDATE bot_channel_access SET can_direct = true WHERE bot_id = $1 AND channel_id = $2', [b.id, channel]);
        try { await post(b.auth, '@lurker work'); }
        finally { await ctx.db.query('UPDATE bot_channel_access SET can_direct = false WHERE bot_id = $1', [b.id]); }
        await post(member.auth, 'passive observation'); await ready();
        const c = await claim(); expect(c.status).toBe(200);
        expect(c.body.inbox).toHaveLength(1); expect(c.body.inbox[0].reason).toBe('lurk');
        await finish(c.body);
        expect((await ctx.db.query('SELECT error FROM agent_runs WHERE id = $1', [c.body.run.id])).rows[0].error).toBeNull();
    });
});

describe('/lurk authority and scope', () => {
    it('allows the owner, rejects members and bots without authority, and clears pending passive work', async () => {
        const id = await session(a);
        expect((await command(member.auth, { command: 'lurk', profile: a.name, lurkMode: 'quiet' })).status).toBe(403);
        expect((await command(b.auth, { command: 'lurk', profile: a.name, lurkMode: 'quiet' })).status).toBe(403);
        const r = await command(owner.auth, { command: 'lurk', profile: a.name, lurkMode: 'vocal' });
        expect(r.status).toBe(200); expect(r.body.session.lurkMode).toBe('vocal');
        await post(member.auth, 'pending');
        expect((await command(owner.auth, { command: 'lurk', profile: a.name, lurkMode: null })).status).toBe(200);
        expect((await ctx.db.query('SELECT count(*)::int AS n FROM agent_inbox WHERE session_id = $1 AND acked_at IS NULL', [id])).rows[0].n).toBe(0);
        expect((await command(owner.auth, { command: 'lurk', profile: a.name, lurkMode: 'loud' })).status).toBe(400);
    });
    it('allows a human director and a bot explicitly allowed to direct', async () => {
        await session(a);
        const role = await ctx.request.post(`/servers/${server}/roles`).set(owner.auth).send({ name: 'director', permissions: String(Permissions.DirectAgents) });
        expect(role.status, JSON.stringify(role.body)).toBe(201);
        await ctx.request.put(`/servers/${server}/members/${member.userId}/roles/${role.body.id}`).set(owner.auth);
        try {
            expect((await command(member.auth, { command: 'lurk', profile: a.name, lurkMode: 'quiet' })).status).toBe(200);
        } finally { await ctx.request.delete(`/servers/${server}/members/${member.userId}/roles/${role.body.id}`).set(owner.auth); }
        await ctx.db.query('UPDATE bot_channel_access SET can_direct = true WHERE bot_id = $1 AND channel_id = $2', [b.id, channel]);
        try { expect((await command(b.auth, { command: 'lurk', profile: a.name, lurkMode: 'balanced' })).status).toBe(200); }
        finally { await ctx.db.query('UPDATE bot_channel_access SET can_direct = false WHERE bot_id = $1', [b.id]); }
    });
    it('requires an existing live profile here and accepts the MCP start parameter', async () => {
        expect((await command(owner.auth, { command: 'lurk', profile: a.name, lurkMode: 'quiet' })).status).toBe(404);
        const r = await command(owner.auth, { command: 'start', profile: a.name, lurkMode: 'quiet' });
        expect(r.status).toBe(201); expect(r.body.session.lurkMode).toBe('quiet');
        expect((await command(owner.auth, { command: 'sessions' })).body.sessions[0].lurkMode).toBe('quiet');
    });
    it('does not change a different channel session or carry the dial into a fresh session', async () => {
        const here = await session(a);
        const ch = await ctx.request.post(`/servers/${server}/channels`).set(owner.auth).send({ name: 'other-lurk', channelType: 3 });
        expect(ch.status).toBe(201);
        const there = generateUlid();
        await ctx.db.query(`INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id)
            VALUES ($1,$2,$3,$4,$5)`, [there, server, ch.body.id, a.id, a.profileId]);
        await command(owner.auth, { command: 'lurk', profile: a.name, lurkMode: 'quiet' });
        expect((await ctx.db.query('SELECT lurk_mode FROM agent_sessions WHERE id = $1', [there])).rows[0].lurk_mode).toBeNull();
        const fresh = await command(owner.auth, { command: 'start', profile: a.name, onLive: 'shelve', fresh: true });
        expect(fresh.status).toBe(201); expect(fresh.body.session.id).not.toBe(here); expect(fresh.body.session.lurkMode).toBeNull();
    });
});

describe('run image endpoint', () => {
    async function run() { await session(a); await post(owner.auth, '@lurker work'); const r = await claim(); expect(r.status).toBe(200); return r.body; }
    it('discovers only this run bot/channel/time, attaches to the source thread and deduplicates per run', async () => {
        const before = await post(a.auth, '`old.png`'); const c = await run();
        const parent = await post(member.auth, 'thread');
        const mine = await post(a.auth, '`shot.png`', parent); await post(b.auth, '`foreign.png`');
        expect((await discover(c)).body.messages).toEqual([{ id: mine, content: '`shot.png`' }]);
        expect((await upload(c, before, 'old.png')).status).toBe(400);
        const first = await upload(c, mine); expect(first.status, JSON.stringify(first.body)).toBe(201);
        expect((await upload(c, mine)).body).toMatchObject({ ok: true, repeated: true });
        const file = (await ctx.db.query('SELECT * FROM files WHERE id = $1', [first.body.file.id])).rows[0];
        expect(file.message_id.trim()).toBe(mine); expect(file.uploader_id.trim()).toBe(a.id);
        expect(file.encryption_iv).toBeTruthy(); expect(file.encryption_tag).toBeTruthy();
        const blob = (await storage.get(file.storage_key))!;
        expect(blob.equals(png)).toBe(false);
        expect(decryptFile(blob, config.encryptionKey, file.encryption_iv, file.encryption_tag).length).toBeGreaterThan(0);
        const replies = await ctx.request.get(`/channels/${channel}/messages/${parent}/replies`).set(owner.auth);
        expect(replies.body.find((m: any) => m.id === mine).attachments[0].id).toBe(first.body.file.id);
        expect((await finish(c)).status).toBe(200);
        expect((await upload(c, mine)).status).toBe(409);
    });
    it('rejects non-host tokens, a different host, stale claims, foreign messages and unreferenced paths', async () => {
        const c = await run(); const mine = await post(a.auth, '`shot.png`'); const foreign = await post(b.auth, '`shot.png`');
        expect((await discover(c, owner.auth)).status).toBe(403);
        expect((await upload(c, mine, 'shot.png', png, a.auth)).status).toBe(403);
        expect((await upload(c, mine, 'shot.png', png, hostAuth, 'wrong')).status).toBe(409);
        const other = await ctx.request.post(`/servers/${server}/agent-hosts`).set(owner.auth).send({ name: 'foreignhost' });
        expect((await upload(c, mine, 'shot.png', png, { Authorization: `AgentHost ${other.body.token}` })).status).toBe(404);
        expect((await upload(c, foreign)).status).toBe(400);
        expect((await upload(c, mine, '../../secret.png')).status).toBe(400);
    });
    it('uses storeFile size, extension, magic-byte and quota validation', async () => {
        const c = await run(); const mine = await post(a.auth, '`shot.png`');
        expect((await upload(c, mine, 'shot.png', Buffer.from('not an image'))).status).toBe(415);
        await ctx.db.query(`UPDATE instance_settings SET value = '10'::jsonb WHERE key = 'files.max_size_bytes'`);
        try { expect((await upload(c, mine)).status).toBe(413); }
        finally { await ctx.db.query(`UPDATE instance_settings SET value = '26214400'::jsonb WHERE key = 'files.max_size_bytes'`); }
        await ctx.db.query(`UPDATE instance_settings SET value = '["txt"]'::jsonb WHERE key = 'files.allowed_extensions'`);
        try { expect((await upload(c, mine)).status).toBe(415); }
        finally { await ctx.db.query(`UPDATE instance_settings SET value = '["png","jpg","jpeg","gif","webp","txt"]'::jsonb WHERE key = 'files.allowed_extensions'`); }
        await ctx.db.query(`UPDATE instance_settings SET value = '1'::jsonb WHERE key = 'files.storage_quota_bytes'`);
        try { expect((await upload(c, mine)).status).toBe(507); }
        finally { await ctx.db.query(`UPDATE instance_settings SET value = 'null'::jsonb WHERE key = 'files.storage_quota_bytes'`); }
        expect((await ctx.db.query('SELECT count(*)::int AS n FROM agent_run_images WHERE run_id = $1', [c.run.id])).rows[0].n).toBe(0);
    });
    it('rejects cancelled, expired and revoked runs before storing an image', async () => {
        const c = await run(); const mine = await post(a.auth, '`shot.png`');
        await ctx.db.query('UPDATE agent_runs SET cancel_requested = true WHERE id = $1', [c.run.id]);
        expect((await upload(c, mine)).status).toBe(409);
        await ctx.db.query(`UPDATE agent_runs SET cancel_requested = false, lease_until = NOW() - interval '1 second' WHERE id = $1`, [c.run.id]);
        expect((await upload(c, mine)).status).toBe(409);
        await ctx.db.query('UPDATE agent_hosts SET revoked_at = NOW() WHERE id = $1', [hostId]);
        try { expect((await upload(c, mine)).status).toBe(401); }
        finally { await ctx.db.query('UPDATE agent_hosts SET revoked_at = NULL WHERE id = $1', [hostId]); }
        expect((await ctx.db.query('SELECT count(*)::int AS n FROM agent_run_images WHERE run_id = $1', [c.run.id])).rows[0].n).toBe(0);
    });
});

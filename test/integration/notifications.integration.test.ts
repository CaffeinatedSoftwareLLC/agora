import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { Permissions } from '../../src/permissions';
import { notifySession, notifyApproval, inOwnTransaction } from '../../src/lib/notifications';

/**
 * Notifications (docs/notifications.md): who gets each type, and who doesn't; RLS on the
 * notification tables; read and unread; preferences; delivery to the user's socket.
 * Push devices and the push sender are in push-devices.integration.test.ts.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let director: Awaited<ReturnType<typeof authedUser>>;
// A server member who can't see #general (ViewChannel denied for them there)
let blind: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let hostAuth: { Authorization: string };
let botId: string;
let botAuth: { Authorization: string };
let profileId: string;
const sockets: Socket[] = [];

async function notificationsOf(userId: string, type?: string) {
    const rows = await ctx.db.query(
        `SELECT * FROM notifications WHERE user_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY id`,
        [userId, type ?? null]
    );
    return rows.rows;
}

async function post(auth: object, content: string, threadId?: string) {
    const url = threadId ? `/channels/${channelId}/messages/${threadId}/replies` : `/channels/${channelId}/messages`;
    const res = await ctx.request.post(url).set(auth).send({ content });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    return res.body;
}

async function startSession(startedBy: string | null): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, serverId, channelId, botId, profileId, startedBy]
    );
    return id;
}

const claim = () => ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);

beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ port: 4999, host: '127.0.0.1' });
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'notifowner');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'Notify Server'));
    member = await authedUser(ctx.request, 'notifmember');
    director = await authedUser(ctx.request, 'notifdirector');
    blind = await authedUser(ctx.request, 'notifblind');
    for (const u of [member, director, blind]) await joinViaInvite(ctx.request, owner.auth, u.auth, serverId);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000 WHERE id = $1', [channelId]);
    await ctx.db.query(
        `INSERT INTO channel_member_overrides (channel_id, user_id, allow, deny) VALUES ($1, $2, $3, 0), ($1, $4, 0, $5)`,
        [channelId, director.userId, Permissions.DirectAgents.toString(), blind.userId, Permissions.ViewChannel.toString()]
    );

    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    const agent = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ name: 'codex', adapter: 'claude', hostId: host.body.host.id, workdirAlias: 'agora', channelId });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    botId = agent.body.bot.id;
    botAuth = { Authorization: `Bot ${agent.body.token}` };
    profileId = agent.body.profile.id;
    // API key profile: anyone who can direct may wake it
    await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'ANTHROPIC_API_KEY' WHERE id = $1`, [profileId]);
});

afterAll(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    await ctx.close();
});

beforeEach(async () => {
    await ctx.db.query('TRUNCATE notifications, notification_preferences, push_outbox, push_devices, task_cards, agent_run_approvals, agent_tool_requests, agent_runs, agent_inbox, agent_batches, agent_session_threads, agent_sessions CASCADE');
    await ctx.db.query(`UPDATE agent_profiles SET run_approval = false, allowed_tools = '{}' WHERE id = $1`, [profileId]);
});

describe('mentions', () => {
    test('a mentioned person is notified; the author, bots and people who cannot see the channel are not', async () => {
        await post(owner.auth, '@notifmember @notifblind @codex @notifowner please look');
        const got = await notificationsOf(member.userId, 'mention');
        expect(got).toHaveLength(1);
        expect(got[0].label).toBe('You were mentioned in #general');
        expect(got[0].url).toBe(`/app/${channelId}`);
        expect(got[0].label).not.toContain('please look');
        expect(await notificationsOf(blind.userId)).toHaveLength(0);
        expect(await notificationsOf(owner.userId)).toHaveLength(0);
        expect(await notificationsOf(botId)).toHaveLength(0);
    });

    test('@everyone notifies nobody', async () => {
        await post(owner.auth, '@everyone standup');
        expect((await ctx.db.query('SELECT 1 FROM notifications')).rows).toHaveLength(0);
    });

    test('a mention in a thread opens the thread', async () => {
        const parent = await post(owner.auth, 'parent');
        await post(owner.auth, 'see @notifmember', parent.id);
        const [n] = await notificationsOf(member.userId, 'mention');
        expect(n.thread_id.trim()).toBe(parent.id);
        expect(n.url).toBe(`/app/${channelId}?thread=${parent.id}`);
        expect(n.label).toBe('You were mentioned in a thread in #general');
    });

    test('a repeat within the window is dropped while the first is unread', async () => {
        await post(owner.auth, '@notifmember one');
        await post(owner.auth, '@notifmember two');
        expect(await notificationsOf(member.userId)).toHaveLength(1);
        await ctx.db.query('UPDATE notifications SET read_at = NOW()');
        await post(owner.auth, '@notifmember three');
        expect(await notificationsOf(member.userId)).toHaveLength(2);
    });

    test('a switched-off type is not created', async () => {
        const off = await ctx.request.put('/me/notification-preferences').set(member.auth).send({ types: { mention: false } });
        expect(off.status).toBe(200);
        expect(off.body).toEqual({ types: { approval: true, mention: false, session: true, review: true, collab: true }, appPush: true });
        await post(owner.auth, '@notifmember hello');
        expect(await notificationsOf(member.userId)).toHaveLength(0);
    });
});

describe('approvals', () => {
    test('a tool approval card notifies the owner and directors, not other members', async () => {
        await startSession(owner.userId);
        await post(owner.auth, '@codex open a PR');
        const c = await claim();
        expect(c.status).toBe(200);
        const done = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken, deniedTools: ['Bash(gh:*)'] });
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        const owners = await notificationsOf(owner.userId, 'approval');
        expect(owners).toHaveLength(1);
        expect(owners[0].label).toBe('Approval waiting in #general');
        expect(await notificationsOf(director.userId, 'approval')).toHaveLength(1);
        expect(await notificationsOf(member.userId, 'approval')).toHaveLength(0);
        expect(await notificationsOf(blind.userId, 'approval')).toHaveLength(0);
    });

    test('a run approval card notifies only the server owner', async () => {
        await ctx.db.query(`UPDATE agent_profiles SET run_approval = true WHERE id = $1`, [profileId]);
        await startSession(owner.userId);
        await post(director.auth, '@codex summarise');
        expect((await claim()).status).toBe(204);
        expect((await ctx.db.query(`SELECT 1 FROM agent_run_approvals`)).rows).toHaveLength(1);
        expect(await notificationsOf(owner.userId, 'approval')).toHaveLength(1);
        expect(await notificationsOf(director.userId, 'approval')).toHaveLength(0);
    });

    test('a permission relay card notifies only the server owner', async () => {
        const res = await ctx.request.post(`/channels/${channelId}/permission-relays`).set(botAuth)
            .send({ relayId: 'abcde', toolName: 'Bash', description: 'List files', inputPreview: '{"command":"ls"}' });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(await notificationsOf(owner.userId, 'approval')).toHaveLength(1);
        expect(await notificationsOf(director.userId, 'approval')).toHaveLength(0);
        expect(await notificationsOf(member.userId, 'approval')).toHaveLength(0);
    });

    test('a code run approval notifies members with Manage Bots who can see the channel', async () => {
        // The runtime path (src/runtime/service.ts submitRun) calls this with its own transaction
        await inOwnTransaction(ctx.db, c => notifyApproval(c, { kind: 'code', channelId }));
        expect(await notificationsOf(owner.userId, 'approval')).toHaveLength(1);
        expect(await notificationsOf(member.userId, 'approval')).toHaveLength(0);
        // Give the member Manage Bots in the channel
        await ctx.db.query(
            `INSERT INTO channel_member_overrides (channel_id, user_id, allow, deny) VALUES ($1, $2, $3, 0)
             ON CONFLICT (channel_id, user_id) DO UPDATE SET allow = $3`,
            [channelId, member.userId, Permissions.ManageBots.toString()]
        );
        await ctx.db.query('UPDATE notifications SET read_at = NOW()');
        await inOwnTransaction(ctx.db, c => notifyApproval(c, { kind: 'code', channelId }));
        expect(await notificationsOf(member.userId, 'approval')).toHaveLength(1);
        await ctx.db.query('DELETE FROM channel_member_overrides WHERE channel_id = $1 AND user_id = $2', [channelId, member.userId]);
    });
});

describe('agent sessions', () => {
    test('a run that posts nothing tells the person who started the session', async () => {
        await startSession(director.userId);
        await post(director.auth, '@codex do the thing');
        const c = await claim();
        expect(c.status).toBe(200);
        const done = await ctx.request.post(`/agent-hosts/@me/runs/${c.body.run.id}/complete`).set(hostAuth)
            .send({ claimToken: c.body.run.claimToken });
        expect(done.status).toBe(200);
        const got = await notificationsOf(director.userId, 'session');
        expect(got).toHaveLength(1);
        expect(got[0].label).toBe('codex is blocked in #general');
        expect(await notificationsOf(owner.userId, 'session')).toHaveLength(0);
    });

    test('a session nobody started goes to the owner', async () => {
        const s = await startSession(null);
        const c = await ctx.db.connect();
        try {
            await c.query('BEGIN');
            await notifySession(c, s, 'budget');
            await c.query('COMMIT');
        } finally { c.release(); }
        const got = await notificationsOf(owner.userId, 'session');
        expect(got.map(n => n.label)).toEqual(['codex used up its budget in #general']);
    });
});

describe('task cards and collaboration', () => {
    test('a card moved to Review notifies its creator, not the person who moved it', async () => {
        const created = await ctx.request.post(`/channels/${channelId}/tasks`).set(owner.auth).send({ title: 'Ship it' });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.card.id;
        const moved = await ctx.request.patch(`/channels/${channelId}/tasks/${id}`).set(director.auth).send({ status: 'review' });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        const got = await notificationsOf(owner.userId, 'review');
        expect(got).toHaveLength(1);
        expect(got[0].label).toBe('Task ready for review in #general');
        expect(got[0].label).not.toContain('Ship it');
        expect(await notificationsOf(director.userId, 'review')).toHaveLength(0);

        // The creator moving their own card hears nothing
        const own = await ctx.request.post(`/channels/${channelId}/tasks`).set(owner.auth).send({ title: 'Mine' });
        await ctx.request.patch(`/channels/${channelId}/tasks/${own.body.card.id}`).set(owner.auth).send({ status: 'review' });
        expect(await notificationsOf(owner.userId, 'review')).toHaveLength(1);
    });

    test('an agora-collab DONE or BLOCK in a thread notifies the thread starter', async () => {
        const parent = await post(member.auth, 'plan the migration');
        await post(botAuth, '[AGORA/v1 MODE=plan STATE=TURN]\nthinking\n[YIELD to=notifmember]', parent.id);
        expect(await notificationsOf(member.userId, 'collab')).toHaveLength(0);
        await post(botAuth, '[AGORA/v1 MODE=plan STATE=DONE]\nAll agreed.', parent.id);
        const got = await notificationsOf(member.userId, 'collab');
        expect(got).toHaveLength(1);
        expect(got[0].label).toBe('Collaboration finished in #general');
        expect(got[0].url).toBe(`/app/${channelId}?thread=${parent.id}`);
        expect(await notificationsOf(owner.userId, 'collab')).toHaveLength(0);

        const second = await post(member.auth, 'another plan');
        await post(botAuth, '[AGORA/v1 MODE=plan STATE=BLOCK]\nneeds a decision', second.id);
        expect((await notificationsOf(member.userId, 'collab')).map(n => n.label)).toContain('Collaboration blocked in #general');
    });
});

describe('REST and RLS', () => {
    test('list, unread count, mark one and all read', async () => {
        await post(owner.auth, '@notifmember a');
        const parent = await post(owner.auth, 'thread');
        await post(owner.auth, '@notifmember b', parent.id);

        const list = await ctx.request.get('/me/notifications').set(member.auth);
        expect(list.status).toBe(200);
        expect(list.body.unread).toBe(2);
        expect(list.body.notifications).toHaveLength(2);
        expect(list.body.notifications[0].threadId).toBe(parent.id);
        expect(Object.keys(list.body.notifications[0]).sort())
            .toEqual(['channelId', 'createdAt', 'id', 'label', 'readAt', 'serverId', 'threadId', 'type', 'url']);

        const page = await ctx.request.get('/me/notifications?limit=1').set(member.auth);
        expect(page.body.hasMore).toBe(true);
        const next = await ctx.request.get(`/me/notifications?limit=1&before=${page.body.notifications[0].id}`).set(member.auth);
        expect(next.body.notifications[0].id).toBe(list.body.notifications[1].id);
        expect(next.body.hasMore).toBe(false);

        const one = await ctx.request.post(`/me/notifications/${list.body.notifications[0].id}/read`).set(member.auth);
        expect(one.status).toBe(200);
        expect(one.body.unread).toBe(1);
        const unreadOnly = await ctx.request.get('/me/notifications?unread=true').set(member.auth);
        expect(unreadOnly.body.notifications).toHaveLength(1);

        const all = await ctx.request.post('/me/notifications/read-all').set(member.auth);
        expect(all.body).toEqual({ updated: 1, unread: 0 });
        expect((await ctx.request.get('/me/notifications').set(member.auth)).body.unread).toBe(0);
    });

    test("a user can't read or mark another user's notifications", async () => {
        await post(owner.auth, '@notifmember private');
        const [n] = await notificationsOf(member.userId);
        expect((await ctx.request.get('/me/notifications').set(director.auth)).body.notifications).toEqual([]);
        expect((await ctx.request.post(`/me/notifications/${n.id.trim()}/read`).set(director.auth)).status).toBe(404);
        expect((await notificationsOf(member.userId))[0].read_at).toBeNull();
    });

    test('RLS: app_user sees only its own rows and cannot insert notifications', async () => {
        await post(owner.auth, '@notifmember x');
        await post(member.auth, '@notifdirector y');
        const c = await ctx.db.connect();
        try {
            await c.query('BEGIN');
            await c.query('SET LOCAL ROLE app_user');
            await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [director.userId]);
            const seen = await c.query('SELECT user_id FROM notifications');
            expect(seen.rows.map(r => r.user_id.trim())).toEqual([director.userId]);
            expect((await c.query('UPDATE notifications SET read_at = NOW() WHERE user_id = $1', [member.userId])).rowCount).toBe(0);
            await expect(c.query(
                `INSERT INTO notifications (id, user_id, type, label, url) VALUES ($1, $2, 'mention', 'x', '/app')`,
                [generateUlid(), director.userId]
            )).rejects.toThrow();
        } finally {
            await c.query('ROLLBACK');
            c.release();
        }
        const c2 = await ctx.db.connect();
        try {
            await c2.query('BEGIN');
            await c2.query('SET LOCAL ROLE app_user');
            await c2.query(`SELECT set_config('app.current_user_id', $1, true)`, [director.userId]);
            await expect(c2.query('SELECT * FROM push_outbox')).rejects.toThrow();
        } finally {
            await c2.query('ROLLBACK');
            c2.release();
        }
    });

    test('bots have no notification routes', async () => {
        expect((await ctx.request.get('/me/notifications').set(botAuth)).status).toBe(403);
        expect((await ctx.request.get('/me/push-devices').set(botAuth)).status).toBe(403);
    });

    test('preferences validate their body', async () => {
        expect((await ctx.request.put('/me/notification-preferences').set(member.auth).send({})).status).toBe(400);
        expect((await ctx.request.put('/me/notification-preferences').set(member.auth).send({ appPush: 'maybe' })).status).toBe(400);
        // Unknown types are dropped by the schema, never stored
        const odd = await ctx.request.put('/me/notification-preferences').set(member.auth).send({ types: { spam: false, review: false } });
        expect(odd.status).toBe(200);
        const stored = await ctx.db.query('SELECT types FROM notification_preferences WHERE user_id = $1', [member.userId]);
        expect(stored.rows[0].types).toEqual({ review: false });
        const get = await ctx.request.get('/me/notification-preferences').set(member.auth);
        expect(get.body.appPush).toBe(true);
    });
});

describe('delivery', () => {
    test('NotificationCreate reaches the recipient socket after commit, with no message text', async () => {
        const socket = io('http://localhost:4999', { transports: ['websocket'], reconnection: false, autoConnect: false, auth: { token: member.token } });
        sockets.push(socket);
        const ready = new Promise(resolve => socket.once('Ready', resolve));
        socket.connect();
        await ready;
        const got = new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No NotificationCreate')), 3000);
            socket.once('NotificationCreate', n => { clearTimeout(timer); resolve(n); });
        });
        await post(owner.auth, '@notifmember secret words here');
        const n = await got;
        expect(n).toMatchObject({ type: 'mention', label: 'You were mentioned in #general', url: `/app/${channelId}`, readAt: null });
        expect(JSON.stringify(n)).not.toContain('secret');
    });
});

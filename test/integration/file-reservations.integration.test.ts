import { setupTestApp, authedUser, createServer, cleanDatabase, joinViaInvite } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>, member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string, channel: string, second: string, hostId: string;
interface Agent { id: string; profileId: string; name: string; auth: { Authorization: string } }
let a: Agent, b: Agent, unbound: Agent;
const post = (auth: object, body: object, ch = channel) => ctx.request.post(`/channels/${ch}/file-reservations`).set(auth).send(body);
const list = (auth: object, ch = channel) => ctx.request.get(`/channels/${ch}/file-reservations`).set(auth);
async function makeAgent(name: string, alias: string): Promise<Agent> {
    const res = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth)
        .send({ name, hostId, adapter: 'codex', workdirAlias: alias, channelId: channel });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.profile.workspaceId).toBe('primary');
    return { id: res.body.bot.id, profileId: res.body.profile.id, name, auth: { Authorization: `Bot ${res.body.token}` } };
}
async function start(agent: Agent, ch = channel) {
    const res = await ctx.request.post(`/channels/${ch}/agent-commands`).set(owner.auth).send({ command: 'start', profile: agent.name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.session.id as string;
}
async function reserve(agent: Agent, paths: string[], extra: object = {}, ch = channel) {
    const res = await post(agent.auth, { action: 'reserve', paths, ...extra }, ch);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.reservation;
}
beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'wsiowner'); member = await authedUser(ctx.request, 'wsimember');
    const server = await createServer(ctx.request, owner.auth, 'Reservations'); serverId = server.serverId; channel = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const ch = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'other', channelType: 3 }); second = ch.body.id;
    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'reservations-host' }); hostId = host.body.host.id;
    a = await makeAgent('wsia', 'local-folder'); b = await makeAgent('wsib', 'different-local-folder'); unbound = await makeAgent('wsiunbound', 'local-folder');
    await ctx.request.post(`/channels/${second}/bots/${a.id}`).set(owner.auth);
});
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
    await ctx.db.query('TRUNCATE agent_sessions CASCADE');
    await ctx.db.query(`UPDATE agent_profiles SET workspace_id = 'primary' WHERE server_id = $1`, [serverId]);
    await ctx.db.query('UPDATE bot_channel_access SET can_direct = false WHERE bot_id = ANY($1)', [[a.id, b.id, unbound.id]]);
});

it('serializes concurrent conflicts across profiles with different local aliases: exactly one wins', async () => {
    const sa = await start(a), sb = await start(b);
    const responses = await Promise.all([
        post(a.auth, { action: 'reserve', paths: ['SRC\\Shared\\'] }),
        post(b.auth, { action: 'reserve', paths: ['src/shared/file.ts'] }),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    const loser = responses.find(r => r.status === 409)!;
    expect(loser.body).toMatchObject({ error: 'reservation_conflict', holder: { sessionId: expect.stringMatching(`${sa}|${sb}`), profile: expect.any(String) } });
    expect((await list(a.auth)).body.reservations).toHaveLength(1);
});
it('normalizes exact paths and directories, respects boundaries and allows the holder to overlap itself', async () => {
    await start(a); await start(b);
    const r = await reserve(a, ['.\\SRC\\File.ts', 'src/file.ts']); expect(r.paths).toEqual(['src/file.ts']);
    await reserve(a, ['src/']);
    expect((await post(b.auth, { action: 'reserve', paths: ['Src/File.TS'] })).status).toBe(409);
    await reserve(b, ['src2/file.ts']);
    expect((await post(b.auth, { action: 'reserve', paths: ['../escape'] })).status).toBe(400);
    expect((await post(b.auth, { action: 'reserve', paths: ['src/*.ts'] })).status).toBe(400);
});
it('defaults TTL to 900, caps it at 3600 and renews only the holder’s active reservation', async () => {
    await start(a); await start(b);
    const before = Date.now(), r = await reserve(a, ['a.ts']);
    expect(Date.parse(r.expiresAt) - before).toBeGreaterThanOrEqual(899000);
    expect(Date.parse(r.expiresAt) - before).toBeLessThan(905000);
    expect((await post(a.auth, { action: 'reserve', paths: ['b.ts'], ttlSeconds: 3601 })).status).toBe(400);
    expect((await post(b.auth, { action: 'renew', reservationId: r.id })).status).toBe(404);
    const renewed = await post(a.auth, { action: 'renew', reservationId: r.id, ttlSeconds: 3600 });
    expect(renewed.status).toBe(200); expect(Date.parse(renewed.body.reservation.expiresAt)).toBeGreaterThan(Date.parse(r.expiresAt));
});
it('expires reservations, never revives an expired ID, and permits a conflicting path after expiry', async () => {
    await start(a); await start(b); const r = await reserve(a, ['a.ts']);
    await ctx.db.query(`UPDATE agent_file_reservations SET expires_at = NOW() - interval '1 second' WHERE id = $1`, [r.id]);
    expect((await list(a.auth)).body.reservations).toEqual([]);
    expect((await post(a.auth, { action: 'renew', reservationId: r.id })).status).toBe(404);
    await reserve(b, ['a.ts']);
});
it('releases all reservations on /end, including an idle session without any run', async () => {
    await start(a); await start(b); const r = await reserve(a, ['src/']);
    const end = await ctx.request.post(`/channels/${channel}/agent-commands`).set(owner.auth).send({ command: 'end', profile: a.name });
    expect(end.status).toBe(200);
    expect((await ctx.db.query('SELECT released_at FROM agent_file_reservations WHERE id = $1', [r.id])).rows[0].released_at).not.toBeNull();
    await reserve(b, ['src/file.ts']);
    expect((await post(a.auth, { action: 'reserve', paths: ['x'] })).body.error).toBe('no_live_session');
});
it('allows owner force-release, rejects a member/ordinary bot, and wakes the holder with a notice', async () => {
    const session = await start(a); await start(b); const r = await reserve(a, ['owned.ts']);
    const body = { action: 'release', reservationId: r.id, force: true };
    expect((await post(member.auth, body)).status).toBe(403);
    expect((await post(b.auth, body)).status).toBe(403);
    expect((await post(owner.auth, body, second)).status).toBe(404);
    expect((await post(owner.auth, body)).status).toBe(200);
    const notice = await ctx.db.query(`SELECT m.content FROM agent_inbox i JOIN messages m ON m.id = i.message_id
        WHERE i.session_id = $1 AND m.content LIKE '%force-released%'`, [session]);
    expect(notice.rows[0].content).toContain('owned.ts');
    await reserve(b, ['owned.ts']);
});
it('allows a director to force-release without a live session, only in a channel where it directs', async () => {
    await start(a); const r = await reserve(a, ['owned.ts']);
    expect((await ctx.request.put(`/channels/${channel}/bots/${unbound.id}/direct`).set(owner.auth).send({ canDirect: true })).status).toBe(200);
    expect((await post(unbound.auth, { action: 'release', reservationId: r.id, force: true })).status).toBe(200);
});
it('binds same-bot sessions by channel: they conflict, cannot renew/release each other, and /end releases only one', async () => {
    const firstSession = await start(a), secondSession = await start(a, second);
    const first = await reserve(a, ['same.ts']); const other = await reserve(a, ['other.ts'], {}, second);
    expect(first.sessionId).toBe(firstSession); expect(other.sessionId).toBe(secondSession);
    const conflict = await post(a.auth, { action: 'reserve', paths: ['same.ts'] }, second);
    expect(conflict.status).toBe(409); expect(conflict.body.holder.sessionId).toBe(firstSession);
    expect((await post(a.auth, { action: 'renew', reservationId: first.id }, second)).status).toBe(404);
    expect((await post(a.auth, { action: 'release', reservationId: first.id }, second)).status).toBe(404);
    expect((await list(a.auth, second)).body.reservations).toHaveLength(2);
    await ctx.request.post(`/channels/${second}/agent-commands`).set(owner.auth).send({ command: 'end', profile: a.name });
    expect((await list(a.auth)).body.reservations.map((r: any) => r.id)).toEqual([first.id]);
});
it('authorizes channel, session and thread access and rejects an unbound bot', async () => {
    await start(a);
    expect((await post(unbound.auth, { action: 'reserve', paths: ['a'] })).status).toBe(409);
    expect((await list(unbound.auth)).status).toBe(409);
    expect((await post(b.auth, { action: 'reserve', paths: ['a'] }, second)).status).toBe(403);
    expect((await list(b.auth, second)).status).toBe(403);
    const parent = await ctx.request.post(`/channels/${second}/messages`).set(owner.auth).send({ content: 'private thread' });
    expect((await post(a.auth, { action: 'reserve', paths: ['a'], threadId: parent.body.id })).status).toBe(403);
    expect((await post(a.auth, { action: 'reserve', paths: ['a'], threadId: generateUlid() })).status).toBe(403);
    const own = await ctx.request.post(`/channels/${channel}/messages`).set(owner.auth).send({ content: 'own thread' });
    const r = await reserve(a, ['a'], { threadId: own.body.id }); expect(r.threadId).toBe(own.body.id);
    expect((await post(a.auth, { action: 'release', reservationId: r.id })).body.released).toEqual([r.id]);
});
it('uses owner-assigned workspace identity across hosts, independent of aliases, and snapshots it on start', async () => {
    const otherHost = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'second-wsi-host' });
    expect((await ctx.request.patch(`/servers/${serverId}/agent-profiles/${b.profileId}`).set(owner.auth)
        .send({ hostId: otherHost.body.host.id, workdirAlias: 'local-folder', workspaceId: 'other-repository' })).status).toBe(200);
    await start(a); await start(b);
    await reserve(a, ['same.ts']); const r = await reserve(b, ['same.ts']); expect(r.workspaceId).toBe('other-repository');
    expect((await list(a.auth)).body.reservations).toHaveLength(1);
    const blocked = await ctx.request.patch(`/servers/${serverId}/agent-profiles/${b.profileId}`).set(owner.auth).send({ workspaceId: 'primary' });
    expect(blocked.status).toBe(409);
    await ctx.request.post(`/channels/${channel}/agent-commands`).set(owner.auth).send({ command: 'end', profile: b.name });
    expect((await ctx.request.patch(`/servers/${serverId}/agent-profiles/${b.profileId}`).set(owner.auth).send({ workspaceId: 'primary' })).status).toBe(200);
    await start(b);
    expect((await post(b.auth, { action: 'reserve', paths: ['same.ts'] })).status).toBe(409);
});
it('release without an ID affects only the inferred session', async () => {
    await start(a); await start(b); await reserve(a, ['a']); await reserve(a, ['aa']); const held = await reserve(b, ['b']);
    const released = await post(a.auth, { action: 'release' }); expect(released.body.released).toHaveLength(2);
    expect((await list(b.auth)).body.reservations.map((r: any) => r.id)).toEqual([held.id]);
});
it('isolates identical workspace IDs and paths between servers and hides inaccessible channels', async () => {
    await start(a); await reserve(a, ['same.ts']);
    const other = await createServer(ctx.request, owner.auth, 'Other repository server');
    const host = await ctx.request.post(`/servers/${other.serverId}/agent-hosts`).set(owner.auth).send({ name: 'other-host' });
    const agent = await ctx.request.post(`/servers/${other.serverId}/agents`).set(owner.auth).send({ name: 'wsiforeign', adapter: 'codex', workdirAlias: 'local-folder', hostId: host.body.host.id, channelId: other.generalChannelId });
    expect(agent.status).toBe(201);
    const auth = { Authorization: `Bot ${agent.body.token}` };
    expect((await ctx.request.post(`/channels/${other.generalChannelId}/agent-commands`).set(owner.auth).send({ command: 'start', profile: 'wsiforeign' })).status).toBe(201);
    expect((await post(auth, { action: 'reserve', paths: ['same.ts'] }, other.generalChannelId)).status).toBe(201);
    expect((await list(a.auth)).body.reservations).toHaveLength(1);
    expect((await list(auth, other.generalChannelId)).body.reservations).toHaveLength(1);
    expect((await list(member.auth, other.generalChannelId)).status).toBe(403);
    expect((await list(auth)).status).toBe(403);
});

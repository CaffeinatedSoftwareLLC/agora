import { mkdtemp, realpath, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { Permissions } from '../../src/permissions';
import { sweepExpiredRuns, type Notice } from '../../src/lib/agent-runs';
import { Client as HostClient } from '../../agora-host/src/client';
import { configSchema } from '../../agora-host/src/config';
import { ensureWorkspace, git, reconcileWorkspaces } from '../../agora-host/src/workspaces';

/**
 * Agent host and profile lifecycle: host revoke (S0056), profile delete (S0060) and the
 * ended-session worktree reconcile/warning pair (S0063/S0064), the last one also end to end
 * with agora-host's real reconcile against a temp git repo.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let baseUrl: string;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let admin: Awaited<ReturnType<typeof authedUser>>;
let director: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;

interface Host { id: string; token: string; auth: { Authorization: string } }
interface Agent { botId: string; botAuth: { Authorization: string }; profileId: string; name: string }

async function makeHost(name: string): Promise<Host> {
    const res = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.host.id, token: res.body.token, auth: { Authorization: `AgentHost ${res.body.token}` } };
}

async function makeAgent(name: string, hostId: string, channels: string[] = [channelId]): Promise<Agent> {
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: name });
    expect(bot.status).toBe(201);
    const token = await ctx.request.post(`/servers/${serverId}/bots/${bot.body.id}/tokens`).set(owner.auth).send({});
    for (const ch of channels) expect((await ctx.request.post(`/channels/${ch}/bots/${bot.body.id}`).set(owner.auth)).status).toBe(201);
    const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
        .send({ name, botId: bot.body.id, hostId, adapter: 'codex', workdirAlias: 'agora' });
    expect(profile.status, JSON.stringify(profile.body)).toBe(201);
    await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'OPENAI_API_KEY' WHERE id = $1`, [profile.body.id]);
    return { botId: bot.body.id, botAuth: { Authorization: `Bot ${token.body.token}` }, profileId: profile.body.id, name };
}

async function command(body: object, auth: object = owner.auth, ch = channelId) {
    return ctx.request.post(`/channels/${ch}/agent-commands`).set(auth).send(body);
}

async function post(auth: object, content: string, ch = channelId) {
    const res = await ctx.request.post(`/channels/${ch}/messages`).set(auth).send({ content });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
}

/** A session row as /start would leave it, inserted directly (as agent-sessions tests do). */
async function insertSession(agent: Agent, state: 'live' | 'ended', ch = channelId): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, state, ended_at, end_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, serverId, ch, agent.botId, agent.profileId, owner.userId, state, state === 'ended' ? new Date() : null, state === 'ended' ? 'user' : null]);
    return id;
}

const one = async (sql: string, args: unknown[] = []) => (await ctx.db.query(sql, args)).rows[0];

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = ctx.app.server.address();
    if (typeof addr === 'string' || !addr) throw new Error('no server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;

    owner = await authedUser(ctx.request, 'ahowner');
    member = await authedUser(ctx.request, 'ahmember');
    admin = await authedUser(ctx.request, 'ahadmin');
    director = await authedUser(ctx.request, 'ahdirector');
    const server = await createServer(ctx.request, owner.auth, 'Host Lifecycle');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    for (const u of [member, admin, director]) await joinViaInvite(ctx.request, owner.auth, u.auth, serverId);
    const adminRole = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth)
        .send({ name: 'Admin', permissions: Permissions.Administrator.toString() });
    expect((await ctx.request.put(`/servers/${serverId}/members/${admin.userId}/roles/${adminRole.body.id}`).set(owner.auth)).status).toBe(200);
    const dirRole = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth)
        .send({ name: 'Orchestrator', permissions: Permissions.DirectAgents.toString() });
    expect(dirRole.status).toBe(201);
    expect((await ctx.request.put(`/servers/${serverId}/members/${director.userId}/roles/${dirRole.body.id}`).set(owner.auth)).status).toBe(200);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000, max_thread_bot_hops = 0 WHERE id = $1', [channelId]);
});
afterAll(async () => { await ctx.close(); });

describe('S0056 DELETE /servers/:serverId/agent-hosts/:hostId', () => {
    it('[ID-05.host-revoke] non-owners get 403 and the row is unchanged; the owner gets 204, the token stops, and the claimed run is redelivered once after its lease', async () => {
        const hostA = await makeHost('revoke-a');
        const hostB = await makeHost('revoke-b');
        const agent = await makeAgent('revokee', hostA.id);
        await insertSession(agent, 'live');
        await post(owner.auth, '@revokee build it');
        const first = await ctx.request.get('/agent-hosts/@me/runs/next').set(hostA.auth);
        expect(first.status).toBe(200);
        expect(first.body.run.attempt).toBe(1);

        const before = await one('SELECT * FROM agent_hosts WHERE id = $1', [hostA.id]);
        expect(before.revoked_at).toBeNull();
        for (const who of [member, admin, director]) {
            const res = await ctx.request.delete(`/servers/${serverId}/agent-hosts/${hostA.id}`).set(who.auth);
            expect(res.status).toBe(403);
        }
        expect((await ctx.request.delete(`/servers/${serverId}/agent-hosts/${hostA.id}`).set(agent.botAuth)).status).toBe(403);
        expect(await one('SELECT * FROM agent_hosts WHERE id = $1', [hostA.id])).toEqual(before);
        // Still works for the host
        expect((await ctx.request.post(`/agent-hosts/@me/runs/${first.body.run.id}/heartbeat`).set(hostA.auth)
            .send({ claimToken: first.body.run.claimToken })).status).toBe(200);

        const revoke = await ctx.request.delete(`/servers/${serverId}/agent-hosts/${hostA.id}`).set(owner.auth);
        expect(revoke.status).toBe(204);
        expect(revoke.text).toBe('');
        const after = await one('SELECT revoked_at FROM agent_hosts WHERE id = $1', [hostA.id]);
        expect(after.revoked_at).toBeInstanceOf(Date);
        expect((await ctx.request.delete(`/servers/${serverId}/agent-hosts/${hostA.id}`).set(owner.auth)).status).toBe(404);
        const listed = await ctx.request.get(`/servers/${serverId}/agent-hosts`).set(owner.auth);
        expect(listed.body.find((h: any) => h.id === hostA.id).revokedAt).not.toBeNull();

        // The revoked token: next claim, heartbeat and complete all 401
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set(hostA.auth)).status).toBe(401);
        expect((await ctx.request.post(`/agent-hosts/@me/runs/${first.body.run.id}/heartbeat`).set(hostA.auth)
            .send({ claimToken: first.body.run.claimToken })).status).toBe(401);
        expect((await ctx.request.post(`/agent-hosts/@me/runs/${first.body.run.id}/complete`).set(hostA.auth)
            .send({ claimToken: first.body.run.claimToken })).status).toBe(401);

        // The owner moves the profile to a working host; the run still holds its lease, so nothing yet
        expect((await ctx.request.patch(`/servers/${serverId}/agent-profiles/${agent.profileId}`).set(owner.auth).send({ hostId: hostB.id })).status).toBe(200);
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set(hostB.auth)).status).toBe(204);
        // A revoked host can't be chosen for a profile
        expect((await ctx.request.patch(`/servers/${serverId}/agent-profiles/${agent.profileId}`).set(owner.auth).send({ hostId: hostA.id })).status).toBe(400);

        // The lease runs out (the sweeper in src/index.ts calls sweepExpiredRuns)
        await ctx.db.query(`UPDATE agent_runs SET lease_until = NOW() - interval '1 second' WHERE id = $1`, [first.body.run.id]);
        const notices: Notice[] = [];
        expect(await sweepExpiredRuns(ctx.db, notices)).toBe(1);
        expect((await one('SELECT status FROM agent_runs WHERE id = $1', [first.body.run.id])).status).toBe('expired');

        const again = await ctx.request.get('/agent-hosts/@me/runs/next').set(hostB.auth);
        expect(again.status).toBe(200);
        expect(again.body.run.attempt).toBe(2);
        expect(again.body.run.deliveryKey).toBe(first.body.run.deliveryKey);
        expect(again.body.inbox.map((i: any) => i.content)).toEqual(first.body.inbox.map((i: any) => i.content));
        expect((await one('SELECT btrim(host_id) AS h FROM agent_runs WHERE id = $1', [again.body.run.id])).h).toBe(hostB.id);
        // Exactly once: no second copy while it runs, nor after it completes
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set(hostB.auth)).status).toBe(204);
        expect((await ctx.request.post(`/agent-hosts/@me/runs/${again.body.run.id}/complete`).set(hostB.auth)
            .send({ claimToken: again.body.run.claimToken })).status).toBe(200);
        expect(await sweepExpiredRuns(ctx.db, [])).toBe(0);
        expect((await ctx.request.get('/agent-hosts/@me/runs/next').set(hostB.auth)).status).toBe(204);
        const runs = await ctx.db.query(
            `SELECT attempt, status FROM agent_runs WHERE batch_id = (SELECT batch_id FROM agent_runs WHERE id = $1) ORDER BY attempt`, [first.body.run.id]);
        expect(runs.rows).toEqual([{ attempt: 1, status: 'expired' }, { attempt: 2, status: 'succeeded' }]);
    });
});

describe('S0060 DELETE /servers/:serverId/agent-profiles/:profileId', () => {
    it('[AG-01.profile-delete] 409 with a non-ended session; after /end 204, the profile is gone and the bot and its messages remain; a director gets 403', async () => {
        const host = await makeHost('profile-host');
        const agent = await makeAgent('deletable', host.id);
        const started = await command({ command: 'start', profile: 'deletable' });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        const sessionId = started.body.session.id as string;
        const said = await post(agent.botAuth, 'I am working');
        const url = `/servers/${serverId}/agent-profiles/${agent.profileId}`;
        const before = await one('SELECT * FROM agent_profiles WHERE id = $1', [agent.profileId]);

        const blocked = await ctx.request.delete(url).set(owner.auth);
        expect(blocked.status).toBe(409);
        expect(blocked.body).toEqual({ error: 'End this profile\'s sessions first' });
        expect(await one('SELECT * FROM agent_profiles WHERE id = $1', [agent.profileId])).toEqual(before);

        // A shelved session is not ended either
        await ctx.db.query(`UPDATE agent_sessions SET state = 'shelved', shelved_at = NOW() WHERE id = $1`, [sessionId]);
        expect((await ctx.request.delete(url).set(owner.auth)).status).toBe(409);
        await ctx.db.query(`UPDATE agent_sessions SET state = 'live', shelved_at = NULL WHERE id = $1`, [sessionId]);

        const ended = await command({ command: 'end', sessionId });
        expect(ended.status, JSON.stringify(ended.body)).toBe(200);
        expect((await one('SELECT state FROM agent_sessions WHERE id = $1', [sessionId])).state).toBe('ended');

        // Owner only: a director, an Administrator, a member and the bot itself are refused
        for (const auth of [director.auth, admin.auth, member.auth, agent.botAuth]) {
            expect((await ctx.request.delete(url).set(auth)).status).toBe(403);
        }
        expect(await one('SELECT * FROM agent_profiles WHERE id = $1', [agent.profileId])).toEqual(before);

        const del = await ctx.request.delete(url).set(owner.auth);
        expect(del.status).toBe(204);
        expect(await one('SELECT count(*)::int AS n FROM agent_profiles WHERE id = $1', [agent.profileId])).toEqual({ n: 0 });
        expect((await ctx.request.delete(url).set(owner.auth)).status).toBe(404);
        // The bot and its messages stay; its ended session goes with the profile (FK cascade)
        expect(await one('SELECT username, bot FROM users WHERE id = $1', [agent.botId])).toEqual({ username: 'deletable', bot: true });
        expect(await one('SELECT btrim(author_id) AS a, content FROM messages WHERE id = $1', [said.id])).toEqual({ a: agent.botId, content: 'I am working' });
        expect((await ctx.request.get('/bots/@me').set(agent.botAuth)).status).toBe(200);
        expect(await one('SELECT count(*)::int AS n FROM agent_sessions WHERE id = $1', [sessionId])).toEqual({ n: 0 });
        // /start for the deleted profile finds nothing
        expect((await command({ command: 'start', profile: 'deletable' })).status).toBe(404);
    });
});

describe('S0063/S0064 ended-session worktrees', () => {
    const notices = async (sessionId: string): Promise<string[]> => (await ctx.db.query(
        `SELECT content FROM messages WHERE channel_id = $1 AND system_event = 'agent_session' AND content LIKE $2 ORDER BY id`,
        [channelId, `Kept worktree for ended session ${sessionId}:%`])).rows.map((r: any) => r.content);

    it('[AG-07.ended-worktree] reconcile returns only idle ended sessions of this host; warning posts exactly 1 notice listing the paths', async () => {
        const host = await makeHost('ws-host');
        const other = await makeHost('ws-other');
        const agent = await makeAgent('wsserver', host.id);
        // A session ended with its run still claimed
        const claimedS = (await command({ command: 'start', profile: 'wsserver' })).body.session.id as string;
        await post(owner.auth, '@wsserver go');
        const claim = await ctx.request.get('/agent-hosts/@me/runs/next').set(host.auth);
        expect(claim.status).toBe(200);
        expect((await command({ command: 'end', sessionId: claimedS })).status).toBe(200);
        expect((await one('SELECT status FROM agent_runs WHERE id = $1', [claim.body.run.id])).status).toBe('claimed');
        const idle = await insertSession(agent, 'ended');
        const queued = await insertSession(agent, 'ended');
        await ctx.db.query(`INSERT INTO agent_workspace_commands (id, session_id, host_id, profile_generation, requested_by, action)
            VALUES ($1, $2, $3, 1, $4, 'diff')`, [generateUlid(), queued, host.id, owner.userId]);
        const live = await insertSession(agent, 'live');

        const url = '/agent-hosts/@me/workspaces/reconcile';
        const all = [idle, claimedS, queued, live];
        expect((await ctx.request.post(url).set(host.auth).send({ sessionIds: all })).body).toEqual([idle]);
        expect((await ctx.request.post(url).set(other.auth).send({ sessionIds: all })).body).toEqual([]);

        const warning = '/agent-hosts/@me/workspaces/warning';
        const count = async () => (await one(`SELECT count(*)::int AS n FROM messages WHERE channel_id = $1`, [channelId])).n;
        const n0 = await count();
        // Not for a live session, nor for another host
        expect((await ctx.request.post(warning).set(host.auth).send({ sessionId: live, paths: ['x.txt'] })).status).toBe(404);
        expect((await ctx.request.post(warning).set(other.auth).send({ sessionId: idle, paths: ['x.txt'] })).status).toBe(404);
        expect(await count()).toBe(n0);
        const res = await ctx.request.post(warning).set(host.auth).send({ sessionId: idle, paths: ['src/app.ts', 'notes/new file.md'] });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(await count()).toBe(n0 + 1);
        expect(await notices(idle)).toEqual([`Kept worktree for ended session ${idle}: uncommitted files:\n"src/app.ts"\n"notes/new file.md"`]);

        // Once the claimed run settles and the queued command finishes, they reconcile too
        expect((await ctx.request.post(`/agent-hosts/@me/runs/${claim.body.run.id}/fail`).set(host.auth)
            .send({ claimToken: claim.body.run.claimToken, error: 'cancelled' })).status).toBe(200);
        await ctx.db.query(`UPDATE agent_workspace_commands SET status = 'succeeded', finished_at = NOW() WHERE session_id = $1`, [queued]);
        expect(new Set((await ctx.request.post(url).set(host.auth).send({ sessionIds: all })).body)).toEqual(new Set([idle, claimedS, queued]));
        await ctx.db.query(`UPDATE agent_sessions SET state = 'ended', ended_at = NOW() WHERE id = $1`, [live]);
    });

    it('[AG-07.ended-worktree] end to end with agora-host: a dirty ended worktree is kept with exactly 1 notice, a clean one is removed, claimed or queued sessions are left alone', async () => {
        const dir = await realpath(await mkdtemp(join(tmpdir(), 'agora-cov-host-')));
        try {
            const repo = join(dir, 'repo');
            await git(dir, ['init', repo]);
            await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
            const host = await makeHost('e2e-host');
            const agent = await makeAgent('wsagent', host.id);
            const config = configSchema.parse({
                instance: baseUrl, hostToken: host.token,
                mcp: { executable: process.execPath, entrypoint: join(dir, 'mcp.js') },
                profiles: { wsagent: { adapter: 'codex', executable: process.execPath, workdir: repo, workdirAlias: 'agora', stateDir: join(dir, 'state') } },
                botTokens: {},
            });
            const local = config.profiles.wsagent;
            const tree = (sessionId: string) => ensureWorkspace(local, { session: { id: sessionId }, profile: { name: 'wsagent' } });

            // dirty: ended through /end with uncommitted edits
            const dirtyS = (await command({ command: 'start', profile: 'wsagent' })).body.session.id as string;
            const dirty = await tree(dirtyS);
            await writeFile(join(dirty.cwd, 'edited.txt'), 'uncommitted work');
            await writeFile(join(dirty.cwd, 'second file.md'), 'more');
            expect((await command({ command: 'end', sessionId: dirtyS })).status).toBe(200);
            // claimed: ended while its run is still claimed
            const claimedS = (await command({ command: 'start', profile: 'wsagent' })).body.session.id as string;
            const claimedW = await tree(claimedS);
            await writeFile(join(claimedW.cwd, 'claimed.txt'), 'x');
            await post(owner.auth, '@wsagent go');
            const claim = await ctx.request.get('/agent-hosts/@me/runs/next').set(host.auth);
            expect(claim.body.session.id).toBe(claimedS);
            expect((await command({ command: 'end', sessionId: claimedS })).status).toBe(200);
            // clean, queued (a workspace command waiting) and live
            const cleanS = await insertSession(agent, 'ended');
            const clean = await tree(cleanS);
            const queuedS = await insertSession(agent, 'ended');
            const queuedW = await tree(queuedS);
            await writeFile(join(queuedW.cwd, 'queued.txt'), 'x');
            await ctx.db.query(`INSERT INTO agent_workspace_commands (id, session_id, host_id, profile_generation, requested_by, action)
                VALUES ($1, $2, $3, 1, $4, 'diff')`, [generateUlid(), queuedS, host.id, owner.userId]);
            const liveS = await insertSession(agent, 'live');
            const liveW = await tree(liveS);
            await writeFile(join(liveW.cwd, 'live.txt'), 'x');

            const api = new HostClient(baseUrl, host.token);
            const log: string[] = [];
            await reconcileWorkspaces(config, api, new Set(), code => log.push(code));

            // Dirty: kept as it was, one notice with both paths
            expect(await readFile(join(dirty.cwd, 'edited.txt'), 'utf8')).toBe('uncommitted work');
            expect(await notices(dirtyS)).toEqual([`Kept worktree for ended session ${dirtyS}: uncommitted files:\n"edited.txt"\n"second file.md"`]);
            // Clean: removed, metadata gone, branch kept
            await expect(stat(clean.cwd)).rejects.toThrow();
            await expect(stat(join(local.stateDir, `wt-${cleanS.slice(-10)}.json`))).rejects.toThrow();
            expect((await git(repo, ['branch', '--list', clean.branch])).trim()).toContain(clean.branch);
            // Claimed, queued and live: untouched, no notice
            for (const [s, w] of [[claimedS, claimedW], [queuedS, queuedW], [liveS, liveW]] as const) {
                expect((await stat(w.cwd)).isDirectory()).toBe(true);
                expect(await notices(s)).toEqual([]);
            }
            expect(log).toEqual(['dirty_workspace_kept']);

            // A second pass posts nothing new
            await reconcileWorkspaces(config, api, new Set(), () => {});
            expect(await notices(dirtyS)).toHaveLength(1);

            // A session the host is still running is skipped even when the server would allow it
            expect((await ctx.request.post(`/agent-hosts/@me/runs/${claim.body.run.id}/fail`).set(host.auth)
                .send({ claimToken: claim.body.run.claimToken, error: 'cancelled' })).status).toBe(200);
            await reconcileWorkspaces(config, api, new Set([claimedS]), () => {});
            expect(await notices(claimedS)).toEqual([]);
            // Once nothing holds it, it is reconciled like the others
            await reconcileWorkspaces(config, api, new Set(), () => {});
            expect(await notices(claimedS)).toEqual([`Kept worktree for ended session ${claimedS}: uncommitted files:\n"claimed.txt"`]);
            expect(await notices(queuedS)).toEqual([]);
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    });
});

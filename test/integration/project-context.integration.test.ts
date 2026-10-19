import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Channel project context and verify before yield (docs/project-context.md, migration 051):
 * who may read and change them, what a hosted claim carries, and how a verify result from
 * the host is recorded and posted.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let director: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let otherChannelId: string;
let hostAuth: { Authorization: string };
let bot: { botId: string; auth: { Authorization: string }; profileId: string };
let specFileId: string;

const hostDepsInstalled = existsSync(join(__dirname, '../../agora-host/node_modules/zod'));

async function shareFile(auth: object, channel: string, name: string, text: string): Promise<string> {
    const up = await ctx.request.post('/files/upload').set(auth).field('channel_id', channel).attach('file', Buffer.from(text), name);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const msg = await ctx.request.post(`/channels/${channel}/messages`).set(auth).send({ content: `sharing ${name}`, attachments: [up.body.id] });
    expect([200, 201]).toContain(msg.status);
    return up.body.id;
}

async function startSession(native: string | null = null): Promise<string> {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, native_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, serverId, channelId, bot.botId, bot.profileId, owner.userId, native]
    );
    return id;
}

async function claimFor(sessionId: string, text = '@coder go') {
    const sent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: text });
    expect([200, 201]).toContain(sent.status);
    const c = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.session.id).toBe(sessionId);
    return c.body;
}

async function resetSessions() {
    await ctx.db.query('TRUNCATE agent_runs, agent_inbox, agent_batches, agent_session_threads, agent_sessions CASCADE');
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'pcowner');
    const server = await createServer(ctx.request, owner.auth, 'Project Server');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    const other = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'other', channelType: 3 });
    otherChannelId = other.body.id;
    director = await authedUser(ctx.request, 'pcdirector');
    member = await authedUser(ctx.request, 'pcmember');
    await joinViaInvite(ctx.request, owner.auth, director.auth, serverId);
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const role = await ctx.request.post(`/servers/${serverId}/roles`).set(owner.auth).send({ name: 'Dir', permissions: (1n << 29n).toString() });
    expect((await ctx.request.put(`/servers/${serverId}/members/${director.userId}/roles/${role.body.id}`).set(owner.auth)).status).toBeLessThan(300);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000 WHERE id = $1', [channelId]);

    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'pc' });
    hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    const b = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'coder' });
    const token = await ctx.request.post(`/servers/${serverId}/bots/${b.body.id}/tokens`).set(owner.auth).send({});
    expect((await ctx.request.post(`/channels/${channelId}/bots/${b.body.id}`).set(owner.auth)).status).toBe(201);
    const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
        .send({ name: 'coder', botId: b.body.id, hostId: host.body.host.id, adapter: 'claude', workdirAlias: 'repo' });
    expect(profile.status).toBe(201);
    bot = { botId: b.body.id, auth: { Authorization: `Bot ${token.body.token}` }, profileId: profile.body.id };
});

afterAll(async () => { await ctx.close(); });

describe('project context routes', () => {
    it('starts empty and is readable by members and by bots with channel access', async () => {
        const res = await ctx.request.get(`/channels/${channelId}/project`).set(member.auth);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ instructions: '', version: 0, files: [], verify: null, canEdit: false, canEditVerify: false });
        const asBot = await ctx.request.get(`/channels/${channelId}/project`).set(bot.auth);
        expect(asBot.status, JSON.stringify(asBot.body)).toBe(200);
        expect(asBot.body.canEdit).toBe(false);
        // No access to the other channel
        expect((await ctx.request.get(`/channels/${otherChannelId}/project`).set(bot.auth)).status).toBe(403);
    });

    it('lets the owner and directors edit, and refuses plain members and bots', async () => {
        expect((await ctx.request.get(`/channels/${channelId}/project`).set(director.auth)).body).toMatchObject({ canEdit: true, canEditVerify: false });
        expect((await ctx.request.get(`/channels/${channelId}/project`).set(owner.auth)).body).toMatchObject({ canEdit: true, canEditVerify: true });

        const denied = await ctx.request.put(`/channels/${channelId}/project`).set(member.auth).send({ instructions: 'x' });
        expect(denied.status).toBe(403);
        expect(denied.body.error).toBe('cannot_direct');
        expect((await ctx.request.put(`/channels/${channelId}/project`).set(bot.auth).send({ instructions: 'x' })).status).toBe(403);

        const byDirector = await ctx.request.put(`/channels/${channelId}/project`).set(director.auth).send({ instructions: 'Use pnpm.' });
        expect(byDirector.status).toBe(200);
        expect(byDirector.body).toMatchObject({ instructions: 'Use pnpm.', version: 1, updatedBy: 'pcdirector' });
        const byOwner = await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ instructions: 'Use npm. Run tests before you finish.' });
        expect(byOwner.body.version).toBe(2);
    });

    it('validates the body', async () => {
        expect((await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({})).status).toBe(400);
        expect((await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ instructions: 'x'.repeat(8001) })).status).toBe(400);
        expect((await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ fileIds: ['nope'] })).status).toBe(400);
        const eleven = Array.from({ length: 11 }, () => generateUlid());
        expect((await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ fileIds: eleven })).status).toBe(400);
    });

    it('pins files shared in this channel only, in order, and drops deleted ones', async () => {
        const spec = specFileId = await shareFile(owner.auth, channelId, 'spec.md', '# Spec\nShip it.');
        const notes = await shareFile(member.auth, channelId, 'notes.txt', 'Some notes');
        const elsewhere = await shareFile(owner.auth, otherChannelId, 'secret.txt', 'other channel');

        const wrong = await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ fileIds: [spec, elsewhere] });
        expect(wrong.status).toBe(400);
        expect(wrong.body.error).toContain(elsewhere);

        const ok = await ctx.request.put(`/channels/${channelId}/project`).set(director.auth).send({ fileIds: [notes, spec] });
        expect(ok.status).toBe(200);
        expect(ok.body.files.map((f: any) => f.name)).toEqual(['notes.txt', 'spec.md']);
        // Instructions are untouched when only files change
        expect(ok.body.instructions).toBe('Use npm. Run tests before you finish.');

        await ctx.db.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [notes]);
        const after = await ctx.request.get(`/channels/${channelId}/project`).set(member.auth);
        expect(after.body.files.map((f: any) => f.name)).toEqual(['spec.md']);
    });

    it('lets only the server owner set the verify command', async () => {
        expect((await ctx.request.put(`/channels/${channelId}/project/verify`).set(director.auth).send({ command: 'npm test' })).status).toBe(403);
        expect((await ctx.request.put(`/channels/${channelId}/project/verify`).set(owner.auth).send({ command: 'npm test; rm -rf /' })).status).toBe(400);
        expect((await ctx.request.put(`/channels/${channelId}/project/verify`).set(owner.auth).send({ command: 'npm  test' })).status).toBe(400);
        expect((await ctx.request.put(`/channels/${channelId}/project/verify`).set(owner.auth).send({ command: 'npm test', maxRetries: 9 })).status).toBe(400);

        const before = (await ctx.request.get(`/channels/${channelId}/project`).set(owner.auth)).body.version;
        const set = await ctx.request.put(`/channels/${channelId}/project/verify`).set(owner.auth).send({ command: 'npm run verify', maxRetries: 1 });
        expect(set.status).toBe(200);
        expect(set.body.verify).toEqual({ command: 'npm run verify', maxRetries: 1 });
        // Agents don't see the command, so it doesn't make the project "changed" for them
        expect(set.body.version).toBe(before);

        const off = await ctx.request.put(`/channels/${channelId}/project/verify`).set(owner.auth).send({ command: null });
        expect(off.body.verify).toBeNull();
        await ctx.request.put(`/channels/${channelId}/project/verify`).set(owner.auth).send({ command: 'npm run verify' });
    });
});

describe('hosted claims', () => {
    beforeEach(resetSessions);

    it('carry the instructions, the pinned files and their text, and the verify command', async () => {
        // The profile is a subscription one, so the owner pins (a director's pins are left out)
        expect((await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ fileIds: [specFileId] })).status).toBe(200);
        const s = await startSession();
        const c = await claimFor(s);
        expect(c.project).toMatchObject({ version: expect.any(Number), instructions: 'Use npm. Run tests before you finish.', changed: true });
        expect(c.project.files.map((f: any) => f.name)).toEqual(['spec.md']);
        expect(c.project.docs).toEqual([expect.objectContaining({ name: 'spec.md', text: '# Spec\nShip it.', truncated: false, error: null })]);
        expect(c.verify).toEqual({ command: 'npm run verify', maxRetries: 1 });
    });

    it('give a subscription profile only what the owner wrote or pinned; an API-key profile gets it all', async () => {
        const notes = await shareFile(director.auth, channelId, 'notes.md', 'director notes');
        expect((await ctx.request.put(`/channels/${channelId}/project`).set(director.auth)
            .send({ instructions: 'Director says: push to main.', fileIds: [specFileId, notes] })).status).toBe(200);
        // Re-pin the spec as the owner so one file is owner-pinned and one director-pinned
        await ctx.db.query('UPDATE channel_project_files SET pinned_by = $2 WHERE channel_id = $1 AND file_id = $3', [channelId, owner.userId, specFileId]);
        try {
            const sub = await claimFor(await startSession());
            expect(sub.profile.authMode).toBe('subscription');
            expect(sub.project.instructions).toBe('');
            expect(sub.project.files.map((f: any) => f.name)).toEqual(['spec.md']);
            await resetSessions();
            await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key' WHERE id = $1`, [bot.profileId]);
            const key = await claimFor(await startSession());
            expect(key.project.instructions).toBe('Director says: push to main.');
            expect(key.project.files.map((f: any) => f.name)).toEqual(['spec.md', 'notes.md']);
        } finally {
            await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'subscription' WHERE id = $1`, [bot.profileId]);
            await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ instructions: 'Use npm. Run tests before you finish.', fileIds: [specFileId] });
        }
    });

    it('give a siwc profile what its plan owner wrote or pinned, not the server owner', async () => {
        const notes = await shareFile(director.auth, channelId, 'plan-notes.md', 'plan owner notes');
        expect((await ctx.request.put(`/channels/${channelId}/project`).set(director.auth)
            .send({ instructions: 'Plan owner says: use pnpm.', fileIds: [specFileId, notes] })).status).toBe(200);
        // The spec is pinned by the server owner, the notes by the plan owner (the director)
        await ctx.db.query('UPDATE channel_project_files SET pinned_by = $2 WHERE channel_id = $1 AND file_id = $3', [channelId, owner.userId, specFileId]);
        try {
            await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'siwc', plan_owner_id = $2 WHERE id = $1`, [bot.profileId, director.userId]);
            const id = generateUlid();
            await ctx.db.query(`INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by) VALUES ($1, $2, $3, $4, $5, $6)`,
                [id, serverId, channelId, bot.botId, bot.profileId, director.userId]);
            const sent = await ctx.request.post(`/channels/${channelId}/messages`).set(director.auth).send({ content: '@coder go' });
            expect([200, 201]).toContain(sent.status);
            const c = await ctx.request.get('/agent-hosts/@me/runs/next?wait=0').set(hostAuth);
            expect(c.status, JSON.stringify(c.body)).toBe(200);
            expect(c.body.profile).toMatchObject({ authMode: 'siwc', planOwnerId: director.userId });
            expect(c.body.project.instructions).toBe('Plan owner says: use pnpm.');
            expect(c.body.project.files.map((f: any) => f.name)).toEqual(['plan-notes.md']);
        } finally {
            await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'subscription', plan_owner_id = NULL WHERE id = $1`, [bot.profileId]);
            await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ instructions: 'Use npm. Run tests before you finish.', fileIds: [specFileId] });
        }
    });

    it('send the file text again only when the project changed or the conversation is new', async () => {
        const s = await startSession();
        const first = await claimFor(s);
        const done = await ctx.request.post(`/agent-hosts/@me/runs/${first.run.id}/complete`).set(hostAuth)
            .send({ claimToken: first.run.claimToken, nativeSessionId: '00000000-0000-4000-8000-000000000001', tokensUsed: 1, summary: 'ok' });
        expect(done.status).toBe(200);

        const second = await claimFor(s, '@coder again');
        expect(second.project.changed).toBe(false);
        expect(second.project.docs).toEqual([]);
        expect(second.project.instructions).toContain('Use npm');
        await ctx.request.post(`/agent-hosts/@me/runs/${second.run.id}/complete`).set(hostAuth)
            .send({ claimToken: second.run.claimToken, tokensUsed: 1, summary: 'ok' });

        await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ instructions: 'Use npm. Run tests before you finish. Keep PRs small.' });
        const third = await claimFor(s, '@coder once more');
        expect(third.project.changed).toBe(true);
        expect(third.project.docs).toHaveLength(1);
    });

    it('have no project for a channel without one, and no verify step for a lurk-only batch', async () => {
        await ctx.db.query('TRUNCATE channel_projects CASCADE');
        try {
            const s = await startSession();
            const c = await claimFor(s);
            expect(c.project).toBeNull();
            expect(c.verify).toBeNull();
        } finally {
            await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ instructions: 'Use npm. Run tests before you finish.', fileIds: [specFileId] });
            await ctx.request.put(`/channels/${channelId}/project/verify`).set(owner.auth).send({ command: 'npm run verify', maxRetries: 1 });
        }
    });

    it('records a verify result and posts it in the channel', async () => {
        const s = await startSession();
        const c = await claimFor(s);
        const verification = { command: 'npm run verify', status: 'failed', attempts: 1, exitCode: 1, output: 'FAIL src/a.test.ts\n```` fence' };
        const done = await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth)
            .send({ claimToken: c.run.claimToken, tokensUsed: 1, summary: 'ok', changedPaths: ['a.ts'], verification });
        expect(done.status).toBe(200);
        const run = await ctx.db.query('SELECT verification FROM agent_runs WHERE id = $1', [c.run.id]);
        expect(run.rows[0].verification).toEqual(verification);
        const notice = await ctx.db.query(`SELECT content FROM messages WHERE channel_id = $1 AND system_event = 'agent_session' AND content LIKE 'coder: verify%' ORDER BY id DESC LIMIT 1`, [channelId]);
        expect(notice.rows[0]?.content).toMatch(/^coder: verify `npm run verify` failed \(exit 1\) after 1 fix turn\. Last output:\n````\nFAIL src\/a.test.ts\n``` fence\n````$/);
    });

    it('rejects a malformed verify report', async () => {
        const s = await startSession();
        const c = await claimFor(s);
        const bad = await ctx.request.post(`/agent-hosts/@me/runs/${c.run.id}/complete`).set(hostAuth)
            .send({ claimToken: c.run.claimToken, summary: 'ok', verification: { command: 'x', status: 'great', attempts: 0 } });
        expect(bad.status).toBe(400);
    });

    it.skipIf(!hostDepsInstalled)('pass agora-host\'s claim parser (needs agora-host deps)', async () => {
        const { claimSchema } = await import('../../agora-host/src/types');
        const s = await startSession();
        const c = await claimFor(s);
        const parsed = claimSchema.safeParse(c);
        expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
        expect(parsed.data?.project?.docs[0].text).toBe('# Spec\nShip it.');
        expect(parsed.data?.verify?.command).toBe('npm run verify');
    });

    it.skipIf(!hostDepsInstalled)('pass the parser with 8,000 characters that are two UTF-16 units each', async () => {
        const { claimSchema } = await import('../../agora-host/src/types');
        const wide = '\u{1F600}'.repeat(8000);
        expect((await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ instructions: wide })).status).toBe(200);
        try {
            const s = await startSession();
            const parsed = claimSchema.safeParse(await claimFor(s));
            expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues.slice(0, 2))).toBe(true);
        } finally {
            await ctx.request.put(`/channels/${channelId}/project`).set(owner.auth).send({ instructions: 'Use npm. Run tests before you finish.' });
        }
    });
});

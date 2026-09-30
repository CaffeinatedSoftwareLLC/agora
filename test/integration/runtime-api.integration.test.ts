import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { parseBotToken } from '../../src/auth/bot-tokens';
import { runtimeQueue, closeRuntimeClients, postRunResult, runtimeMaintenance } from '../../src/runtime/service';

/** WBS 3.5 / 3.6: run submission, decision gate, approvals, visibility, results, retention. */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let threadId: string;
let bot: { id: string; auth: { Authorization: string } };
let otherBot: { id: string; auth: { Authorization: string } };

async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 40; i++) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('waitFor timed out');
}

async function makeBot(name: string) {
    const res = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: name });
    const id = res.body.id;
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM users WHERE id = $1', [id])).rows.length > 0);
    const tok = await ctx.request.post(`/servers/${serverId}/bots/${id}/tokens`).set(owner.auth).send({});
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM bot_tokens WHERE id = $1', [parseBotToken(tok.body.token)!.tokenId])).rows.length > 0);
    await ctx.request.post(`/channels/${channelId}/bots/${id}`).set(owner.auth);
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM bot_channel_access WHERE bot_id = $1', [id])).rows.length > 0);
    return { id, auth: { Authorization: `Bot ${tok.body.token}` } };
}

async function setAccess(access: string) {
    const res = await ctx.request.patch(`/servers/${serverId}/bots/${bot.id}/runtime`).set(owner.auth).send({ access });
    expect(res.status).toBe(200);
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM users WHERE id = $1 AND runtime_access = $2', [bot.id, access])).rows.length > 0);
}

const submit = (body: Record<string, unknown>, auth: object = bot.auth) =>
    ctx.request.post('/runtime/runs').set(auth).send({ channelId, threadId, code: 'console.log(1)', ...body });

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    await runtimeQueue().obliterate({ force: true }).catch(() => {});
    owner = await authedUser(ctx.request, 'rtowner');
    member = await authedUser(ctx.request, 'rtmember');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'Runtime Server'));
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'runtime thread' });
    threadId = parent.body.id;
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM messages WHERE id = $1', [threadId])).rows.length > 0);
    bot = await makeBot('rtbot');
    otherBot = await makeBot('rtother');
});

afterAll(async () => {
    await runtimeQueue().obliterate({ force: true }).catch(() => {});
    await closeRuntimeClients();
    await ctx.close();
});

describe('bot runtime access', () => {
    test('defaults to none; only Manage Bots can change it', async () => {
        const list = await ctx.request.get(`/servers/${serverId}/bots`).set(owner.auth);
        expect(list.body.find((b: any) => b.id === bot.id).runtimeAccess).toBe('none');
        const denied = await ctx.request.patch(`/servers/${serverId}/bots/${bot.id}/runtime`).set(member.auth).send({ access: 'auto' });
        expect(denied.status).toBe(403);
        const bad = await ctx.request.patch(`/servers/${serverId}/bots/${bot.id}/runtime`).set(owner.auth).send({ access: 'root' });
        expect(bad.status).toBe(400);
    });
});

describe('submission and the decision gate', () => {
    test('humans cannot submit (bots only in v1)', async () => {
        expect((await submit({}, owner.auth)).status).toBe(403);
    });

    test('bot without runtime access is denied and the attempt is recorded', async () => {
        const res = await submit({});
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ status: 'denied', gate: { decision: 'deny', source: 'rules' } });
        expect(res.body.gate.reason).toContain('not allowed to run code');
        const row = (await ctx.db.query('SELECT status, gate_reason, code_sha256 FROM exec_runs WHERE id = $1', [res.body.id])).rows[0];
        expect(row.status).toBe('denied');
        expect(row.code_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    test('channel access and thread membership are enforced', async () => {
        await setAccess('approval');
        const { generalChannelId: foreignChannel } = await createServer(ctx.request, owner.auth, 'Other Server');
        expect((await submit({ channelId: foreignChannel, threadId: undefined })).status).toBe(403);
        expect((await submit({ threadId: '01AAAAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(404);
    });

    test('capabilities without an enabled route are denied', async () => {
        const res = await submit({ capabilities: ['search'] });
        expect(res.body.status).toBe('denied');
        expect(res.body.gate.reason).toContain('not enabled on this server: search');
    });

    test('generation capabilities get the longer time profile', async () => {
        await ctx.db.query(
            `INSERT INTO ai_providers (id, server_id, adapter, label) VALUES ('01PROVIDERAAAAAAAAAAAAAAAA', $1, 'openai', 'P')`, [serverId]);
        await ctx.db.query(
            `INSERT INTO ai_capability_routes (server_id, capability, provider_id, model, enabled) VALUES ($1, 'tts', '01PROVIDERAAAAAAAAAAAAAAAA', 'm', true)`, [serverId]);
        const res = await submit({ capabilities: ['tts'] });
        expect(res.status).toBe(202);
        expect(res.body.timeProfile).toBe('generation');
        expect(res.body.limits.wallClockMs).toBe(180_000);

        // Video (Veo) gets its own profile, stored through the widened DB check (migration 030)
        await ctx.db.query(
            `INSERT INTO ai_capability_routes (server_id, capability, provider_id, model, enabled) VALUES ($1, 'video', '01PROVIDERAAAAAAAAAAAAAAAA', 'm', true)`, [serverId]);
        const video = await submit({ capabilities: ['video'] });
        expect(video.status).toBe(202);
        expect(video.body.timeProfile).toBe('video');
        expect(video.body.limits.wallClockMs).toBe(480_000);
        const row = await ctx.db.query('SELECT time_profile FROM exec_runs WHERE id = $1', [video.body.id]);
        expect(row.rows[0].time_profile).toBe('video');
    });

    test('limits can only be lowered', async () => {
        const res = await submit({ limits: { memoryMb: 128, wallClockMs: 999_999 } });
        expect(res.body.limits.memoryMb).toBe(128);
        expect(res.body.limits.wallClockMs).toBe(60_000);
    });
});

describe('approval flow', () => {
    let runId: string;

    test('approval access: run waits and an approval card is posted in the thread', async () => {
        await setAccess('approval');
        const res = await submit({ code: 'console.log("needs review")' });
        expect(res.status).toBe(202);
        expect(res.body.status).toBe('awaiting_approval');
        expect(res.body.codeExpiresAt).toBeTruthy();
        runId = res.body.id;

        const card = (await ctx.db.query(
            "SELECT content, thread_id, system_data FROM messages WHERE system_event = 'runtime_approval' AND system_data->>'runId' = $1", [runId])).rows[0];
        expect(card.thread_id.trim()).toBe(threadId);
        expect(card.system_data).toMatchObject({ kind: 'runtime_approval', runId, status: 'pending' });
        expect(card.content).toContain('will be deleted on');
        expect(await runtimeQueue().getJob(runId)).toBeUndefined();
    });

    test('members without Manage Bots cannot approve; bots cannot review', async () => {
        expect((await ctx.request.post(`/runtime/runs/${runId}/approve`).set(member.auth)).status).toBe(403);
        expect((await ctx.request.post(`/runtime/runs/${runId}/approve`).set(bot.auth)).status).toBe(403);
    });

    test('a Manage Bots member approves: run is queued and the card updates', async () => {
        const res = await ctx.request.post(`/runtime/runs/${runId}/approve`).set(owner.auth);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('queued');
        expect(await runtimeQueue().getJob(runId)).toBeDefined();

        const card = (await ctx.db.query("SELECT content, system_data FROM messages WHERE system_event = 'runtime_approval' AND system_data->>'runId' = $1", [runId])).rows[0];
        expect(card.system_data.status).toBe('approved');
        expect(card.content).toContain('Approved by rtowner');
        const audit = await ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'runtime_approve' AND target_id = $1", [runId]);
        expect(audit.rows).toHaveLength(1);

        expect((await ctx.request.post(`/runtime/runs/${runId}/approve`).set(owner.auth)).status).toBe(409);
    });

    test('deny', async () => {
        const res = await submit({});
        const denied = await ctx.request.post(`/runtime/runs/${res.body.id}/deny`).set(owner.auth);
        expect(denied.body.status).toBe('denied');
        expect(await runtimeQueue().getJob(res.body.id)).toBeUndefined();
    });

    test('approvals expire after 30 minutes', async () => {
        const res = await submit({});
        await ctx.db.query("UPDATE exec_runs SET created_at = NOW() - INTERVAL '31 minutes' WHERE id = $1", [res.body.id]);
        const late = await ctx.request.post(`/runtime/runs/${res.body.id}/approve`).set(owner.auth);
        expect(late.status).toBe(410);
        expect((await ctx.db.query('SELECT status FROM exec_runs WHERE id = $1', [res.body.id])).rows[0].status).toBe('denied');
    });

    test('auto access queues immediately', async () => {
        await setAccess('auto');
        const res = await submit({});
        expect(res.status).toBe(202);
        expect(res.body.status).toBe('queued');
        expect(res.body.gate.decision).toBe('auto_run');
        expect(await runtimeQueue().getJob(res.body.id)).toBeDefined();
    });
});

describe('visibility, code, results, retention', () => {
    let runId: string;

    beforeAll(async () => {
        await setAccess('auto');
        runId = (await submit({ code: 'console.log("visible")' })).body.id;
    });

    test('submitter and channel members can see the run; other bots cannot', async () => {
        expect((await ctx.request.get(`/runtime/runs/${runId}`).set(bot.auth)).body.status).toBe('queued');
        expect((await ctx.request.get(`/runtime/runs/${runId}`).set(member.auth)).status).toBe(200);
        expect((await ctx.request.get(`/runtime/runs/${runId}`).set(otherBot.auth)).status).toBe(404);
    });

    test('code can be downloaded until pruned', async () => {
        const res = await ctx.request.get(`/runtime/runs/${runId}/code`).set(member.auth);
        expect(res.status).toBe(200);
        expect(res.text).toBe('console.log("visible")');
        expect(res.headers['content-disposition']).toContain('attachment');
    });

    test('result summary is posted into the thread', async () => {
        await ctx.db.query(
            `UPDATE exec_runs SET status = 'succeeded', started_at = NOW() - INTERVAL '2 seconds', finished_at = NOW(),
                    stdout_tail = 'visible', capability_calls = 1, artifact_count = 0 WHERE id = $1`, [runId]);
        const events: any[] = [];
        await postRunResult(ctx.db, runId, async e => { events.push(...e); });
        const msg = (await ctx.db.query("SELECT content, thread_id, system_data FROM messages WHERE system_event = 'runtime_result' AND system_data->>'runId' = $1", [runId])).rows[0];
        expect(msg.thread_id.trim()).toBe(threadId);
        expect(msg.content).toMatch(/Run .* succeeded in 2\.\d s · 1 capability call\(s\) · 0 file\(s\)/);
        expect(msg.content).toContain('visible');
        expect(events.map(e => e.event)).toContain('Message');
    });

    test('shortening retention requires confirmation, then pruning deletes code', async () => {
        await ctx.db.query('UPDATE users SET is_instance_admin = true WHERE id = $1', [owner.userId]);
        await ctx.db.query("UPDATE exec_runs SET created_at = NOW() - INTERVAL '10 days' WHERE id = $1", [runId]);

        const warn = await ctx.request.patch('/admin/settings/runtime').set(owner.auth).send({ codeRetentionDays: 7 });
        expect(warn.status).toBe(409);
        expect(warn.body.affectedRuns).toBeGreaterThanOrEqual(1);
        expect(warn.body.message).toContain('permanently deleted');

        const ok = await ctx.request.patch('/admin/settings/runtime').set(owner.auth).send({ codeRetentionDays: 7, confirm: true });
        expect(ok.status).toBe(200);
        await waitFor(async () => (await ctx.db.query("SELECT 1 FROM instance_settings WHERE key = 'runtime.code_retention_days' AND value = '7'::jsonb")).rows.length > 0);

        const { pruned } = await runtimeMaintenance(ctx.db);
        expect(pruned).toBeGreaterThanOrEqual(1);
        const gone = await ctx.request.get(`/runtime/runs/${runId}/code`).set(member.auth);
        expect(gone.status).toBe(410);
        expect((await ctx.request.get(`/runtime/runs/${runId}`).set(member.auth)).body.codePrunedAt).toBeTruthy();
    });
});

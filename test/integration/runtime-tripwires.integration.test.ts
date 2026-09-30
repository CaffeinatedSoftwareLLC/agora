import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { SandboxDocker } from '../../src/runtime/docker';
import { processRun, type RunnerDeps } from '../../src/runtime/runner';
import { resolveLimits, type RunLimits } from '../../src/runtime/limits';
import { postRunResult } from '../../src/runtime/service';
import type { BridgedEvent } from '../../src/lib/event-bridge';

/**
 * WBS 3.8: runner-side tripwires. The real SandboxDocker runs over a fake Docker
 * API (no containers), so the deadline and pause-kill paths are exercised here;
 * test/sandbox covers real containers.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let threadId: string;
const published: BridgedEvent[] = [];
const finished: { runId: string; status: string }[] = [];

async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 40; i++) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('waitFor timed out');
}

/** Docker log frame: 8-byte header (stream 1 = stdout) + payload. */
function frame(text: string): Buffer {
    const body = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
}

/** A fake dockerode: the container exits with `exitCode` shortly after start, or runs until killed. */
function fakeDocker(script: { exitCode?: number; runForever?: boolean; failCreate?: boolean }) {
    const state = { created: 0, killed: 0 };
    let exit = script.exitCode ?? 0;
    let resolveWait: () => void = () => {};
    const waited = new Promise<void>(r => { resolveWait = r; });
    const container = {
        start: async () => { if (!script.runForever) setTimeout(resolveWait, 5); },
        wait: () => waited,
        kill: async () => { state.killed++; exit = 137; resolveWait(); },
        inspect: async () => ({ State: { ExitCode: exit, OOMKilled: false } }),
        logs: async () => frame('output'),
        remove: async () => {},
    };
    const docker = {
        createContainer: async () => {
            if (script.failCreate) throw new Error('docker unavailable');
            state.created++;
            return { id: 'fake-container' };
        },
        getContainer: () => container,
    };
    return { sandbox: new SandboxDocker(docker as any), state };
}

function deps(sandbox: SandboxDocker): RunnerDeps {
    return {
        db: ctx.db,
        sandbox,
        config: { image: 'img', network: 'net', runtime: 'runc', capUrl: 'http://cap-gateway:8080', perServerConcurrency: 10, capacityRetryMs: 100, stopPollMs: 20 },
        onFinished: async (runId, status) => {
            finished.push({ runId, status });
            await postRunResult(ctx.db, runId, async events => { published.push(...events); });
        },
        publish: async (events) => { published.push(...events); },
    };
}

async function newBot(username: string): Promise<string> {
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username });
    expect(bot.status).toBe(201);
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM users WHERE id = $1', [bot.body.id])).rows.length > 0);
    return bot.body.id;
}

async function insertRun(botId: string, limits: Partial<RunLimits> = {}) {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, channel_id, thread_id, submitted_by, code, code_sha256, limits, gate_decision, status)
         VALUES ($1, $2, $3, $4, $5, 'x', $6, $7, 'auto_run', 'queued')`,
        [id, serverId, channelId, threadId, botId, 'a'.repeat(64), JSON.stringify({ ...resolveLimits('standard'), ...limits })]
    );
    return id;
}

async function runWith(botId: string, script: Parameters<typeof fakeDocker>[0], limits: Partial<RunLimits> = {}) {
    const runId = await insertRun(botId, limits);
    const { sandbox, state } = fakeDocker(script);
    const result = await processRun(deps(sandbox), runId);
    return { runId, result, state };
}

async function paused(botId: string): Promise<{ at: Date | null; reason: string | null }> {
    const row = (await ctx.db.query('SELECT bot_paused_at, bot_paused_reason FROM users WHERE id = $1', [botId])).rows[0];
    return { at: row.bot_paused_at, reason: row.bot_paused_reason };
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'tripowner');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'Tripwire Server'));
    const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'run thread' });
    threadId = parent.body.id;
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM messages WHERE id = $1', [threadId])).rows.length > 0);
});

afterAll(async () => {
    await ctx.close();
});

describe('repeated failures', () => {
    test('the third failed or timed-out run within 10 minutes pauses the bot and posts after the result card', async () => {
        const botId = await newBot('failbot');
        await runWith(botId, { exitCode: 1 });
        await runWith(botId, { runForever: true }, { wallClockMs: 50 });
        expect((await paused(botId)).at).toBeNull();

        published.length = 0;
        const { runId, result } = await runWith(botId, { exitCode: 2 });
        expect(result).toEqual({ kind: 'ran', status: 'failed' });

        const p = await paused(botId);
        expect(p.at).not.toBeNull();
        expect(p.reason).toBe(`Tripwire: 3 failed or timed-out runs within 10 minutes (run ${runId})`);

        const msgs = await ctx.db.query(
            'SELECT system_event, thread_id FROM messages WHERE system_data->>\'runId\' = $1 ORDER BY id',
            [runId]
        );
        expect(msgs.rows.map(r => r.system_event)).toEqual(['runtime_result', 'runtime_tripwire']);
        expect(msgs.rows[1].thread_id.trim()).toBe(threadId);
        expect(published.filter(e => e.event === 'Message').map(e => (e.data as any).systemEvent))
            .toEqual(['runtime_result', 'runtime_tripwire']);
    });

    test('succeeded runs and infrastructure errors do not count', async () => {
        const botId = await newBot('okbot');
        await runWith(botId, { exitCode: 1 });
        await runWith(botId, { exitCode: 1 });
        const ok = await runWith(botId, { exitCode: 0 });
        expect(ok.result).toEqual({ kind: 'ran', status: 'succeeded' });
        const err = await runWith(botId, { failCreate: true });
        expect(err.result).toEqual({ kind: 'ran', status: 'error' });
        expect((await paused(botId)).at).toBeNull();
    });

    test('failures older than 10 minutes do not count', async () => {
        const botId = await newBot('slowbot');
        const a = await runWith(botId, { exitCode: 1 });
        const b = await runWith(botId, { exitCode: 1 });
        await ctx.db.query("UPDATE exec_runs SET finished_at = NOW() - INTERVAL '11 minutes' WHERE id = ANY($1)", [[a.runId, b.runId]]);
        await runWith(botId, { exitCode: 1 });
        expect((await paused(botId)).at).toBeNull();
    });

    test('resuming the bot starts a fresh count', async () => {
        const botId = await newBot('resumebot');
        for (let i = 0; i < 3; i++) await runWith(botId, { exitCode: 1 });
        expect((await paused(botId)).at).not.toBeNull();

        const res = await ctx.request.patch(`/servers/${serverId}/bots/${botId}/pause`).set(owner.auth).send({ paused: false });
        expect(res.status).toBe(200);
        await waitFor(async () => (await paused(botId)).at === null);
        await waitFor(async () => (await ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'bot_resume' AND target_id = $1", [botId])).rows.length > 0);

        await runWith(botId, { exitCode: 1 });
        expect((await paused(botId)).at).toBeNull();
    });
});

describe('pausing stops the bot\'s code', () => {
    test('a running container is killed when its bot is paused', async () => {
        const botId = await newBot('longbot');
        const runId = await insertRun(botId);
        const { sandbox, state } = fakeDocker({ runForever: true });
        const pending = processRun(deps(sandbox), runId);

        await waitFor(async () => (await ctx.db.query("SELECT 1 FROM exec_runs WHERE id = $1 AND status = 'running'", [runId])).rows.length > 0);
        await ctx.db.query("UPDATE users SET bot_paused_at = NOW(), bot_paused_reason = 'manual' WHERE id = $1", [botId]);

        expect(await pending).toEqual({ kind: 'ran', status: 'killed' });
        expect(state.killed).toBe(1);
        const run = (await ctx.db.query('SELECT status, error, exit_code FROM exec_runs WHERE id = $1', [runId])).rows[0];
        expect(run).toEqual({ status: 'killed', error: 'Run stopped because the submitting bot was paused', exit_code: null });
        const tokens = await ctx.db.query('SELECT 1 FROM exec_run_tokens WHERE run_id = $1 AND revoked_at IS NULL', [runId]);
        expect(tokens.rows).toHaveLength(0);
    });

    test('a queued run of a paused bot is denied without starting a container', async () => {
        const botId = await newBot('queuedbot');
        const runId = await insertRun(botId);
        await ctx.db.query("UPDATE users SET bot_paused_at = NOW() WHERE id = $1", [botId]);

        finished.length = 0;
        const { sandbox, state } = fakeDocker({ exitCode: 0 });
        expect(await processRun(deps(sandbox), runId)).toEqual({ kind: 'skipped', reason: 'bot paused' });
        expect(state.created).toBe(0);
        expect(finished).toEqual([{ runId, status: 'denied' }]);

        const run = (await ctx.db.query('SELECT status, error, finished_at FROM exec_runs WHERE id = $1', [runId])).rows[0];
        expect(run.status).toBe('denied');
        expect(run.error).toBe('The submitting bot is paused');
        expect(run.finished_at).not.toBeNull();
        const card = await ctx.db.query("SELECT 1 FROM messages WHERE system_event = 'runtime_result' AND system_data->>'runId' = $1", [runId]);
        expect(card.rows).toHaveLength(1);
    });
});

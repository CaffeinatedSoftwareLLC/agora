import { vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { dockerFromEnv, SandboxDocker } from '../../src/runtime/docker';
import { processRun, type RunnerDeps } from '../../src/runtime/runner';
import { resolveLimits } from '../../src/runtime/limits';
import { buildCapGateway } from '../../src/gateway/cap-gateway';
import { startForwarder, FORWARDER } from './gateway-harness';

/**
 * WBS 3.4 end to end: agent code in a real sandbox → cap-gateway (real service) →
 * provider (mocked in this process) and Agora (messages + files in the thread).
 */

const IMAGE = process.env.AGORA_SANDBOX_IMAGE ?? 'agora/sandbox-deno:dev';
const NETWORK = process.env.AGORA_SANDBOX_NETWORK ?? 'agora_sandbox';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let gw: Awaited<ReturnType<typeof buildCapGateway>>;
let redis: Redis;
let forwarder: { stop: () => void };
let deps: RunnerDeps;
let serverId: string;
let channelId: string;
let botId: string;
let threadId: string;

async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 40; i++) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('waitFor timed out');
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    const owner = await authedUser(ctx.request, 'e2eowner');
    ({ serverId, generalChannelId: channelId } = await createServer(ctx.request, owner.auth, 'E2E Server'));

    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'e2ebot' });
    botId = bot.body.id;
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM users WHERE id = $1', [botId])).rows.length > 0);
    await ctx.request.post(`/channels/${channelId}/bots/${botId}`).set(owner.auth);
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM bot_channel_access WHERE bot_id = $1', [botId])).rows.length > 0);
    const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'e2e thread' });
    threadId = parent.body.id;
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM messages WHERE id = $1', [threadId])).rows.length > 0);

    const prov = await ctx.request.post(`/servers/${serverId}/ai/providers`).set(owner.auth).send({ adapter: 'gemini', apiKey: 'e2e-key' });
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM ai_providers WHERE id = $1', [prov.body.id])).rows.length > 0);
    await ctx.request.put(`/servers/${serverId}/ai/routes/chat`).set(owner.auth).send({ providerId: prov.body.id, model: 'gemini-3.8-flash' });
    await waitFor(async () => (await ctx.db.query('SELECT 1 FROM ai_capability_routes WHERE server_id = $1', [serverId])).rows.length > 0);

    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    gw = await buildCapGateway({ db: ctx.db, redis });
    await gw.listen({ port: 0, host: '0.0.0.0' });
    forwarder = startForwarder(NETWORK, (gw.server.address() as AddressInfo).port);

    const sandbox = new SandboxDocker(dockerFromEnv(process.env.AGORA_DOCKER_HOST ?? 'http://127.0.0.1:2375'));
    const { runtime } = await sandbox.preflight({ image: IMAGE, network: NETWORK, requireGvisor: false });
    deps = { db: ctx.db, sandbox, config: { image: IMAGE, network: NETWORK, runtime, capUrl: 'http://cap-gateway:8080', perServerConcurrency: 4, capacityRetryMs: 100, capContainer: FORWARDER } };
});

afterAll(async () => {
    vi.unstubAllGlobals();
    forwarder?.stop();
    await gw?.close();
    redis?.disconnect();
    await ctx.close();
});

test('agent code composes chat + postFile + postMessage through the real gateway', async () => {
    // Provider call made by the gateway (in this process) is mocked; the sandbox never sees the key
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        expect(String(url)).toContain('generativelanguage.googleapis.com');
        expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('e2e-key');
        const body = JSON.parse(String(init.body));
        const prompt = body.contents[0].parts[0].text;
        return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `Summary of: ${prompt}` }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } })}\n\n`);
    }));

    const code = `
        import { chat, postFile, postMessage } from "agora:std";
        const results = { passed: 41, failed: 1, flaky: ["threads close"] };
        const { text } = await chat(\`Summarize: \${JSON.stringify(results)}\`);
        const file = await postFile("results.json", JSON.stringify(results, null, 2), { message: "Raw results" });
        await postMessage(text + " (file " + file.id + ")");
        console.log("done", file.id);
    `;
    const runId = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, channel_id, thread_id, submitted_by, code, code_sha256, limits, gate_decision, status, requested_capabilities)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'auto_run', 'queued', $9)`,
        [runId, serverId, channelId, threadId, botId, code, createHash('sha256').update(code).digest('hex'), JSON.stringify(resolveLimits('standard')), ['chat']]
    );

    const result = await processRun(deps, runId);
    const run = (await ctx.db.query('SELECT * FROM exec_runs WHERE id = $1', [runId])).rows[0];
    expect(result, run.stderr_tail).toEqual({ kind: 'ran', status: 'succeeded' });
    expect(run.stdout_tail).toMatch(/^done [0-9A-Z]{26}/);
    expect(run.capability_calls).toBe(2);   // chat + postMessage
    expect(run.artifact_count).toBe(1);

    // Both posts landed in the run's thread as the submitting bot
    const replies = await ctx.db.query(
        `SELECT m.content, m.author_id, f.filename FROM messages m
         LEFT JOIN files f ON f.message_id = m.id
         WHERE m.thread_id = $1 ORDER BY m.id`,
        [threadId]
    );
    expect(replies.rows.map(r => r.author_id.trim())).toEqual([botId, botId]);
    expect(replies.rows[0]).toMatchObject({ content: 'Raw results', filename: 'results.json' });
    expect(replies.rows[1].content).toMatch(/^Summary of: Summarize: \{"passed":41,"failed":1,"flaky":\["threads close"\]\} \(file [0-9A-Z]{26}\)$/);

    // Usage recorded against the run
    const usage = await ctx.db.query('SELECT capability, input_tokens FROM ai_usage_events WHERE run_id = $1', [runId]);
    expect(usage.rows).toEqual([{ capability: 'chat', input_tokens: 9 }]);

    // Token no longer works after the run ended
    const tokens = await ctx.db.query('SELECT revoked_at FROM exec_run_tokens WHERE run_id = $1', [runId]);
    expect(tokens.rows[0].revoked_at).toBeTruthy();
});

test('testReport turns JUnit XML into a results card with a model summary and a Markdown report (4.1)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
        new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'One of three tests failed: test_create got a 500.' }] } }] })}\n\n`)));

    const code = [
        'import { testReport } from "agora:std";',
        'const xml = `<testsuites><testsuite name="api">',
        '  <testcase name="test_list" time="0.2"/>',
        '  <testcase name="test_create" time="0.3"><failure message="assert 500 == 201">trace</failure></testcase>',
        '  <testcase name="test_skip"><skipped/></testcase>',
        '</testsuite><testsuite name="util"><testcase name="test_ok" time="0.1"/></testsuite></testsuites>`;',
        'const res = await testReport(xml, { title: "CI #7" });',
        'console.log("card", res.id, res.fileId);',
    ].join('\n');
    const runId = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, channel_id, thread_id, submitted_by, code, code_sha256, limits, gate_decision, status, requested_capabilities)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'auto_run', 'queued', $9)`,
        [runId, serverId, channelId, threadId, botId, code, createHash('sha256').update(code).digest('hex'), JSON.stringify(resolveLimits('standard')), ['chat']]
    );

    const result = await processRun(deps, runId);
    const run = (await ctx.db.query('SELECT * FROM exec_runs WHERE id = $1', [runId])).rows[0];
    expect(result, run.stderr_tail).toEqual({ kind: 'ran', status: 'succeeded' });
    expect(run.capability_calls).toBe(2);   // chat summary + report
    expect(run.artifact_count).toBe(1);

    const card = (await ctx.db.query(
        `SELECT m.author_id, m.system_data, f.filename, f.size_bytes FROM messages m LEFT JOIN files f ON f.message_id = m.id
         WHERE m.system_event = 'runtime_report' AND m.system_data->>'runId' = $1`,
        [runId]
    )).rows[0];
    expect(card.author_id.trim()).toBe(botId);
    expect(card.filename).toBe('ci-7.md');
    expect(Number(card.size_bytes)).toBeGreaterThan(100);
    expect(card.system_data).toMatchObject({
        title: 'CI #7',
        summary: 'One of three tests failed: test_create got a 500.',
        summarySource: 'model',
        totals: { passed: 2, failed: 1, skipped: 1, durationMs: 600 },
        failures: [{ name: 'test_create', suite: 'api', message: 'assert 500 == 201\ntrace' }],
    });
    expect(card.system_data.suites.map((s: any) => s.name)).toEqual(['api', 'util']);
});

test('a run cannot use another run\'s token: the gateway refuses it and pauses the leaking bot (spec §14 item 12)', async () => {
    vi.unstubAllGlobals();
    // A second bot with a live run of its own, whose token is bound to another sandbox's address
    const otherBot = generateUlid();
    await ctx.db.query('INSERT INTO users (id, username, bot, server_id) VALUES ($1, $2, true, $3)', [otherBot, `victim${otherBot.slice(-6).toLowerCase()}`, serverId]);
    const victimRun = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, channel_id, thread_id, submitted_by, code, code_sha256, limits, gate_decision, status, requested_capabilities)
         VALUES ($1, $2, $3, $4, $5, 'x', $6, $7, 'auto_run', 'running', $8)`,
        [victimRun, serverId, channelId, threadId, otherBot, 'a'.repeat(64), JSON.stringify(resolveLimits('standard')), ['chat']]
    );
    const stolen = `art_${randomBytes(32).toString('base64url')}`;
    await ctx.db.query(
        `INSERT INTO exec_run_tokens (token_hash, run_id, server_id, capabilities, expires_at, bound_ip)
         VALUES ($1, $2, $3, $4, NOW() + interval '5 minutes', '10.255.255.1')`,
        [createHash('sha256').update(stolen).digest('hex'), victimRun, serverId, ['chat']]
    );

    // The attacker's run presents the stolen token to the gateway
    const code = `
        const res = await fetch(Deno.env.get("AGORA_CAP_URL") + "/v1/messages", {
            method: "POST",
            headers: { authorization: "Bearer ${stolen}", "content-type": "application/json" },
            body: JSON.stringify({ content: "posted with a stolen token" }),
        });
        console.log("STATUS", res.status, (await res.json()).error);
    `;
    const runId = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, channel_id, thread_id, submitted_by, code, code_sha256, limits, gate_decision, status, requested_capabilities)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'auto_run', 'queued', $9)`,
        [runId, serverId, channelId, threadId, botId, code, createHash('sha256').update(code).digest('hex'), JSON.stringify(resolveLimits('standard')), ['chat']]
    );
    const result = await processRun(deps, runId);
    const run = (await ctx.db.query('SELECT * FROM exec_runs WHERE id = $1', [runId])).rows[0];
    expect(result, run.stderr_tail).toEqual({ kind: 'ran', status: 'succeeded' });
    expect(run.stdout_tail).toContain('STATUS 401');
    expect(run.stdout_tail).toContain('different address');

    // Nothing was posted, and the bot whose token leaked is paused
    const posted = await ctx.db.query("SELECT 1 FROM messages WHERE content = 'posted with a stolen token'");
    expect(posted.rows).toHaveLength(0);
    const victim = (await ctx.db.query('SELECT bot_paused_at, bot_paused_reason FROM users WHERE id = $1', [otherBot])).rows[0];
    expect(victim.bot_paused_at).toBeTruthy();
    expect(victim.bot_paused_reason).toContain('run token was used outside its run');
});

import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { dockerFromEnv, SandboxDocker } from '../../src/runtime/docker';
import { processRun, type RunnerDeps } from '../../src/runtime/runner';
import { resolveLimits } from '../../src/runtime/limits';
import { buildCapGateway } from '../../src/gateway/cap-gateway';
import { startForwarder } from './gateway-harness';

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
    deps = { db: ctx.db, sandbox, config: { image: IMAGE, network: NETWORK, runtime, capUrl: 'http://cap-gateway:8080', perServerConcurrency: 4, capacityRetryMs: 100 } };
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

/**
 * Dependency outages (beta-test-plan §3.5 OP-03). Containers are controlled only through
 * lib/containers.ts (agora-e2e-* names and project label, checked on every call); every test
 * restores what it changed in a `finally`, afterEach unpauses anything still paused and removes
 * stubs, and each test ends by checking the instance is healthy.
 *
 * Assertions that describe how the outage looks from outside (an error rather than a hang, the
 * UI's connection dot) are soft: they are reported without stopping the integrity and recovery
 * checks after them, which are hard.
 *
 * Not in the smoke set: the provider timeout case alone waits out Node's 300 s fetch timeout.
 */
import crypto from 'node:crypto';
import type { WebSocketRoute } from '@playwright/test';
import { test, expect, apis, openChannel, loadSeed } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { e2eEnv } from '../lib/env';
import { freshChannel, rowWith } from '../lib/helpers';
import { startFakeHost, waitFor, type FakeHost } from '../lib/fake-host';
import { agentChannel, messages, sessionOf, startSession, trimId, waitIdle, waitRuns } from '../lib/agents';
import { exec, readOnlyQuery, restoreAll, serviceContainer, withPaused } from '../lib/containers';
import { assistantChannel, assistantReply, expectHealthy, setupStubProvider, timedReq, type StubProvider, type TimedResult } from '../lib/ops';
import type { Api } from '../lib/api';
import type { Page } from '@playwright/test';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Undo for a change made inside a container, run by afterEach if the test did not get to it. */
let pendingRestore: (() => Promise<void>) | null = null;

async function send(page: Page, channelName: string, text: string) {
    await page.getByPlaceholder(`Message #${channelName}`).fill(text);
    await page.getByRole('button', { name: 'Send message' }).click();
}
function uploadForm(channelId: string, name: string, text: string) {
    const fd = new FormData();
    fd.append('channel_id', channelId);
    fd.append('file', new Blob([text], { type: 'text/plain' }), name);
    return fd;
}
async function filesInChannel(channelId: string): Promise<number> {
    if (!ULID.test(channelId)) throw new Error('not a channel id');
    return Number((await readOnlyQuery(`SELECT count(*) FROM files WHERE channel_id = '${channelId}'`))[0]);
}
/** Copies of a message by content: exactly one if the write was acknowledged, none otherwise. */
async function expectAtomic(api: Api, channelId: string, content: string, ack: TimedResult, what: string) {
    const copies = (await messages(api, channelId, 100)).filter(m => m.content === content).length;
    if (ack.status === 201) expect(copies, `${what}: acknowledged, so stored once`).toBe(1);
    else if (ack.status !== null) expect(copies, `${what}: refused (${ack.status}), so not stored`).toBe(0);
    else expect(copies, `${what}: no answer, so at most once`).toBeLessThanOrEqual(1);
    return copies;
}

test.describe('outages (OP-03)', () => {
    // Minutes long and they pause containers: only when asked for
    test.skip(!process.env.E2E_OPS, 'not_applicable: crash and outage scenarios run with E2E_OPS=1');
    test.describe.configure({ timeout: 360_000 });
    test.afterEach(async ({ seed }) => {
        if (pendingRestore) { const r = pendingRestore; pendingRestore = null; await r(); }
        await restoreAll();
        await expectHealthy(seed, 90_000);
    });

    test.describe('database', () => {
        let fh: FakeHost;
        test.beforeAll(async () => { fh = await startFakeHost(loadSeed(), { label: 'op-db', profiles: [{ key: 'db' }] }); });
        test.afterAll(async () => { await fh?.stop(); });

        test('[OP-03.db-down] Postgres paused 30 s during chat and an agent run: errors, nothing half-committed, recovery', async ({ page, seed }, ti) => {
            const { owner } = apis(seed);
            const pg = await serviceContainer('postgres');
            const a = fh.agents.db;
            const ch = await agentChannel(seed, fh, 'op-db', ['db']);
            const sid = await startSession(owner, ch.id, a.name);
            const [hello] = await waitRuns(fh, 'db', 1);
            await waitIdle(owner, ch.id, a.name, sid);
            await openChannel(page, ch.id, ch.name);

            // An agent run that is working when the database goes away and posts during the outage
            const word = `dbrun${fh.tag}`;
            await owner.ok('POST', `/channels/${ch.id}/messages`, { content: `@${a.name} work through it #fake-mark #fake-sleep=8 #fake-say=${word}` }, [201]);
            await waitFor('agent run started', async () => fh.traces('db').find(t => t.phase === 'started' && t.directives?.say === word), 60_000, 250);

            const uiText = `typed during the db outage ${fh.tag}`;
            const apiText = `api post during the db outage ${fh.tag}`;
            let read!: TimedResult; let apiPost!: Promise<TimedResult>; let uiDegraded = false;
            const pausedAt = Date.now();
            await withPaused(pg, async () => {
                read = await timedReq(owner, 'GET', `/channels/${ch.id}/messages?limit=5`, undefined, 12_000);
                // Writes keep waiting for their final answer (no client deadline)
                apiPost = timedReq(owner, 'POST', `/channels/${ch.id}/messages`, { content: apiText }, 180_000);
                await send(page, ch.name, uiText);
                while (Date.now() - pausedAt < 30_000) {
                    if (await page.getByRole('img', { name: /^(reconnecting|disconnected)$/ }).count()
                        || await page.getByText('Failed to send').count()) uiDegraded = true;
                    await sleep(1000);
                }
                await snap(page, ti, 'OP-03.db-down', '01-during-outage', 'A channel while the database is paused, with a message just sent', {});
            });
            ti.annotations.push({ type: 'during', description: `read: ${read.status ?? 'no answer'} after ${read.ms} ms; UI degraded state shown: ${uiDegraded}` });
            expect.soft(read.status, `the API answered during the outage instead of hanging (${read.ms} ms)`).not.toBeNull();
            if (read.status !== null) expect.soft(read.status, 'with an error, not a success').toBeGreaterThanOrEqual(500);
            expect.soft(uiDegraded, 'the UI showed reconnecting or a send error during the outage').toBe(true);

            // Recovery: healthy again, and every write either landed once or not at all
            await expectHealthy(seed, 90_000);
            const post = await apiPost;
            ti.annotations.push({ type: 'api-write', description: `${post.status ?? 'no answer'} after ${post.ms} ms` });
            await expectAtomic(owner, ch.id, apiText, post, 'API post');
            // The send must settle one way or the other: one stored copy, or a visible refusal.
            // A send still pending after recovery (or a polling error) fails here.
            const ui = await waitFor('the UI send to settle', async () => {
                const n = (await messages(owner, ch.id, 100)).filter(m => m.content === uiText).length;
                const failed = await page.getByText('Failed to send').count();
                return n > 0 || failed > 0 ? { n, failed } : null;
            }, 60_000, 1000);
            ti.annotations.push({ type: 'ui-write', description: `stored ${ui.n}, refusal shown ${ui.failed > 0}` });
            expect(ui.n, 'the UI message is stored at most once').toBeLessThanOrEqual(1);
            if (ui.n === 1) await expect(rowWith(page, uiText), 'shown once').toHaveCount(1, { timeout: 15_000 });
            else expect(ui.failed, 'not stored, so the UI shows the send failed').toBeGreaterThan(0);

            // The agent run finishes (on a redelivery if its report was lost) with exactly one reply
            const s = await waitFor('agent run to succeed', async () => {
                const x = await sessionOf(owner, ch.id, a.name, sid);
                return x && !x.running && x.run?.status === 'succeeded' && trimId(x.run.id) !== String(hello.runId) ? x : null;
            }, 240_000, 1000);
            expect(s.state).toBe('live');
            const replies = (await messages(owner, ch.id, 100)).filter(m => trimId(m.authorId) === a.botId && String(m.content).includes(word));
            expect(replies, 'one agent reply').toHaveLength(1);
            const attempts = fh.traces('db').filter(t => t.phase === 'started' && t.directives?.say === word);
            expect(attempts.length).toBeLessThanOrEqual(2);
            if (attempts.length === 2) {
                const first = (s.recentRuns as any[]).find(r => trimId(r.id) === attempts[0].runId);
                // Expired (its report was lost) or failed (the CLI's own Agora calls failed while
                // Postgres was paused); either way the batch was redelivered and replied once
                expect(['expired', 'failed'], 'the first attempt ended, then the batch was redelivered').toContain(first?.status);
            }
            ti.annotations.push({ type: 'agent-run', description: `${attempts.length} attempt(s)` });

            // Live updates work again
            const after = `after the db outage ${fh.tag}`;
            await owner.ok('POST', `/channels/${ch.id}/messages`, { content: after }, [201]);
            await expect(rowWith(page, after)).toHaveCount(1, { timeout: 20_000 });
            await expectHealthy(seed);
        });
    });

    test('[OP-03.redis-down] Redis paused 20 s: passkey ceremonies fail cleanly, chat recovers', async ({ page, seed }, ti) => {
        const { owner, anon } = apis(seed);
        const redis = await serviceContainer('redis');
        const ch = await freshChannel(seed, 'op-redis');
        await openChannel(page, ch.id, ch.name);
        const origin = { Origin: e2eEnv().baseURL };
        const control = await timedReq(anon, 'POST', '/auth/passkeys/login/options', {}, 10_000, origin);
        expect(control.status, 'passkey sign-in starts while Redis is up').toBe(200);
        expect(control.data?.flowId).toBeTruthy();

        const during = `posted while redis is paused ${seed.runTag}-${crypto.randomBytes(2).toString('hex')}`;
        let options!: TimedResult; let session!: TimedResult; let chatPost!: Promise<TimedResult>;
        await withPaused(redis, async () => {
            // Challenges live only in Redis: a sign-in can't start without it
            options = await timedReq(anon, 'POST', '/auth/passkeys/login/options', {}, 12_000, origin);
            session = await timedReq(owner, 'GET', '/auth/session', undefined, 8_000);
            chatPost = timedReq(owner, 'POST', `/channels/${ch.id}/messages`, { content: during }, 120_000);
            await sleep(8_000);
        });
        ti.annotations.push({ type: 'during', description: `passkey options: ${options.status ?? 'no answer'} after ${options.ms} ms; authenticated read: ${session.status ?? 'no answer'} after ${session.ms} ms` });
        expect(options.status, 'no challenge handed out that could not be stored').not.toBe(200);
        expect.soft(options.status, `the passkey request failed instead of hanging (${options.ms} ms)`).not.toBeNull();
        if (options.status !== null) expect.soft(options.status, 'with a server-side error').toBeGreaterThanOrEqual(500);

        await expectHealthy(seed, 60_000);
        const post = await chatPost;
        ti.annotations.push({ type: 'chat-during', description: `${post.status ?? 'no answer'} after ${post.ms} ms` });
        await expectAtomic(owner, ch.id, during, post, 'chat post during the outage');
        if (post.status === 201) await expect(rowWith(page, during)).toHaveCount(1, { timeout: 20_000 });

        // Chat recovers: a new message is accepted and arrives live
        const after = `after the redis outage ${seed.runTag}-${crypto.randomBytes(2).toString('hex')}`;
        const ok = await timedReq(owner, 'POST', `/channels/${ch.id}/messages`, { content: after }, 15_000);
        expect(ok.status).toBe(201);
        await expect(rowWith(page, after)).toHaveCount(1, { timeout: 20_000 });
        // Passkey sign-in starts again
        const again = await timedReq(anon, 'POST', '/auth/passkeys/login/options', {}, 10_000, origin);
        expect(again.status).toBe(200);
        expect(again.data?.flowId).toBeTruthy();
        await expectHealthy(seed);
    });

    test('[OP-03.storage-down] files volume read-only: upload fails with a clear error, no orphan files row', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const api = await serviceContainer('api');
        expect((await exec(api, ['id', '-u'])).stdout.trim(), 'the API runs as non-root, so a read-only directory stops it').not.toBe('0');
        const mode = (await exec(api, ['stat', '-c', '%a', '/data/files'], { user: '0' })).stdout.trim();
        expect(mode).toMatch(/^[0-7]{3,4}$/);
        const ch = await freshChannel(seed, 'op-storage');
        await openChannel(page, ch.id, ch.name);
        const name = `storage-down-${seed.runTag}.txt`;
        const body = `stored after the outage ${seed.runTag}\n`;

        // The volume root loses its write bit for the API user (new channel directories can't be
        // made); the container is not recreated and nothing else changes
        const undo = async () => { await exec(api, ['chmod', mode, '/data/files'], { user: '0' }); };
        pendingRestore = undo;
        try {
            await exec(api, ['chmod', 'a-w', '/data/files'], { user: '0' });
            expect((await exec(api, ['sh', '-c', 'test -w /data/files && echo writable || echo read-only'])).stdout.trim()).toBe('read-only');

            const r = await owner.req('POST', '/files/upload', uploadForm(ch.id, name, 'during the storage outage\n'));
            expect(r.status, JSON.stringify(r.data)).toBe(502);
            expect(r.data?.error).toBe('Failed to store file');

            await page.locator('input[type=file]').first().setInputFiles({ name: `ui-${name}`, mimeType: 'text/plain', buffer: Buffer.from('ui upload during the storage outage\n') });
            const chip = page.getByText('Failed to store file');
            await expect(chip, 'the upload shows the error').toBeVisible({ timeout: 15_000 });
            await snap(page, ti, 'OP-03.storage-down', '01-upload-error', 'A file chip above the message box with the red error "Failed to store file"', { ready: chip });

            expect(await filesInChannel(ch.id), 'no files row left behind').toBe(0);
            expect((await exec(api, ['sh', '-c', `ls -A /data/files/${ch.id} 2>/dev/null | wc -l`])).stdout.trim(), 'no blob or temp file').toBe('0');
        } finally {
            await undo();
            pendingRestore = null;
        }

        // Recovers: the same upload goes through and downloads intact
        const ok = await owner.req('POST', '/files/upload', uploadForm(ch.id, name, body));
        expect(ok.status, JSON.stringify(ok.data)).toBe(201);
        const fileId = trimId(ok.data.id);
        expect((await owner.req('GET', `/files/${fileId}`)).data).toBe(body);
        expect(await filesInChannel(ch.id)).toBe(1);
        await expectHealthy(seed);
    });

    test.describe('stub chat provider', () => {
        let sp: StubProvider;
        test.beforeAll(async () => { sp = await setupStubProvider(loadSeed()); });
        test.afterAll(async () => { await sp?.restore(); });

        const ask = async (api: Api, channelId: string, text: string) =>
            trimId(((await api.ok('POST', `/channels/${channelId}/messages`, { content: `@${sp.botUsername} ${text}` }, [201])) as any).id);
        const delta = (a: Awaited<ReturnType<StubProvider['usage']>>, b: typeof a) =>
            ({ requests: b.requests - a.requests, errors: b.errors - a.errors, tokens: b.tokens - a.tokens, costMicros: b.costMicros - a.costMicros });
        const botReplies = async (api: Api, channelId: string, after: string) =>
            (await messages(api, channelId, 100)).filter(m => trimId(m.authorId) === sp.botId && trimId(m.id) > after);

        test('[OP-03.provider-down] dead URL, then a 429 stub: bounded retries, visible error, no retry loop, failures not charged', async ({ page, seed }, ti) => {
            const { owner } = apis(seed);
            const ch = await assistantChannel(seed, sp.botId, `op-prov-${sp.tag}`);
            await openChannel(page, ch.id, ch.name);

            // Control: the route reaches the stub, and a success is charged (tokens and cost)
            await sp.use('ok');
            const u0 = await sp.usage();
            const ctl = await ask(owner, ch.id, 'control question');
            expect((await assistantReply(owner, ch.id, sp.botId, ctl, 30_000)).content).toBe(`${sp.tag}-ok`);
            const u1 = await waitFor('usage for the control', async () => { const u = await sp.usage(); return u.requests > u0.requests ? u : null; }, 15_000);
            expect(delta(u0, u1)).toEqual({ requests: 1, errors: 0, tokens: 10, costMicros: 13 });

            const cases = [
                { mode: 'dead' as const, error: /^Error: fetch failed/ },
                { mode: 'r429' as const, error: /^Error: OpenAI API 429: Rate limit reached \(stub\)$/ },
            ];
            for (const c of cases) {
                await sp.use(c.mode);
                const before = await sp.usage();
                const q = await ask(owner, ch.id, `question for the ${c.mode} provider`);
                const reply = await assistantReply(owner, ch.id, sp.botId, q, 30_000);
                expect(reply.content, `${c.mode}: the reply is the error`).toMatch(c.error);
                const row = rowWith(page, reply.content);
                await expect(row, `${c.mode}: the error is visible in the channel`).toBeVisible({ timeout: 15_000 });
                if (c.mode === 'r429') await snap(page, ti, 'OP-03.provider-down', '01-429-error', 'An assistant reply reading "Error: OpenAI API 429: Rate limit reached (stub)"', { ready: row });
                const hitsNow = c.mode === 'r429' ? await sp.hits('r429') : 0;
                // Quiet period: nothing retries in the background
                await sleep(15_000);
                const after = await sp.usage();
                expect(delta(before, after), `${c.mode}: one failed request recorded, no tokens, no cost`).toEqual({ requests: 1, errors: 1, tokens: 0, costMicros: 0 });
                expect(await botReplies(owner, ch.id, q), `${c.mode}: one reply for one question`).toHaveLength(1);
                if (c.mode === 'r429') {
                    expect(hitsNow, 'bounded attempts at the provider').toBeGreaterThanOrEqual(1);
                    expect(hitsNow).toBeLessThanOrEqual(3);
                    expect(await sp.hits('r429'), 'no retry loop').toBe(hitsNow);
                    ti.annotations.push({ type: 'r429', description: `${hitsNow} request(s) to the provider` });
                }
            }
            await expectHealthy(seed);
        });

        test('[OP-03.provider-down] a provider that never answers: one request, an error once the fetch gives up, not charged', async ({ page, seed }, ti) => {
            test.setTimeout(480_000);
            const { owner } = apis(seed);
            const ch = await assistantChannel(seed, sp.botId, `op-hang-${sp.tag}`);
            await openChannel(page, ch.id, ch.name);
            await sp.use('hang');
            const before = await sp.usage();
            const askedAt = Date.now();
            const q = await ask(owner, ch.id, 'question for the silent provider');
            const reply = await assistantReply(owner, ch.id, sp.botId, q, 420_000);
            const waited = Math.round((Date.now() - askedAt) / 1000);
            ti.annotations.push({ type: 'timeout', description: `error shown after ${waited} s: ${String(reply.content).slice(0, 120)}` });
            expect(reply.content).toMatch(/^Error: /);
            await expect(rowWith(page, reply.content)).toBeVisible({ timeout: 15_000 });
            expect(await sp.hits('hang'), 'one request, no retry').toBe(1);
            await sleep(10_000);
            expect(await sp.hits('hang'), 'no retry loop').toBe(1);
            expect(delta(before, await sp.usage())).toEqual({ requests: 1, errors: 1, tokens: 0, costMicros: 0 });
            expect(await botReplies(owner, ch.id, q)).toHaveLength(1);
            await expectHealthy(seed);
        });

        test('[OP-03.ws-loss] socket dropped three times while a reply streams: no duplicate or lost messages after reconnect', async ({ page, seed }, ti) => {
            const { owner } = apis(seed);
            const ch = await assistantChannel(seed, sp.botId, `op-ws-${sp.tag}`);
            await sp.use('slow');
            // Every socket the page opens goes through this route, so the test can drop it
            const sockets: { page: WebSocketRoute; server: WebSocketRoute }[] = [];
            await page.routeWebSocket(/\/socket\.io\//, ws => { sockets.push({ page: ws, server: ws.connectToServer() }); });
            await openChannel(page, ch.id, ch.name);
            const dot = (name: RegExp) => page.getByRole('img', { name });
            await expect(dot(/^connected$/)).toBeVisible({ timeout: 15_000 });

            const prompt = `tell me a long story ${sp.tag}`;
            const q = await ask(owner, ch.id, prompt);
            await expect(rowWith(page, `${sp.tag}-w02`), 'the reply is streaming').toBeVisible({ timeout: 20_000 });
            const sent: string[] = [];
            let sawOffline = 0;
            for (let i = 1; i <= 3; i++) {
                const live = sockets[sockets.length - 1];
                await live.page.close({ code: 4000, reason: 'e2e drop' });
                await live.server.close().catch(() => undefined);
                const text = `posted while the socket was down ${i} ${sp.tag}`;
                await owner.ok('POST', `/channels/${ch.id}/messages`, { content: text }, [201]);
                sent.push(text);
                if (await dot(/^(reconnecting|disconnected)$/).count()) sawOffline++;
                await waitFor(`reconnect ${i}`, async () => sockets.length > i, 30_000, 200);
                await expect(dot(/^connected$/)).toBeVisible({ timeout: 30_000 });
                await sleep(1_500);
            }
            expect(sockets.length, 'three drops, three reconnects').toBeGreaterThanOrEqual(4);

            // The stream ends; the page shows the whole reply once, and every message once
            const words = Array.from({ length: 40 }, (_, i) => `${sp.tag}-w${String(i + 1).padStart(2, '0')}`).join(' ');
            const final = await assistantReply(owner, ch.id, sp.botId, q, 60_000);
            expect(final.content).toBe(words);
            const reply = rowWith(page, `${sp.tag}-w40`);
            await expect(reply, 'the reply once').toHaveCount(1, { timeout: 20_000 });
            await expect(reply).toContainText(words);
            await expect(rowWith(page, prompt), 'the question once').toHaveCount(1);
            for (const t of sent) await expect(rowWith(page, t), `"${t}" once`).toHaveCount(1, { timeout: 20_000 });
            await snap(page, ti, 'OP-03.ws-loss', '01-after-reconnects', 'A channel with a question, one long assistant reply of 40 numbered words, and three short messages, each shown once', { ready: reply });

            const all = await messages(owner, ch.id, 100);
            expect(all.filter(m => trimId(m.authorId) === sp.botId), 'one assistant message').toHaveLength(1);
            for (const t of sent) expect(all.filter(m => m.content === t)).toHaveLength(1);
            ti.annotations.push({ type: 'drops', description: `${sockets.length - 1} reconnects; offline state seen right after ${sawOffline} of 3 drops` });
            await expectHealthy(seed);
        });
    });
});

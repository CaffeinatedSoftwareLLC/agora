/**
 * Soak (beta-test-plan §3.5 OP-08): five signed-in browsers on two servers and three fake agents,
 * busy for E2E_SOAK_MINUTES (default 30): long threads, uploads, task cards, composer sends and
 * mentions that wake the agents. Opt-in: E2E_SOAK=1.
 *
 * Actors: owner-e2e, member-e2e, director-e2e and admin-e2e on the instance server (A);
 * outsider-e2e owns a second, run-tagged server (B). Registration joins every user to A, so
 * the outsider is in A too; B's content must reach nobody else. One A channel is private (only
 * owner, the director role and the admin can view it), so member-e2e and outsider-e2e must never
 * receive it either. Everything is created before the browsers connect, so every socket joins
 * every room it may join at its Ready.
 *
 * Checked at the end (hard):
 * - API: every message the run posted is stored exactly once (full history, threads included);
 * - live events: on each browser's socket, every message created during the activity in a
 *   channel that user can view arrived exactly once (none lost, none duplicated);
 * - the open channel of each browser shows each of its latest messages once, before and after
 *   a reload;
 * - cross-tenant: no frame to an A-only user mentions B (ids or content), none to member-e2e or
 *   outsider-e2e mentions the private channel; their API reads of it are refused;
 * - agents: every mention was delivered to its session once and acknowledged, the inbox and
 *   running batches drain to 0 (peak recorded), no batch failed;
 * - API memory stays bounded (docker stats of the agora-e2e api container, plus VmRSS of its
 *   node process): peak under 1.5 GiB and the last fifth of the run's mean no more than 1.5x
 *   the first fifth's + 64 MiB.
 * Throughput, latency percentiles (API post, live delivery), peak RSS and queue depth go to an
 * annotation and to artifacts/<run>/soak-metrics.json.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, apis, loadSeed, waitForChannel } from '../lib/fixtures';
import { artifactsDir, e2eEnv, storageStatePath } from '../lib/env';
import { rowWith } from '../lib/helpers';
import { startFakeHost, waitFor, type FakeHost } from '../lib/fake-host';
import { agentChannel, loginContext, startSession, trimId, waitRuns } from '../lib/agents';
import { exec, readOnlyQuery, serviceContainer, stats } from '../lib/containers';
import { seedRoles, Permissions, type RoleSeed } from '../lib/seed-roles';
import type { Api } from '../lib/api';

const MINUTES = Number(process.env.E2E_SOAK_MINUTES ?? 30);
const LANES = Number(process.env.E2E_SOAK_LANES ?? 3);
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const MiB = 1024 * 1024;
/** Message rows holding a post's marker token as a whole word ("soakA-x-1" must not match "soakA-x-12"). */
const tokenRow = (page: Page, token: string) =>
    page.locator('[data-index]').filter({ hasText: new RegExp(`${token.replace(/[-]/g, '\\-')}(\\s|$)`) });

type Who = 'owner' | 'member' | 'director' | 'admin' | 'outsider';
interface Chan { id: string; name: string; kind: 'pub' | 'priv' | 'agents' | 'b'; viewers: Who[]; marker: string; threadId?: string }
interface Posted { id: string; channelId: string; threadId: string | null; content: string; by: Who; startedAt: number; ms: number; via: 'api' | 'ui' }
interface Received { count: number; firstAt: number }
interface Socket { openedAt: number; messages: Map<string, Received>; forbidden: Map<string, number> }
interface Client { who: Who; ctx: BrowserContext; page: Page; channel: Chan; sockets: Socket[] }

test.describe('soak (OP-08)', () => {
    test.skip(!process.env.E2E_SOAK, 'not_applicable: the soak runs with E2E_SOAK=1 (E2E_SOAK_MINUTES, default 30)');

    let fh: FakeHost | undefined;
    const contexts: BrowserContext[] = [];
    test.afterAll(async () => {
        for (const c of contexts) await c.close().catch(() => undefined);
        await fh?.stop();
    });

    test('[OP-08.soak] five browsers, two servers, three fake agents: no lost or duplicated events, no cross-tenant data, agents drain, memory bounded', async ({ browser, seed }, ti) => {
        test.setTimeout((MINUTES + 15) * 60_000);
        const tag = `${seed.runTag}${crypto.randomBytes(2).toString('hex')}`.toLowerCase().replace(/[^a-z0-9]/g, '');
        const { owner, member } = apis(seed);
        const rs: RoleSeed = await seedRoles(seed);
        const api: Record<Who, Api> = { owner, member, director: rs.director.api, admin: rs.admin.api, outsider: rs.outsider.api };
        const ids: Record<Who, string> = { owner: seed.users.owner.id, member: seed.users.member.id, director: rs.director.id, admin: rs.admin.id, outsider: rs.outsider.id };
        const apiContainer = await serviceContainer('api');

        // ---- channels, threads, agents (all before any browser connects) ----
        const mk = async (as: Api, serverId: string, name: string) => ((await as.ok('POST', `/servers/${serverId}/channels`, { name, channelType: 3 }, [201])) as any).id.trim() as string;
        const pub: Chan = { id: await mk(owner, seed.serverId, `soak-pub-${tag}`), name: `soak-pub-${tag}`, kind: 'pub', viewers: ['owner', 'member', 'director', 'admin', 'outsider'], marker: `soakA-${tag}` };
        const priv: Chan = { id: await mk(owner, seed.serverId, `soak-priv-${tag}`), name: `soak-priv-${tag}`, kind: 'priv', viewers: ['owner', 'director', 'admin'], marker: `soakP-${tag}` };
        const everyone = ((await owner.ok('GET', `/servers/${seed.serverId}/roles`)) as any[]).find(r => r.name === '@everyone');
        await owner.ok('PUT', `/channels/${priv.id}/overrides/roles/${everyone.id.trim()}`, { allow: '0', deny: Permissions.ViewChannel.toString() });
        await owner.ok('PUT', `/channels/${priv.id}/overrides/roles/${rs.directorRoleId}`, { allow: Permissions.ViewChannel.toString(), deny: '0' });
        const bch: Chan = { id: await mk(rs.outsider.api, rs.other.serverId, `soak-b-${tag}`), name: `soak-b-${tag}`, kind: 'b', viewers: ['outsider'], marker: `soakB-${tag}` };

        fh = await startFakeHost(seed, { label: 'soak', profiles: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] });
        const agentKeys = ['a', 'b', 'c'];
        const ag = await agentChannel(seed, fh, `soak-ag-${tag}`, agentKeys);
        const agents: Chan = { id: ag.id, name: ag.name, kind: 'agents', viewers: ['owner', 'member', 'director', 'admin', 'outsider'], marker: `soakG-${tag}` };
        const sessionIds: string[] = [];
        for (const k of agentKeys) sessionIds.push(await startSession(owner, agents.id, fh.agents[k].name));
        for (const k of agentKeys) await waitRuns(fh, k, 1, 90_000);
        if (!sessionIds.every(s => ULID.test(s))) throw new Error('session ids');
        const agentBotIds = new Set(agentKeys.map(k => fh!.agents[k].botId));

        // Thread roots: one long thread per human channel
        for (const [c, as] of [[pub, owner], [priv, owner], [bch, rs.outsider.api]] as const) {
            c.threadId = trimId(((await as.ok('POST', `/channels/${c.id}/messages`, { content: `${c.marker} thread root` }, [201])) as any).id);
        }
        const chans = [pub, priv, bch, agents];

        // Cross-tenant API reads (before the activity: the answer can't depend on load)
        const refusals: Record<string, number> = {};
        for (const w of ['owner', 'member', 'director', 'admin'] as Who[]) refusals[`${w} reads B`] = (await api[w].req('GET', `/channels/${bch.id}/messages?limit=1`)).status;
        for (const w of ['member', 'outsider'] as Who[]) refusals[`${w} reads private`] = (await api[w].req('GET', `/channels/${priv.id}/messages?limit=1`)).status;
        for (const [k, v] of Object.entries(refusals)) expect(v, `${k} is refused`).toBe(403);

        // ---- browsers ----
        const forbiddenFor = (who: Who): Record<string, string[]> => ({
            ...(who !== 'outsider' ? { 'server B': [rs.other.serverId, bch.id, bch.marker] } : {}),
            ...(['member', 'outsider'].includes(who) ? { 'private channel': [priv.id, priv.marker] } : {}),
        });
        const openOn: Record<Who, Chan> = { owner: agents, member: pub, director: priv, admin: pub, outsider: bch };
        const clients: Client[] = [];
        for (const who of ['owner', 'member', 'director', 'admin', 'outsider'] as Who[]) {
            const ctx = who === 'owner' || who === 'member'
                ? await browser.newContext({ storageState: storageStatePath(who), baseURL: e2eEnv().baseURL })
                : await loginContext(browser, rs[who].username, rs[who].password, { baseURL: e2eEnv().baseURL });
            contexts.push(ctx);
            const page = await ctx.newPage();
            const client: Client = { who, ctx, page, channel: openOn[who], sockets: [] };
            const forbidden = forbiddenFor(who);
            page.on('websocket', ws => {
                if (!ws.url().includes('/socket.io/')) return;
                const s: Socket = { openedAt: Date.now(), messages: new Map(), forbidden: new Map() };
                client.sockets.push(s);
                ws.on('framereceived', f => {
                    const text = typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8');
                    for (const [kind, needles] of Object.entries(forbidden)) {
                        if (needles.some(n => text.includes(n))) s.forbidden.set(kind, (s.forbidden.get(kind) ?? 0) + 1);
                    }
                    const m = /^42\d*(\[.*)$/s.exec(text);
                    if (!m) return;
                    let ev: any;
                    try { ev = JSON.parse(m[1]); } catch { return; }
                    if (ev[0] !== 'Message' || !ev[1]?.id) return;
                    const id = trimId(ev[1].id);
                    const r = s.messages.get(id);
                    if (r) r.count++; else s.messages.set(id, { count: 1, firstAt: Date.now() });
                });
            });
            await page.goto(`/app/${client.channel.id}`);
            await waitForChannel(page, client.channel.name);
            await expect(page.getByRole('img', { name: /^connected$/ })).toBeVisible({ timeout: 20_000 });
            clients.push(client);
        }

        // ---- samplers: API memory, agent queue ----
        const mem: { t: number; docker: number; rss: number }[] = [];
        const queue: { t: number; inbox: number; running: number }[] = [];
        const sessionList = sessionIds.map(s => `'${s}'`).join(',');
        const sampleMem = async () => {
            const [d, st] = await Promise.all([stats(apiContainer), exec(apiContainer, ['sh', '-c', 'grep VmRSS /proc/1/status'])]);
            const kb = Number(/(\d+)\s*kB/.exec(st.stdout)?.[1] ?? NaN);
            mem.push({ t: Date.now(), docker: d.memBytes, rss: kb * 1024 });
        };
        const sampleQueue = async () => {
            const [row] = await readOnlyQuery(`SELECT
                (SELECT count(*) FROM agent_inbox WHERE session_id IN (${sessionList}) AND batch_id IS NULL AND acked_at IS NULL),
                (SELECT count(*) FROM agent_batches WHERE session_id IN (${sessionList}) AND status IN ('running', 'retry'))`);
            const [inbox, running] = row.split('\t').map(Number);
            queue.push({ t: Date.now(), inbox, running });
            return inbox + running;
        };
        await sampleMem();
        await sampleQueue();

        // ---- activity ----
        const posted: Posted[] = [];
        const failures: string[] = [];
        const mentions: { id: string; key: string }[] = [];
        const tasks: string[] = [];
        let uploads = 0;
        let seq = 0;
        const humans: Who[] = ['owner', 'member', 'director', 'admin', 'outsider'];
        const viewersOf = (c: Chan) => c.viewers;
        const pick = <T>(xs: T[], n: number) => xs[n % xs.length];

        const post = async (by: Who, c: Chan, opts: { thread?: boolean; text?: string; attachments?: string[] } = {}) => {
            const n = ++seq;
            const content = opts.text ?? `${c.marker}-${n} ${opts.thread ? 'reply' : 'post'} by ${by}`;
            const p = opts.thread ? `/channels/${c.id}/messages/${c.threadId}/replies` : `/channels/${c.id}/messages`;
            const startedAt = Date.now();
            const r = await api[by].req('POST', p, { content, ...(opts.attachments ? { attachments: opts.attachments } : {}) });
            const ms = Date.now() - startedAt;
            if (r.status !== 201) { failures.push(`${by} POST ${c.kind}${opts.thread ? ' thread' : ''} -> ${r.status}`); return null; }
            const rec: Posted = { id: trimId(r.data.id), channelId: c.id, threadId: opts.thread ? c.threadId! : null, content, by, startedAt, ms, via: 'api' };
            posted.push(rec);
            return rec;
        };

        const actions: Array<(n: number) => Promise<unknown>> = [
            n => post(pick(humans, n), pub),
            n => post(pick(humans, n), pub, { thread: true }),
            n => post(pick(['owner', 'director', 'admin'] as Who[], n), priv),
            n => post(pick(['owner', 'director', 'admin'] as Who[], n), priv, { thread: true }),
            () => post('outsider', bch),
            () => post('outsider', bch, { thread: true }),
            n => post(pick(humans, n), agents),
        ];
        const deadline = Date.now() + MINUTES * 60_000;
        const activityStart = Date.now();
        let firstActivityId = '';
        const first = await post('owner', pub, { text: `${pub.marker}-start soak begins` });
        if (!first) throw new Error('the first soak post failed');
        firstActivityId = first.id;

        const lane = async (laneNo: number) => {
            let n = laneNo;
            while (Date.now() < deadline) {
                await actions[n % actions.length](n).catch(e => failures.push(`lane ${laneNo}: ${(e as Error).message.slice(0, 200)}`));
                n += LANES;
                await sleep(500 + (n % 5) * 100);
            }
        };
        const periodic = async (everyMs: number, fn: (i: number) => Promise<unknown>) => {
            let i = 0;
            while (Date.now() < deadline) {
                await sleep(everyMs);
                if (Date.now() >= deadline) break;
                await fn(i++).catch(e => failures.push(`periodic: ${(e as Error).message.slice(0, 200)}`));
            }
        };

        await Promise.all([
            ...Array.from({ length: LANES }, (_, i) => lane(i)),
            // Mentions that wake the agents; every fourth one is a burst of three, so batches form
            periodic(12_000, async i => {
                const k = agentKeys[i % 3];
                const by: Who = i % 2 ? 'director' : 'owner';
                const burst = i % 4 === 3 ? 3 : 1;
                for (let b = 0; b < burst; b++) {
                    const rec = await post(by, agents, { text: `@${fh!.agents[k].name} ${agents.marker}-m${i}-${b} soak ping #fake-sleep=${1 + (i % 3)}` });
                    if (rec) mentions.push({ id: rec.id, key: k });
                }
            }),
            // Uploads, posted with their message (20 per minute per user is the limit; this is 2)
            periodic(15_000, async i => {
                const by = pick(['owner', 'member', 'admin', 'director'] as Who[], i);
                const fd = new FormData();
                fd.append('channel_id', pub.id);
                fd.append('file', new Blob([`soak upload ${i} ${tag}\n`.repeat(20)], { type: 'text/plain' }), `soak-${tag}-${i}.txt`);
                const up = await api[by].req('POST', '/files/upload', fd);
                if (up.status !== 201) { failures.push(`${by} upload -> ${up.status}`); return; }
                uploads++;
                await post(by, pub, { text: `${pub.marker}-f${i} file from ${by}`, attachments: [trimId(up.data.id)] });
            }),
            // Task cards: create, then move the previous one along
            periodic(30_000, async i => {
                const r = await owner.req('POST', `/channels/${pub.id}/tasks`, { title: `${pub.marker} task ${i}` });
                if (r.status !== 201) { failures.push(`task create -> ${r.status}`); return; }
                tasks.push(trimId(r.data.card.id));
                if (tasks.length > 1) {
                    const u = await owner.req('PATCH', `/channels/${pub.id}/tasks/${tasks[tasks.length - 2]}`, { status: 'done' });
                    if (u.status !== 200) failures.push(`task update -> ${u.status}`);
                }
            }),
            // Composer sends from each browser in turn
            periodic(20_000, async i => {
                const c = clients[i % clients.length];
                if (c.channel.kind === 'agents') return;
                const text = `${c.channel.marker}-u${i} typed by ${c.who}`;
                const startedAt = Date.now();
                const box = c.page.getByPlaceholder(`Message #${c.channel.name}`);
                await box.fill(text);
                await c.page.getByRole('button', { name: 'Send message' }).click();
                await expect(rowWith(c.page, text)).toHaveCount(1, { timeout: 20_000 });
                const row = await waitFor('typed message stored', async () =>
                    ((await api[c.who].ok('GET', `/channels/${c.channel.id}/messages?limit=30`)) as any[]).find(m => m.content === text), 20_000, 500);
                posted.push({ id: trimId(row.id), channelId: c.channel.id, threadId: null, content: text, by: c.who, startedAt, ms: Date.now() - startedAt, via: 'ui' });
            }),
            periodic(30_000, () => sampleMem()),
            periodic(10_000, () => sampleQueue()),
        ]);
        const activityMs = Date.now() - activityStart;

        // Sockets each browser opened during the activity (the reload check below adds one each)
        const socketsDuringActivity = new Map(clients.map(c => [c.who, c.sockets.length]));

        // ---- drain ----
        const drained = await waitFor('agent queue drained', async () => ((await sampleQueue()) === 0 ? true : null), 300_000, 2_000).catch(() => false);
        await sleep(10_000);
        await sampleMem();

        // ---- API: every post stored exactly once ----
        const listAll = async (as: Api, c: Chan) => {
            const top: any[] = [];
            let before = '';
            for (;;) {
                const page = (await as.ok('GET', `/channels/${c.id}/messages?limit=100${before ? `&before=${before}` : ''}`)) as any[];
                top.push(...page);
                if (page.length < 100) break;
                before = trimId(page[page.length - 1].id);
            }
            const replies: any[] = [];
            let after = '';
            while (c.threadId) {
                const r = (await as.ok('GET', `/channels/${c.id}/messages/${c.threadId}/replies?limit=100${after ? `&after=${after}` : ''}`)) as any;
                const rows: any[] = Array.isArray(r) ? r : (r.replies ?? r.messages ?? []);
                replies.push(...rows);
                if (rows.length < 100) break;
                after = trimId(rows[rows.length - 1].id);
            }
            return [...top, ...replies];
        };
        const stored = new Map<string, any[]>();
        for (const c of chans) stored.set(c.id, await listAll(c.kind === 'b' ? rs.outsider.api : owner, c));
        let missingInApi = 0, duplicatedInApi = 0;
        for (const p of posted) {
            const n = stored.get(p.channelId)!.filter(m => trimId(m.id) === p.id).length;
            const byContent = stored.get(p.channelId)!.filter(m => m.content === p.content).length;
            if (n === 0) missingInApi++;
            if (n > 1 || byContent > 1) duplicatedInApi++;
        }

        // ---- live events: each viewer's socket got every message of the activity once ----
        const delivery: number[] = [];
        const perClient: Record<string, unknown> = {};
        let lost = 0, duplicated = 0, crossTenant = 0;
        for (const c of clients) {
            const reconnects = socketsDuringActivity.get(c.who)! - 1;
            const s = c.sockets[0];
            let cLost = 0, cDup = 0;
            for (const ch of chans) {
                if (!viewersOf(ch).includes(c.who)) continue;
                for (const m of stored.get(ch.id)!) {
                    const id = trimId(m.id);
                    if (id < firstActivityId) continue;
                    const got = s.messages.get(id);
                    if (!got) cLost++;
                    else if (got.count > 1) cDup++;
                }
            }
            // Duplicates of anything at all on any socket
            for (const sock of c.sockets) for (const r of sock.messages.values()) if (r.count > 1) cDup++;
            for (const p of posted) {
                if (!viewersOf(chans.find(x => x.id === p.channelId)!).includes(c.who) || p.by === c.who) continue;
                const got = s.messages.get(p.id);
                if (got) delivery.push(got.firstAt - p.startedAt);
            }
            const forbidden = Object.fromEntries(c.sockets.flatMap(x => [...x.forbidden.entries()]));
            crossTenant += Object.values(forbidden).reduce((a, b) => a + b, 0);
            lost += reconnects ? 0 : cLost;
            duplicated += cDup;
            perClient[c.who] = { reconnects, received: s.messages.size, lost: cLost, duplicated: cDup, forbiddenFrames: forbidden };
        }

        // ---- the open channel of each browser shows its latest messages once, live and after a reload ----
        const view: Record<string, unknown> = {};
        for (const c of clients) {
            // The marker token is unique per post (mentions render as chips, so not the whole
            // text); only the newest few, which the virtualized list has rendered at the bottom
            const latest = (await api[c.who].ok('GET', `/channels/${c.channel.id}/messages?limit=10`) as any[])
                .filter(m => posted.some(p => p.id === trimId(m.id))).slice(0, 5)
                .map(m => /soak[A-Z]-[a-z0-9]+-[a-z0-9-]+/.exec(String(m.content))![0]);
            const counts = async () => Promise.all(latest.map(t => tokenRow(c.page, t).count()));
            const live = await counts();
            await c.page.reload();
            await waitForChannel(c.page, c.channel.name);
            await expect(tokenRow(c.page, latest[0] ?? 'soak').first()).toBeVisible({ timeout: 20_000 });
            const reloaded = await counts();
            view[c.who] = { checked: latest.length, liveNotOnce: live.filter(n => n !== 1).length, reloadedNotOnce: reloaded.filter(n => n !== 1).length };
        }

        // ---- agents: every mention delivered once and acknowledged; batches ----
        const mentionIds = mentions.map(m => m.id).filter(id => ULID.test(id));
        const [delivered] = mentionIds.length ? await readOnlyQuery(`SELECT count(*), count(*) FILTER (WHERE acked_at IS NOT NULL), count(DISTINCT message_id)
            FROM agent_inbox WHERE session_id IN (${sessionList}) AND message_id IN (${mentionIds.map(i => `'${i}'`).join(',')})`) : ['0\t0\t0'];
        const [inboxRows, acked, distinctMsgs] = delivered.split('\t').map(Number);
        const batchRows = await readOnlyQuery(`SELECT status, count(*) FROM agent_batches WHERE session_id IN (${sessionList}) GROUP BY status`);
        const batches = Object.fromEntries(batchRows.map(r => r.split('\t')).map(([k, v]) => [k, Number(v)]));
        const agentReplies = stored.get(agents.id)!.filter(m => agentBotIds.has(trimId(m.authorId))).length;
        const runs = agentKeys.reduce((n, k) => n + fh!.traces(k).filter(t => t.outcome).length, 0);
        const cards = ((await owner.ok('GET', `/channels/${pub.id}/tasks`)) as any).cards.length;

        // ---- metrics ----
        const apiMs = posted.filter(p => p.via === 'api').map(p => p.ms);
        const fifth = Math.max(1, Math.floor(mem.length / 5));
        const metrics = {
            minutes: MINUTES, lanes: LANES, activitySeconds: Math.round(activityMs / 1000),
            posted: { total: posted.length, api: apiMs.length, ui: posted.length - apiMs.length, perMinute: +(posted.length / (activityMs / 60_000)).toFixed(1), uploads, taskCards: tasks.length, cardsListed: cards, mentions: mentions.length, failures: failures.length, failureSamples: failures.slice(0, 10) },
            latencyMs: { apiPost: { p50: pct(apiMs, 50), p95: pct(apiMs, 95), p99: pct(apiMs, 99), max: pct(apiMs, 100) }, delivery: { n: delivery.length, p50: pct(delivery, 50), p95: pct(delivery, 95), p99: pct(delivery, 99), max: pct(delivery, 100) } },
            events: { lost, duplicated, crossTenantFrames: crossTenant, perClient },
            api: { missing: missingInApi, duplicated: duplicatedInApi, refusals },
            view,
            agents: { mentions: mentions.length, inboxRows, acked, distinctMsgs, batches, runs, agentReplies, drained, peakQueue: Math.max(...queue.map(q => q.inbox + q.running)), peakInbox: Math.max(...queue.map(q => q.inbox)), finalQueue: queue[queue.length - 1] },
            memory: {
                samples: mem.length,
                dockerMiB: { first: +(mem[0].docker / MiB).toFixed(1), peak: +(Math.max(...mem.map(m => m.docker)) / MiB).toFixed(1), last: +(mem[mem.length - 1].docker / MiB).toFixed(1),
                    firstFifthMean: +(mean(mem.slice(0, fifth).map(m => m.docker)) / MiB).toFixed(1), lastFifthMean: +(mean(mem.slice(-fifth).map(m => m.docker)) / MiB).toFixed(1) },
                rssMiB: { first: +(mem[0].rss / MiB).toFixed(1), peak: +(Math.max(...mem.map(m => m.rss)) / MiB).toFixed(1), last: +(mem[mem.length - 1].rss / MiB).toFixed(1),
                    firstFifthMean: +(mean(mem.slice(0, fifth).map(m => m.rss)) / MiB).toFixed(1), lastFifthMean: +(mean(mem.slice(-fifth).map(m => m.rss)) / MiB).toFixed(1) },
                series: mem.map(m => ({ s: Math.round((m.t - activityStart) / 1000), dockerMiB: +(m.docker / MiB).toFixed(1), rssMiB: +(m.rss / MiB).toFixed(1) })),
            },
            queueSeries: queue.map(q => ({ s: Math.round((q.t - activityStart) / 1000), inbox: q.inbox, running: q.running })),
        };
        fs.mkdirSync(artifactsDir(), { recursive: true });
        fs.writeFileSync(path.join(artifactsDir(), 'soak-metrics.json'), JSON.stringify(metrics, null, 2));
        ti.annotations.push({ type: 'soak', description: JSON.stringify({ posted: metrics.posted.total, perMinute: metrics.posted.perMinute, apiP95: metrics.latencyMs.apiPost.p95,
            deliveryP95: metrics.latencyMs.delivery.p95, lost, duplicated, crossTenant, peakQueue: metrics.agents.peakQueue, peakDockerMiB: metrics.memory.dockerMiB.peak, peakRssMiB: metrics.memory.rssMiB.peak }) });

        // ---- assertions ----
        expect(failures, 'requests that failed during the activity').toEqual([]);
        expect(missingInApi, 'posts missing from the API').toBe(0);
        expect(duplicatedInApi, 'posts stored more than once').toBe(0);
        expect(lost, 'messages a viewer\'s socket never received').toBe(0);
        expect(duplicated, 'messages a socket received more than once').toBe(0);
        for (const c of clients) expect.soft(socketsDuringActivity.get(c.who), `${c.who}: sockets during the soak (1 = no reconnect)`).toBe(1);
        expect(crossTenant, 'frames carrying another tenant\'s (or the private channel\'s) ids or content').toBe(0);
        for (const [who, v] of Object.entries(view) as [string, any][]) {
            expect(v.checked, `${who}: latest messages checked`).toBeGreaterThan(0);
            expect(v.liveNotOnce, `${who}: latest messages not shown exactly once (live)`).toBe(0);
            expect(v.reloadedNotOnce, `${who}: latest messages not shown exactly once (after reload)`).toBe(0);
        }
        expect(drained, 'the agent inbox and running batches drained').toBe(true);
        expect(inboxRows, 'every mention delivered to its session once').toBe(mentionIds.length);
        expect(distinctMsgs).toBe(mentionIds.length);
        expect(acked, 'every delivered mention acknowledged').toBe(mentionIds.length);
        expect((batches.failed ?? 0) + (batches.dropped ?? 0), 'no failed or dropped batches').toBe(0);
        expect(cards).toBeGreaterThanOrEqual(tasks.length);
        const peakDocker = Math.max(...mem.map(m => m.docker));
        expect(peakDocker, 'API container memory peak (bytes)').toBeLessThan(1.5 * 1024 * MiB);
        expect(mean(mem.slice(-fifth).map(m => m.docker)), 'API memory: last fifth vs first fifth').toBeLessThanOrEqual(1.5 * mean(mem.slice(0, fifth).map(m => m.docker)) + 64 * MiB);
        expect(mean(mem.slice(-fifth).map(m => m.rss)), 'API RSS: last fifth vs first fifth').toBeLessThanOrEqual(1.5 * mean(mem.slice(0, fifth).map(m => m.rss)) + 64 * MiB);
    });
});

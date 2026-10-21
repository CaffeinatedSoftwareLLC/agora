/**
 * Host crashes (beta-test-plan §3.5 OP-02): a real agora-host running the fake CLI is killed
 * (whole process tree, nothing reported) at one point of a run or a workspace command, then
 * started again with the same config. Not in the smoke set: each scenario waits out a real
 * lease (runs: 120 s after the last heartbeat, swept every 15 s; workspace commands: 180 s),
 * since the server has no test-only way to shorten them.
 *
 * The fake CLI's #fake-mark directive writes a trace line when a run starts and once it has
 * posted, so the test kills the host between steps; #fake-hold keeps it running after the post.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, apis, loadSeed } from '../lib/fixtures';
import { startFakeHost, waitFor, type FakeHost } from '../lib/fake-host';
import { agentChannel, messages, sessionOf, startSession, trimId, waitIdle, waitRuns } from '../lib/agents';
import { expectHealthy } from '../lib/ops';
import type { Api } from '../lib/api';

let fh: FakeHost;
/** Lease 120 s after the last heartbeat (every 30 s): a killed run can't come back sooner than this. */
const MIN_REDELIVERY_MS = 85_000;
const TIMED_OUT_NOTICE = 'Workspace command timed out. Check repository state and possible Git lock files before retrying.';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}
/** Fake CLI trace lines of one phase ('started' / 'posted') for the run that carries `word`. */
const phases = (key: string, phase: string, word: string) => fh.traces(key).filter(t => t.phase === phase && t.directives?.say === word);
const finished = (key: string, word: string) => fh.traces(key).filter(t => t.outcome && t.directives?.say === word);
async function botPosts(api: Api, channelId: string, botId: string, word: string) {
    return (await messages(api, channelId, 100)).filter(m => trimId(m.authorId) === botId && String(m.content).includes(word));
}
/** A live session whose hello run is done; returns its id and that run's id. */
async function readySession(owner: Api, key: string, label: string) {
    const a = fh.agents[key];
    const ch = await agentChannel(loadSeed(), fh, label, [key]);
    const sid = await startSession(owner, ch.id, a.name);
    const [hello] = await waitRuns(fh, key, 1);
    await waitIdle(owner, ch.id, a.name, sid);
    return { a, ch, sid, helloRunId: String(hello.runId) };
}
/** Wait until the session's latest run succeeded and is not the hello run. */
async function settledRun(owner: Api, channelId: string, profile: string, sid: string, helloRunId: string, timeoutMs: number) {
    return waitFor(`${profile}: a new run to succeed`, async () => {
        const s = await sessionOf(owner, channelId, profile, sid);
        return s && !s.running && s.run?.status === 'succeeded' && trimId(s.run.id) !== helloRunId ? s : null;
    }, timeoutMs, 1000);
}

test.describe('host crashes (OP-02)', () => {
    // Minutes long and they pause containers: only when asked for
    test.skip(!process.env.E2E_OPS, 'not_applicable: crash and outage scenarios run with E2E_OPS=1');
    test.describe.configure({ timeout: 420_000 });
    test.beforeAll(async () => {
        fh = await startFakeHost(loadSeed(), { label: 'op-crash', profiles: [{ key: 'effect' }, { key: 'pre' }, { key: 'claim' }, { key: 'wscmd' }] });
    });
    test.afterEach(async ({ seed }) => {
        if (fh && !fh.running()) await fh.restart();
        await expectHealthy(seed);
    });
    test.afterAll(async () => { await fh?.stop(); });

    test('[OP-02.crash-after-effect] host killed after the CLI posted, before complete: redelivered after the lease, repeated post is a no-op', async ({ seed }, ti) => {
        const { owner } = apis(seed);
        const { a, ch, sid, helloRunId } = await readySession(owner, 'effect', 'op-effect');
        const word = `effect${fh.tag}`;
        await owner.ok('POST', `/channels/${ch.id}/messages`, { content: `@${a.name} post, then crash #fake-mark #fake-hold=40 #fake-say=${word}` }, [201]);

        const first = await waitFor('attempt 1 posted', async () => phases('effect', 'posted', word)[0], 60_000, 250);
        expect(await botPosts(owner, ch.id, a.botId, word), 'the post is committed before the crash').toHaveLength(1);
        await fh.kill();
        const killedAt = Date.now();
        expect(alive(first.pid), 'the CLI died with the host').toBe(false);
        const held = await sessionOf(owner, ch.id, a.name, sid);
        expect(trimId(held.run.id), 'nothing was reported: the run is still claimed').toBe(first.runId);
        expect(held.run.status).toBe('claimed');

        await fh.restart();
        const s = await settledRun(owner, ch.id, a.name, sid, helloRunId, 300_000);

        // Redelivered: a second run of the same batch (same delivery key) after the lease ran out
        const posted = phases('effect', 'posted', word);
        expect(posted, 'the fake CLI reached its post twice (attempt 1, then the redelivery)').toHaveLength(2);
        expect(posted[1].runId).not.toBe(posted[0].runId);
        expect(posted[1].deliveryKey, 'same delivery key, so the same client_key').toBe(posted[0].deliveryKey);
        const restarted = phases('effect', 'started', word)[1];
        expect(Date.parse(restarted.at) - killedAt, 'redelivered only after the lease expired').toBeGreaterThanOrEqual(MIN_REDELIVERY_MS);
        const runs = new Map((s.recentRuns as any[]).map(r => [trimId(r.id), r.status]));
        expect(runs.get(first.runId), 'the killed run expired').toBe('expired');
        expect(trimId(s.run.id)).toBe(posted[1].runId);

        // The client_key made the repeated post a no-op: one message, not two
        expect(await botPosts(owner, ch.id, a.botId, word)).toHaveLength(1);
        expect(s.state).toBe('live');
        ti.annotations.push({ type: 'timing', description: `redelivered ${Math.round((Date.parse(restarted.at) - killedAt) / 1000)} s after the kill` });
        await expectHealthy(seed);
    });

    test('[OP-02.crash-before-claim] work arrives while the host is down: one run after the restart, no duplicate', async ({ seed }, ti) => {
        const { owner } = apis(seed);
        const { a, ch, sid, helloRunId } = await readySession(owner, 'pre', 'op-preclaim');
        await fh.kill();
        const word = `pre${fh.tag}`;
        await owner.ok('POST', `/channels/${ch.id}/messages`, { content: `@${a.name} while the host is down #fake-mark #fake-say=${word}` }, [201]);
        await sleep(5_000);
        // No host is running, so nothing starts. The server may still hand the batch to the killed
        // host's open long poll (a claim nobody receives); then it waits for that lease.
        expect(phases('pre', 'started', word), 'no CLI ran while the host was down').toHaveLength(0);
        const during = await sessionOf(owner, ch.id, a.name, sid);
        const lostClaim = during.run?.status === 'claimed' && trimId(during.run.id) !== helloRunId;

        await fh.restart();
        const s = await settledRun(owner, ch.id, a.name, sid, helloRunId, 300_000);

        expect(phases('pre', 'started', word), 'exactly one CLI run for the message').toHaveLength(1);
        expect(finished('pre', word)).toHaveLength(1);
        expect(trimId(s.run.id)).toBe(phases('pre', 'started', word)[0].runId);
        expect(await botPosts(owner, ch.id, a.botId, word), 'one reply').toHaveLength(1);
        // Runs after the hello: the one that ran, plus at most one lost claim that expired unrun
        const later = (s.recentRuns as any[]).filter(r => trimId(r.id) !== helloRunId);
        const expired = later.filter(r => r.status === 'expired');
        expect(later.filter(r => r.status === 'succeeded')).toHaveLength(1);
        expect(expired.length).toBeLessThanOrEqual(1);
        expect(later.length).toBe(1 + expired.length);
        for (const r of expired) expect(fh.traces('pre').some(t => t.runId === trimId(r.id)), 'an expired claim never ran').toBe(false);
        if (lostClaim) expect(expired, 'the claim seen during the outage expired').toHaveLength(1);
        ti.annotations.push({ type: 'path', description: expired.length
            ? 'the batch was claimed for the killed host\'s open long poll; that lease expired and the restarted host got it'
            : 'claimed by the restarted host directly' });
        await expectHealthy(seed);
    });

    test('[OP-02.crash-after-claim] host killed while the CLI works (before it posts): redelivered after the lease, one reply', async ({ seed }, ti) => {
        const { owner } = apis(seed);
        const { a, ch, sid, helloRunId } = await readySession(owner, 'claim', 'op-claim');
        const word = `claim${fh.tag}`;
        await owner.ok('POST', `/channels/${ch.id}/messages`, { content: `@${a.name} long job #fake-mark #fake-sleep=30 #fake-say=${word}` }, [201]);

        const first = await waitFor('attempt 1 started', async () => phases('claim', 'started', word)[0], 60_000, 250);
        const held = await sessionOf(owner, ch.id, a.name, sid);
        expect(held.run.status).toBe('claimed');
        expect(trimId(held.run.id)).toBe(first.runId);
        await fh.kill();
        const killedAt = Date.now();
        expect(alive(first.pid), 'the CLI died with the host').toBe(false);

        await fh.restart();
        const s = await settledRun(owner, ch.id, a.name, sid, helloRunId, 330_000);

        const started = phases('claim', 'started', word);
        expect(started, 'attempt 1 (killed) and the redelivery').toHaveLength(2);
        expect(started[1].runId).not.toBe(first.runId);
        expect(started[1].deliveryKey).toBe(first.deliveryKey);
        expect(Date.parse(started[1].at) - killedAt, 'redelivered only after the lease expired').toBeGreaterThanOrEqual(MIN_REDELIVERY_MS);
        expect(finished('claim', word), 'only the redelivery finished').toHaveLength(1);
        expect(phases('claim', 'posted', word), 'the killed attempt never posted').toHaveLength(1);
        const byId = new Map((s.recentRuns as any[]).map(r => [trimId(r.id), r]));
        const killed = byId.get(first.runId);
        expect(killed?.status).toBe('expired');
        expect(trimId(s.run.id)).toBe(started[1].runId);
        // Never two runs at once: the redelivery was claimed after the killed run expired
        expect(Date.parse(byId.get(started[1].runId).startedAt)).toBeGreaterThanOrEqual(Date.parse(killed.finishedAt));
        expect(await botPosts(owner, ch.id, a.botId, word), 'one reply').toHaveLength(1);
        ti.annotations.push({ type: 'timing', description: `redelivered ${Math.round((Date.parse(started[1].at) - killedAt) / 1000)} s after the kill` });
        await expectHealthy(seed);
    });

    test('[OP-02.workspace-cmd-crash] host killed during a commit: the command expires after 180 s, is never replayed, the worktree stays consistent', async ({ seed }, ti) => {
        const { owner } = apis(seed);
        const { a, ch, sid } = await readySession(owner, 'wscmd', 'op-wscmd');
        const wt = path.join(a.stateDir, `wt-${sid.slice(-10)}`);
        expect(fs.existsSync(wt), 'the session worktree exists').toBe(true);
        const branch = `refs/heads/agora/${a.name}/${sid}`;
        const headBefore = git(fh.workdir, ['rev-parse', branch]);

        // Make `git add` slow for one file: a clean filter that logs, sleeps 60 s, then passes
        // the content through. The host turns hooks off, not filters. Common config and
        // info/attributes apply to every worktree of the fake repo.
        const marker = path.join(path.dirname(fh.workdir), `slow-filter-${fh.tag}.log`);
        const m = marker.replace(/\\/g, '/');
        const attributes = path.join(fh.workdir, '.git', 'info', 'attributes');
        git(fh.workdir, ['config', 'filter.e2eslow.clean', `echo started >> '${m}'; sleep 60; echo finished >> '${m}'; cat`]);
        fs.mkdirSync(path.dirname(attributes), { recursive: true });
        fs.appendFileSync(attributes, 'slow-*.txt filter=e2eslow\n');
        const dropFilter = () => {
            try { git(fh.workdir, ['config', '--unset', 'filter.e2eslow.clean']); } catch { /* already gone */ }
            try { fs.writeFileSync(attributes, fs.readFileSync(attributes, 'utf8').replace('slow-*.txt filter=e2eslow\n', '')); } catch { /* gone */ }
        };
        try {
            fs.writeFileSync(path.join(wt, 'slow-1.txt'), 'staged by the e2e crash test\n');
            const cmdUrl = (id: string) => `/channels/${ch.id}/sessions/${sid}/workspace-commands/${id}`;
            const queuedAt = Date.now();
            const { id: cmdId } = (await owner.ok('POST', `/channels/${ch.id}/sessions/${sid}/workspace-commands`, { action: 'commit', message: `e2e crash commit ${fh.tag}` }, [202])) as any;
            await waitFor('commit in progress (filter running)', async () => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('started'), 30_000, 200);
            expect(((await owner.ok('GET', cmdUrl(cmdId))) as any).status).toBe('claimed');
            await fh.kill();
            await fh.restart();

            // Expired by the restarted host's command poll once the 180 s lease is over
            const cmd = await waitFor('command to expire', async () => {
                const c = (await owner.ok('GET', cmdUrl(cmdId))) as any;
                return c.status === 'claimed' || c.status === 'queued' ? null : c;
            }, 260_000, 2000);
            expect(cmd.status).toBe('failed');
            expect(cmd.result?.error).toBe('host_timeout_check_repository_before_retry');
            expect(Date.now() - queuedAt, 'not before the 180 s lease').toBeGreaterThanOrEqual(175_000);
            const notices = (await messages(owner, ch.id, 100)).filter(x => x.content === TIMED_OUT_NOTICE);
            expect(notices, 'one timeout notice in the channel').toHaveLength(1);

            // Never replayed: the filter (inside `git add`) ran once; the restarted host never ran the commit again
            const lines = fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean);
            expect(lines.filter(l => l === 'started'), 'git add ran once').toHaveLength(1);
            expect.soft(lines, 'the killed git process tree did not keep running').not.toContain('finished');

            // Consistent: no partial commit, an intact object store
            expect(git(fh.workdir, ['rev-parse', branch]), 'the session branch did not move').toBe(headBefore);
            expect(() => git(fh.workdir, ['fsck', '--no-progress', '--connectivity-only']), 'git fsck passes').not.toThrow();
            const lock = path.resolve(wt, git(wt, ['rev-parse', '--git-path', 'index.lock']));
            const staleLock = fs.existsSync(lock);
            expect.soft(staleLock, 'no stale index.lock left in the session worktree (git add was killed holding it)').toBe(false);

            // Usable again: without the slow filter, the same commit goes through Agora
            dropFilter();
            const { id: retryId } = (await owner.ok('POST', `/channels/${ch.id}/sessions/${sid}/workspace-commands`, { action: 'commit', message: `e2e retry commit ${fh.tag}` }, [202])) as any;
            const retry = await waitFor('retry commit', async () => {
                const c = (await owner.ok('GET', cmdUrl(retryId))) as any;
                return c.status === 'claimed' || c.status === 'queued' ? null : c;
            }, 60_000, 1000);
            expect.soft(retry.status, `a commit after the crash works (result: ${JSON.stringify(retry.result)})`).toBe('succeeded');
            if (retry.status === 'succeeded') expect(git(fh.workdir, ['show', '--name-only', '--format=', branch]).split(/\r?\n/)).toContain('slow-1.txt');
            ti.annotations.push({ type: 'worktree', description: staleLock ? 'stale index.lock after the kill' : 'no stale lock' });
        } finally {
            dropFilter();
        }
        await expectHealthy(seed);
    });
});

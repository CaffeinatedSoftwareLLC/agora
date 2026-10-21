/**
 * Agent sessions against a real agora-host running the fake CLI (beta-test-plan §2.2 "Agent
 * sessions with the fake host"). Each test uses its own run-tagged channel and agent profile.
 * Refusals check the HTTP decision and that nothing changed (no run, no notice), per §0.
 */
import { execFileSync } from 'node:child_process';
import { test, expect, apis, openChannel, storageStateFor, loadSeed } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { startFakeHost, waitFor, type FakeHost } from '../lib/fake-host';
import { agentChannel, agentChip, compose, expectNotice, messages, sessionOf, sheet, startSession, trimId, waitIdle, waitMessage, waitRuns } from '../lib/agents';

const VERIFY_LISTED = 'git rev-parse --verify refs/heads/e2e-missing-ref';
let fh: FakeHost;

test.describe('agent sessions with the fake host', () => {
    test.describe.configure({ timeout: 120_000 });
    test.beforeAll(async () => {
        fh = await startFakeHost(loadSeed(), {
            label: 'fk-sessions',
            profiles: [{ key: 'start' }, { key: 'work' }, { key: 'budget' }, { key: 'rl' }, { key: 'lurk' }, { key: 'verify', verifyCommands: [VERIFY_LISTED] }, { key: 'term' }],
        });
    });
    test.afterAll(async () => { await fh?.stop(); });

    test('[AG-01.host-seen] Settings → Agents shows the running fake host as recently seen', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const read = async () => ((await owner.ok('GET', `/servers/${seed.serverId}/agent-hosts`)) as any[]).find(h => trimId(h.id) === fh.hostId);
        const first = await read();
        expect(first.lastSeenAt, 'host reported in').toBeTruthy();
        expect(Date.now() - Date.parse(first.lastSeenAt)).toBeLessThan(60_000);
        // The host long-polls for runs (25 s): last seen moves forward while it runs
        const later = await waitFor('last seen to advance', async () => { const h = await read(); return Date.parse(h.lastSeenAt) > Date.parse(first.lastSeenAt) ? h : null; }, 40_000, 1000);
        expect(Date.parse(later.lastSeenAt)).toBeGreaterThan(Date.parse(first.lastSeenAt));

        await page.goto('/settings/agents');
        await expect(page.getByRole('heading', { name: 'Agents', level: 2 })).toBeVisible({ timeout: 15_000 });
        const row = page.getByRole('listitem').filter({ hasText: fh.hostName }).filter({ has: page.getByRole('button', { name: 'Revoke' }) });
        await expect(row).toContainText('last seen');
        await expect(row).not.toContainText('never connected');
        await row.scrollIntoViewIfNeeded();
        await snap(page, ti, 'AG-01.host-seen', '01-host-seen', `An agents settings page with one host "${fh.hostName}" marked as recently seen`, { ready: row });
        // Its agents are listed with the API-key badge the host reported
        await expect(page.getByTestId(`auth-${fh.agents.start.name}`)).toBeVisible();
    });

    test('[AG-01.start] /start posts the notice and the agent says hello; /start again asks Shelve / Keep / Cancel', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.start;
        const ch = await agentChannel(seed, fh, 'fk-start', ['start']);
        await openChannel(page, ch.id, ch.name);
        await compose(page, ch.name, `/start ${a.name}`);
        await expect(page.getByText(/^Session started: /)).toBeVisible();
        const live = await sessionOf(owner, ch.id, a.name);
        const sid = trimId(live.id);
        expect(live.state).toBe('live');
        const notice = `owner-e2e started a ${a.name} session (${sid}).`;
        await expectNotice(page, notice);
        const hello = page.locator('[data-index]').getByText('[fake] hello from the fake CLI');
        await expect(hello).toBeVisible({ timeout: 45_000 });
        await waitIdle(owner, ch.id, a.name, sid);
        expect(fh.traces('start'), 'exactly one run for the /start wake').toHaveLength(1);
        const before = await messages(owner, ch.id);

        await compose(page, ch.name, `/start ${a.name}`, { refused: true });
        const conflict = page.getByText('That agent already has a live session here.');
        await expect(conflict).toBeVisible();
        for (const name of ['Shelve it and start new', 'Keep it', 'Cancel']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
        await snap(page, ti, 'AG-01.start', '02-already-live', 'A prompt above the message box asking whether to shelve the running session, with Shelve it and start new, Keep it and Cancel buttons', { ready: conflict });
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(conflict).toHaveCount(0);

        // Nothing changed: same single live session, no new notice, no new run
        const all = (await owner.ok('POST', `/channels/${ch.id}/agent-commands`, { command: 'sessions' }) as any).sessions.filter((s: any) => s.profile === a.name);
        expect(all.map((s: any) => [trimId(s.id), s.state])).toEqual([[sid, 'live']]);
        expect((await messages(owner, ch.id))[0].id).toBe(before[0].id);
        // The API refuses the same start with 409 session_live (what the dialog is built on)
        const again = await owner.req('POST', `/channels/${ch.id}/agent-commands`, { command: 'start', profile: a.name });
        expect(again.status).toBe(409);
        expect(again.data.error).toBe('session_live');
        expect(fh.traces('start')).toHaveLength(1);
    });

    test('[AG-01.sessions] /sessions lists the session with branch @ sha matching the host worktree', async ({ page, seed }) => {
        const { owner } = apis(seed);
        const a = fh.agents.start;
        const ch = await agentChannel(seed, fh, 'fk-list', ['start']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'start', fh.traces('start').length + 1);
        const s = await waitIdle(owner, ch.id, a.name, sid);
        const branch = `agora/${a.name}/${sid}`;
        expect(s.branch).toBe(branch);
        const head = execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: fh.workdir, encoding: 'utf8' }).trim();
        expect(s.headSha, 'server head = the host worktree branch head').toBe(head);

        await openChannel(page, ch.id, ch.name);
        await compose(page, ch.name, '/sessions');
        const line = page.getByText(`${a.name} · live · 1 wakes · ${Number(s.tokensUsed).toLocaleString('en-US')} tokens · API key · ${branch} @ ${head.slice(0, 12)}`);
        await expect(line).toBeVisible();
        await expect(page.getByText(sid, { exact: true })).toBeVisible();
    });

    test('[AG-01.working] working indicator with a timer during a 20 s run, then the changed files', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.work;
        const ch = await agentChannel(seed, fh, 'fk-work', ['work']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'work', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        await openChannel(page, ch.id, ch.name);
        await compose(page, ch.name, `@${a.name} please edit #fake-sleep=20 #fake-edit=src/app.txt,src/new-file.txt`);
        const activity = page.getByLabel('Agent run activity');
        const working = activity.getByRole('status').filter({ hasText: new RegExp(`^${a.name} is working\u2026 \\d+s$`) });
        await expect(working).toBeVisible({ timeout: 20_000 });
        // The timer ticks
        const t1 = Number(/(\d+)s$/.exec((await working.textContent()) ?? '')?.[1]);
        await expect.poll(async () => Number(/(\d+)s$/.exec((await working.textContent()) ?? '')?.[1]), { timeout: 8_000 }).toBeGreaterThan(t1);
        await snap(page, ti, 'AG-01.working', '01-working', 'A line above the message box saying the agent is working with a seconds timer', { ready: working });

        // Finished: "finished." plus the changed files, from the host's worktree comparison
        await expect(activity.getByRole('status').filter({ hasText: `${a.name} finished.` })).toBeVisible({ timeout: 45_000 });
        const files = activity.locator('details').filter({ hasText: '2 changed files' });
        await files.locator('summary').click();
        await expect(files.getByRole('listitem')).toHaveText(['src/app.txt', 'src/new-file.txt']);
        await snap(page, ti, 'AG-07.changed-files', '01-changed-files', 'A list of two changed files (src/app.txt, src/new-file.txt) above the message box', { ready: files });

        const s = await waitIdle(owner, ch.id, a.name, sid);
        expect([...s.run.changedPaths].sort()).toEqual(['src/app.txt', 'src/new-file.txt']);
        expect(s.recentRuns, 'two runs: hello + this one').toHaveLength(2);
        // The host committed the turn on the session branch, as the bot
        const log = execFileSync('git', ['log', '-1', '--format=%an|%ae', `refs/heads/agora/${a.name}/${sid}`], { cwd: fh.workdir, encoding: 'utf8' }).trim();
        expect(log).toBe(`${a.name}|${a.botId}@agora.invalid`);
        expect(s.headSha).toBe(execFileSync('git', ['rev-parse', `refs/heads/agora/${a.name}/${sid}`], { cwd: fh.workdir, encoding: 'utf8' }).trim());
        // The sheet lists it under Recent runs
        await agentChip(page, a.name).click();
        const sh = sheet(page, a.name);
        await sh.getByText('Recent runs').click();
        await expect(sh.getByText('2 changed files').first()).toBeVisible();
    });

    test('[AG-01.budget] a 1,000-token budget shelves the session after a 2,000-token run; /resume is refused until raised', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.budget;
        const ch = await agentChannel(seed, fh, 'fk-budget', ['budget']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'budget', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        await openChannel(page, ch.id, ch.name);
        await agentChip(page, a.name).click();
        const sh = sheet(page, a.name);
        await sh.getByLabel('Session token budget').fill('1000');
        await sh.getByRole('button', { name: 'Save budget' }).click();
        await expect(sh.getByText('Budget saved. Resume the session when ready.')).toBeVisible();
        await sh.getByRole('button', { name: 'Close' }).click();
        expect((await sessionOf(owner, ch.id, a.name, sid)).tokenBudget).toBe(1000);

        await compose(page, ch.name, `@${a.name} expensive #fake-tokens=2000`);
        const shelved = `Session for ${a.name} shelved: its budget is used up. /resume ${sid} after raising the budget.`;
        await expectNotice(page, shelved);
        const s = await sessionOf(owner, ch.id, a.name, sid);
        expect([s.state, s.endReason]).toEqual(['shelved', 'budget']);
        expect(s.tokensUsed).toBeGreaterThanOrEqual(2000);
        await expect(page.getByLabel('Agent run activity').getByText(`${a.name} paused: session budget used up.`)).toBeVisible();

        // /resume refused: 409 budget_exhausted, still shelved, no notice, no run
        const runsBefore = fh.traces('budget').length;
        const msgsBefore = await messages(owner, ch.id);
        await compose(page, ch.name, `/resume ${sid}`, { refused: true });
        const refusal = page.getByText('This session has used its budget. The owner can raise its token budget, or start a fresh session.');
        await expect(refusal).toBeVisible();
        await snap(page, ti, 'AG-01.budget', '01-resume-refused', 'A shelved-for-budget notice in the channel and an error above the message box saying the session has used its budget', { ready: refusal });
        const api = await owner.req('POST', `/channels/${ch.id}/agent-commands`, { command: 'resume', sessionId: sid });
        expect([api.status, api.data.error]).toEqual([409, 'budget_exhausted']);
        expect((await sessionOf(owner, ch.id, a.name, sid)).state).toBe('shelved');
        expect((await messages(owner, ch.id))[0].id).toBe(msgsBefore[0].id);
        await new Promise(r => setTimeout(r, 3000));
        expect(fh.traces('budget')).toHaveLength(runsBefore);

        // Raised: resume works
        await owner.ok('POST', `/channels/${ch.id}/agent-commands`, { command: 'budget', sessionId: sid, tokenBudget: 50_000 });
        const resumed = await owner.req('POST', `/channels/${ch.id}/agent-commands`, { command: 'resume', sessionId: sid });
        expect([resumed.status, resumed.data.action]).toEqual([200, 'resumed']);
        expect((await sessionOf(owner, ch.id, a.name, sid)).state).toBe('live');
    });

    test('[AG-01.rate-limit] rate_limit_event → Sleeping; posts are held; Wake now delivers them in one turn', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.rl;
        const ch = await agentChannel(seed, fh, 'fk-rl', ['rl']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'rl', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        await openChannel(page, ch.id, ch.name);
        await compose(page, ch.name, `@${a.name} go #fake-ratelimit`);
        await expectNotice(page, new RegExp(`^${a.name} hit its rate limit and is sleeping for about .+ \\(until \\d\\d:\\d\\d UTC\\)\\. Messages for it are held and delivered together when it wakes\\.$`));
        const s1 = await sessionOf(owner, ch.id, a.name, sid);
        expect(s1.sleepingUntil, 'sleeping until the reset').toBeTruthy();
        expect(Date.parse(s1.sleepingUntil) - Date.now()).toBeGreaterThan(2 * 3600_000);
        const chip = agentChip(page, a.name);
        await expect(chip).toHaveAccessibleName(/sleeping \(rate limited\)/);
        // The plan expects the reset time on the chip itself (§1.7 "Chip shows Sleeping with the reset time")
        await expect.soft(chip, 'chip shows the reset time').toContainText(/\d{1,2}:\d\d/);
        await snap(page, ti, 'AG-01.rate-limit', '01-sleeping', 'An agent chip showing Sleeping with a reset time', { ready: chip });

        // Two posts while asleep: held (no run)
        const runsBefore = fh.traces('rl').length;
        await compose(page, ch.name, `@${a.name} first held message #fake-say=heldone`);
        await compose(page, ch.name, `@${a.name} second held message`);
        await new Promise(r => setTimeout(r, 5000));
        expect(fh.traces('rl'), 'no run while sleeping').toHaveLength(runsBefore);

        await chip.click();
        const sh = sheet(page, a.name);
        await expect(sh.getByText(/^Hit its rate limit\. Sleeping until .+; messages for it are held and delivered together when it wakes\.$/)).toBeVisible();
        await snap(page, ti, 'AG-01.rate-limit', '02-sheet', 'A session sheet saying the agent is sleeping until a time, with a Wake now button', { ready: sh.getByRole('button', { name: 'Wake now' }) });
        await sh.getByRole('button', { name: 'Wake now' }).click();
        await expect(sh.getByText('Woken. Held messages go out on its next run.')).toBeVisible();
        await sh.getByRole('button', { name: 'Close' }).click();
        await expectNotice(page, `owner-e2e woke session ${sid} early.`);
        const traces = await waitRuns(fh, 'rl', runsBefore + 1);
        const wake = traces[runsBefore];
        expect(wake.wokeFromSleep).toBe(true);
        expect(wake.batchCount, 'the rate-limited message and both held ones in one batch').toBe(3);
        await waitIdle(owner, ch.id, a.name, sid);
        await new Promise(r => setTimeout(r, 3000));
        expect(fh.traces('rl'), 'exactly one turn after waking').toHaveLength(runsBefore + 1);
        const replies = (await messages(owner, ch.id)).filter(m => trimId(m.authorId) === a.botId && /heldone/.test(m.content));
        expect(replies).toHaveLength(1);
    });

    test('[AG-01.lurk] /lurk quiet: a member post wakes it; [pass] posts nothing and no warning', async ({ page, browser, seed }) => {
        const { owner, member } = apis(seed);
        const a = fh.agents.lurk;
        const ch = await agentChannel(seed, fh, 'fk-lurk', ['lurk']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'lurk', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        await openChannel(page, ch.id, ch.name);
        await compose(page, ch.name, `/lurk ${a.name} quiet`);
        await expectNotice(page, `owner-e2e set ${a.name}'s lurk mode to quiet.`);
        expect((await sessionOf(owner, ch.id, a.name, sid)).lurkMode).toBe('quiet');

        const mctx = await browser.newContext({ storageState: storageStateFor('member') });
        const mp = await mctx.newPage();
        await openChannel(mp, ch.id, ch.name);
        const text = `A passing remark from the member ${Date.now()}`;
        await compose(mp, ch.name, text);
        await mctx.close();
        const traces = await waitRuns(fh, 'lurk', 2);
        expect(traces[1].lurk, 'a lurk run (no JSON schema)').toBe(true);
        expect(traces[1].outcome).toBe('pass');
        const s = await waitIdle(owner, ch.id, a.name, sid);
        expect(s.run.status).toBe('succeeded');
        await new Promise(r => setTimeout(r, 3000));
        const after = await messages(owner, ch.id);
        const sinceMember = after.slice(0, after.findIndex(m => m.content === text));
        expect(sinceMember, 'nothing posted after the member message (no reply, no warning)').toEqual([]);
        expect(after.some(m => /finished without posting/.test(m.content ?? ''))).toBe(false);
        await expect(page.getByLabel('Agent run activity').getByText(/finished without posting/)).toHaveCount(0);

        await compose(page, ch.name, `/lurk ${a.name} off`);
        await expectNotice(page, `owner-e2e set ${a.name}'s lurk mode to off.`);
        expect((await sessionOf(owner, ch.id, a.name, sid)).lurkMode).toBeNull();
    });

    test('[AG-08.verify] verify not in the host list → "did not run"; listed and failing → failed notice after one fix turn', async ({ page, seed }) => {
        const { owner } = apis(seed);
        const a = fh.agents.verify;
        const ch = await agentChannel(seed, fh, 'fk-verify', ['verify']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'verify', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        await openChannel(page, ch.id, ch.name);
        await page.getByRole('button', { name: 'Project context for agents' }).click();
        const pane = page.locator('aside[aria-label="project"]');
        await pane.getByLabel('Verify command').fill('npm run verify');
        await pane.getByLabel('Fix turns after a failure').selectOption('1');
        await pane.getByRole('button', { name: 'Save verify' }).click();
        await expect(pane.getByText('Verify command saved.')).toBeVisible();

        await compose(page, ch.name, `@${a.name} change it #fake-edit=src/v1.txt`);
        const skipped = `${a.name}: verify \`npm run verify\` did not run: it is not in this host's verify.commands list (agora-host config).`;
        await expectNotice(page, skipped);
        let t = fh.traces('verify');
        expect(t.filter(x => x.verifyTurn), 'no fix turn for a command that did not run').toHaveLength(0);

        await pane.getByLabel('Verify command').fill(VERIFY_LISTED);
        await pane.getByRole('button', { name: 'Save verify' }).click();
        await expect(pane.getByText('Verify command saved.')).toBeVisible();
        expect(((await owner.ok('GET', `/channels/${ch.id}/project`)) as any).verify).toEqual({ command: VERIFY_LISTED, maxRetries: 1 });
        const before = t.length;
        await compose(page, ch.name, `@${a.name} change it again #fake-edit=src/v2.txt`);
        await expectNotice(page, new RegExp(`^${a.name}: verify \`${VERIFY_LISTED.replace(/[.]/g, '\\.')}\` failed \\(exit 128\\) after 1 fix turn\\. Last output:`), 60_000);
        t = fh.traces('verify');
        expect(t.slice(before).map(x => x.verifyTurn), 'one normal turn plus exactly one fix turn').toEqual([false, true]);
        const s = await waitIdle(owner, ch.id, a.name, sid);
        expect(s.run.status).toBe('succeeded');
    });

    test('[AG-09.terminal] a terminal connection puts the hosted session on standby; mentions do not wake it; /start asks about the terminal', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.term;
        const ch = await agentChannel(seed, fh, 'fk-term', ['term']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'term', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        const term = await fh.terminal('term');
        try {
            await openChannel(page, ch.id, ch.name);
            await expectNotice(page, `${a.name} is connected from a terminal, so it answers from there. Its hosted session (${sid}) is on standby: messages do not wake it while the terminal is connected. Close the terminal (or end the hosted session) to switch.`);
            const chip = page.getByTestId('own-session-chip').filter({ hasText: a.name });
            await expect(chip).toContainText(/terminal · (listening|connected|working)/);
            await snap(page, ti, 'AG-09.terminal', '01-terminal-chip', `An agent chip for ${a.name} marked terminal, next to the hosted agent chip`, { ready: chip });
            const terminalSession = (await waitFor('terminal session', async () => (await owner.ok('POST', `/channels/${ch.id}/agent-commands`, { command: 'sessions' }) as any)
                .sessions.find((x: any) => x.kind === 'terminal' && trimId(x.botId) === a.botId && x.state === 'live')));
            expect(terminalSession).toBeTruthy();

            const runs = fh.traces('term').length;
            await compose(page, ch.name, `@${a.name} are you there?`);
            await new Promise(r => setTimeout(r, 6000));
            expect(fh.traces('term'), 'the hosted session did not wake').toHaveLength(runs);
            expect((await sessionOf(owner, ch.id, a.name, sid)).running).toBeFalsy();

            await compose(page, ch.name, `/start ${a.name}`, { refused: true });
            const q = page.getByText('That agent is already connected from a terminal, which answers here. A hosted session would wait on standby until the terminal disconnects.');
            await expect(q).toBeVisible();
            for (const name of ['Keep the terminal', 'Start hosted on standby', 'Cancel']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
            await snap(page, ti, 'AG-09.terminal', '02-start-dialog', 'A prompt above the message box saying the agent is connected from a terminal, with Keep the terminal and Start hosted on standby buttons', { ready: q });
            const api = await owner.req('POST', `/channels/${ch.id}/agent-commands`, { command: 'start', profile: a.name });
            expect([api.status, api.data.error]).toEqual([409, 'terminal_connected']);
            await page.getByRole('button', { name: 'Cancel', exact: true }).click();
            expect(fh.traces('term')).toHaveLength(runs);
        } finally { await term.stop(); }
    });
});

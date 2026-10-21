/**
 * Session workspaces with the fake host (beta-test-plan §2.2): checkpoints (restore / fork,
 * owner only), review actions (discard / commit / merge refused / PR without a gh login), the
 * project panel's pinned file reaching the wake, and the task board flow. The host's worktrees
 * are real git worktrees in a throwaway repo, so git state is asserted directly.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, apis, openChannel, storageStateFor, loadSeed } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { startFakeHost, waitFor, type FakeHost } from '../lib/fake-host';
import { agentChannel, agentChip, compose, ensureDirector, expectNotice, loginContext, replies, sessionOf, sessions, sheet, startSession, trimId, uploadFile, waitIdle, waitReply, waitRuns, type Director } from '../lib/agents';

let fh: FakeHost;
let dir: Director;
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const worktree = (key: string, sid: string) => path.join(fh.agents[key].stateDir, `wt-${sid.slice(-10)}`);

test.describe('session workspaces with the fake host', () => {
    test.describe.configure({ timeout: 150_000 });
    test.beforeAll(async () => {
        const seed = loadSeed();
        dir = await ensureDirector(seed);
        fh = await startFakeHost(seed, { label: 'fk-ws', profiles: [{ key: 'ck' }, { key: 'rev' }, { key: 'proj' }, { key: 'task' }] });
    });
    test.afterAll(async () => { await fh?.stop(); });

    test('[AG-07.checkpoints] checkpoint notices; owner Restore puts files back, Fork makes a shelved session; a director sees no Restore', async ({ page, browser, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.ck;
        const ch = await agentChannel(seed, fh, 'fk-ck', ['ck']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'ck', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        await openChannel(page, ch.id, ch.name);
        await compose(page, ch.name, `@${a.name} first #fake-edit=src/ck1.txt`);
        await expectNotice(page, new RegExp(`^Checkpoint 1 saved for session ${sid}, run [0-9A-Z]{26}, message [0-9A-Z]{26}\\.$`));
        await waitIdle(owner, ch.id, a.name, sid);
        await compose(page, ch.name, `@${a.name} second #fake-edit=src/ck2.txt`);
        await expectNotice(page, new RegExp(`^Checkpoint 2 saved for session ${sid}, run `));
        await waitIdle(owner, ch.id, a.name, sid);
        const list = (await owner.ok('GET', `/channels/${ch.id}/sessions/${sid}/checkpoints`)) as any;
        const byN = (n: number) => list.checkpoints.find((c: any) => c.ref.endsWith(`/${n}`));
        const [cp1, cp2] = [byN(1), byN(2)];
        expect(git(fh.workdir, ['rev-parse', cp1.ref])).toBe(cp1.sha);
        const wt = worktree('ck', sid);
        expect(fs.existsSync(path.join(wt, 'src/ck2.txt'))).toBe(true);
        // Uncommitted work in the worktree (as if someone edited it after the run)
        fs.writeFileSync(path.join(wt, 'src/dirty.txt'), 'uncommitted\n');

        // Director: sees the checkpoints, no Restore/Fork; the API refuses and queues nothing
        const dctx = await loginContext(browser, dir.username, dir.password);
        const dp = await dctx.newPage();
        await openChannel(dp, ch.id, ch.name);
        await agentChip(dp, a.name).click();
        const dsh = sheet(dp, a.name);
        await dsh.getByRole('button', { name: 'Review changes & checkpoints' }).click();
        await expect(dsh.getByRole('heading', { name: 'Checkpoints' })).toBeVisible();
        await expect(dsh.getByText(cp1.sha.slice(0, 12))).toBeVisible();
        await expect(dsh.getByRole('button', { name: 'Restore to here' })).toHaveCount(0);
        await expect(dsh.getByRole('button', { name: 'Fork from here' })).toHaveCount(0);
        await dctx.close();
        const latest = async () => ((await owner.ok('GET', `/channels/${ch.id}/sessions/${sid}/workspace-commands/latest`)) as any).command?.id ?? null;
        const before = await latest();
        const dr = await dir.api.req('POST', `/channels/${ch.id}/sessions/${sid}/workspace-commands`, { action: 'restore', checkpointId: cp1.id });
        expect([dr.status, dr.data.error]).toEqual([403, 'owner_only']);
        expect(await latest()).toBe(before);
        expect(git(wt, ['rev-parse', 'HEAD'])).not.toBe(cp1.sha);

        // Owner: Restore checkpoint 1
        await agentChip(page, a.name).click();
        const sh = sheet(page, a.name);
        await sh.getByRole('button', { name: 'Review changes & checkpoints' }).click();
        const item1 = sh.getByRole('listitem').filter({ hasText: cp1.sha.slice(0, 12) });
        await expect(item1.getByRole('button', { name: 'Restore to here' })).toBeVisible();
        await snap(page, ti, 'AG-07.checkpoints', '01-list', 'A session sheet listing two checkpoints, each with Restore to here and Fork from here buttons', { ready: item1 });
        await item1.getByRole('button', { name: 'Restore to here' }).click();
        const confirm = sh.getByRole('group', { name: 'Confirm workspace action' });
        await expect(confirm).toContainText('Replace tracked and untracked session files with this checkpoint?');
        await confirm.getByRole('button', { name: 'Confirm restore' }).click();
        await expect(sh.getByRole('status').filter({ hasText: 'Restored checkpoint 1' })).toBeVisible({ timeout: 30_000 });
        expect(git(wt, ['rev-parse', 'HEAD'])).toBe(cp1.sha);
        expect(fs.existsSync(path.join(wt, 'src/ck1.txt'))).toBe(true);
        expect(fs.existsSync(path.join(wt, 'src/ck2.txt')), 'files after checkpoint 1 are gone').toBe(false);
        expect(fs.existsSync(path.join(wt, 'src/dirty.txt')), 'restore cleans untracked files').toBe(false);
        // The dirty state before the restore was saved first as a recovery checkpoint
        const refs = git(fh.workdir, ['for-each-ref', '--format=%(refname)', `refs/agora/checkpoints/${sid}/`]).split('\n');
        expect(refs).toHaveLength(3);
        expect(git(fh.workdir, ['show', `${refs[2]}:src/dirty.txt`])).toBe('uncommitted');
        expect(git(fh.workdir, ['show', `${refs[2]}:src/ck2.txt`])).toContain('edited by fake-claude');
        expect((await sessionOf(owner, ch.id, a.name, sid)).headSha).toBe(cp1.sha);

        // Fork checkpoint 2 into a new shelved session
        const sessionsBefore = (await sessions(owner, ch.id)).map(s => trimId(s.id));
        const item2 = sh.getByRole('listitem').filter({ hasText: cp2.sha.slice(0, 12) });
        await item2.getByRole('button', { name: 'Fork from here' }).click();
        await expect(sh.getByRole('status').filter({ hasText: 'Forked checkpoint into a new shelved session' })).toBeVisible({ timeout: 30_000 });
        const fork = (await sessions(owner, ch.id)).find(s => !sessionsBefore.includes(trimId(s.id)));
        expect(fork, 'one new session').toBeTruthy();
        expect([fork.state, fork.profile, fork.branch, fork.headSha]).toEqual(['shelved', a.name, `agora/${a.name}/${trimId(fork.id)}`, cp2.sha]);
        expect(git(fh.workdir, ['rev-parse', `refs/heads/agora/${a.name}/${trimId(fork.id)}`])).toBe(cp2.sha);
        await expect(sh.getByRole('button', { name: `Resume session ${trimId(fork.id)}` })).toBeVisible();
        // The live session is untouched by the fork
        expect((await sessionOf(owner, ch.id, a.name, sid)).state).toBe('live');
    });

    test('[AG-07.review-actions] discard one file, commit with a message, merge refused (base checked out), PR without a gh login → clean error', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.rev;
        const ch = await agentChannel(seed, fh, 'fk-rev', ['rev']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'rev', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        await openChannel(page, ch.id, ch.name);
        await compose(page, ch.name, `@${a.name} edit two files #fake-edit=src/app.txt,src/other.txt`);
        await waitRuns(fh, 'rev', 2);
        await waitIdle(owner, ch.id, a.name, sid);
        const wt = worktree('rev', sid);
        const mainBefore = git(fh.workdir, ['rev-parse', 'refs/heads/main']);

        await agentChip(page, a.name).click();
        const sh = sheet(page, a.name);
        await sh.getByRole('button', { name: 'Review changes & checkpoints' }).click();
        await sh.getByRole('button', { name: 'Refresh changed files' }).click();
        await expect(sh.getByRole('button', { name: 'src/app.txt', exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(sh.getByRole('button', { name: 'src/other.txt', exact: true })).toBeVisible();
        await sh.getByRole('button', { name: 'src/app.txt', exact: true }).click();
        await expect(sh.getByLabel('Unified diff')).toContainText('+edited by fake-claude', { timeout: 30_000 });

        // Discard src/app.txt: back to the base version, uncommitted
        await sh.getByRole('button', { name: 'Discard src/app.txt' }).click();
        await sh.getByRole('button', { name: 'Confirm discard' }).click();
        await expect(sh.getByRole('status').filter({ hasText: 'Discarded src/app.txt' })).toBeVisible({ timeout: 30_000 });
        expect(fs.readFileSync(path.join(wt, 'src/app.txt'), 'utf8')).toBe('original line\n');
        expect(git(wt, ['status', '--porcelain'])).toContain('src/app.txt');

        // Commit with a message
        const msg = `E2E review commit ${fh.tag}`;
        await sh.getByLabel('Commit message').fill(msg);
        await sh.getByRole('button', { name: 'Commit all' }).click();
        await expect(sh.getByRole('status').filter({ hasText: 'Committed session changes' })).toBeVisible({ timeout: 30_000 });
        expect(git(wt, ['log', '-1', '--format=%s'])).toBe(msg);
        expect(git(wt, ['status', '--porcelain'])).toBe('');

        // Squash merge: refused because main is checked out in the workdir; main unchanged
        await sh.getByRole('button', { name: 'Squash merge' }).click();
        await sh.getByRole('button', { name: 'Confirm merge' }).click();
        const refused = sh.getByText('The base branch is checked out. Open a PR, or switch that checkout to another branch before merging.');
        await expect(refused).toBeVisible({ timeout: 30_000 });
        await snap(page, ti, 'AG-07.review-actions', '01-merge-refused', 'A session review panel with an error saying the base branch is checked out', { ready: refused });
        expect(git(fh.workdir, ['rev-parse', 'refs/heads/main'])).toBe(mainBefore);
        const cmd = ((await owner.ok('GET', `/channels/${ch.id}/sessions/${sid}/workspace-commands/latest`)) as any).command;
        expect([cmd.action, cmd.status, cmd.result?.error]).toEqual(['merge', 'failed', 'base_branch_checked_out_use_pr']);

        // PR with no gh login on the host: a fixed error code, no raw gh/git output
        await sh.getByRole('button', { name: 'Open GitHub PR' }).click();
        const pr = await waitFor('pr command result', async () => {
            const c = ((await owner.ok('GET', `/channels/${ch.id}/sessions/${sid}/workspace-commands/latest`)) as any).command;
            return c.action === 'pr' && (c.status === 'failed' || c.status === 'succeeded') ? c : null;
        }, 60_000);
        expect(pr.status).toBe('failed');
        expect(pr.result.error).toMatch(/^[a-z][a-z_]{0,100}$/);
        await expect(sh.getByText(pr.result.error, { exact: true })).toBeVisible();
        await expect(sh.getByRole('link', { name: 'View pull request' })).toHaveCount(0);
        await sh.getByRole('button', { name: 'Close' }).click();
        await expectNotice(page, `Workspace pr failed for session ${sid}: ${pr.result.error}`);
        expect(fh.log()).not.toMatch(/gh auth login|github\.com/i);
    });

    test('[UI-06.project-pin-file] owner pins instructions and a file; member reads only; the next wake carries both', async ({ page, browser, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.proj;
        const ch = await agentChannel(seed, fh, 'fk-proj', ['proj']);
        const name = `notes-${fh.tag}.md`;
        const fileId = await uploadFile(owner, ch.id, name, '# Notes\nUse the fixtures only.\n');
        await openChannel(page, ch.id, ch.name);
        await page.getByRole('button', { name: 'Project context for agents' }).click();
        const pane = page.locator('aside[aria-label="project"]');
        await pane.getByLabel('Project instructions').fill(`Keep changes small. Run ${fh.tag}.`);
        await pane.getByRole('button', { name: 'Save instructions' }).click();
        await expect(pane.getByText('Instructions saved. Agents get them on their next wake.')).toBeVisible();
        await pane.getByLabel('File to pin').selectOption({ label: name });
        await pane.getByRole('button', { name: 'Pin', exact: true }).click();
        await expect(pane.getByText(`Pinned ${name}.`)).toBeVisible();
        await expect(pane.getByRole('heading', { name: 'Pinned files (1/10)' })).toBeVisible();
        await snap(page, ti, 'UI-06.project-pin-file', '01-owner', 'A project panel with pinned instructions and one file', { ready: pane.getByRole('button', { name: `Unpin ${name}` }) });
        const proj = (await owner.ok('GET', `/channels/${ch.id}/project`)) as any;
        expect(proj.files.map((f: any) => trimId(f.id))).toEqual([fileId]);

        const mctx = await browser.newContext({ storageState: storageStateFor('member') });
        const mp = await mctx.newPage();
        await openChannel(mp, ch.id, ch.name);
        await mp.getByRole('button', { name: 'Project context for agents' }).click();
        const mpane = mp.locator('aside[aria-label="project"]');
        await expect(mpane.getByText(name)).toBeVisible();
        await expect(mpane.getByText(`Keep changes small. Run ${fh.tag}.`)).toBeVisible();
        await expect(mpane.getByRole('button', { name: `Unpin ${name}` })).toHaveCount(0);
        await expect(mpane.getByLabel('File to pin')).toHaveCount(0);
        await expect(mpane.getByLabel('Project instructions')).toHaveCount(0);
        await mctx.close();

        // Included in the wake
        const sid = await startSession(owner, ch.id, a.name);
        const t = await waitRuns(fh, 'proj', 1);
        expect([t[0].hasInstructions, t[0].hasPinned]).toEqual([true, true]);
        await waitIdle(owner, ch.id, a.name, sid);
    });

    test('[UI-06.task-flow] create a card, assign the agent, start it → task thread; move to Review and Done', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.task;
        const ch = await agentChannel(seed, fh, 'fk-task', ['task']);
        await openChannel(page, ch.id, ch.name);
        await page.getByRole('button', { name: 'Task board' }).click();
        const pane = page.locator('aside[aria-label="tasks"]');
        const title = `Fake task ${fh.tag}`;
        await pane.getByRole('button', { name: 'New card' }).click();
        await pane.getByLabel('Card title').fill(title);
        await pane.getByLabel('Card description').fill('Edit src/task.txt. #fake-edit=src/task.txt');
        await pane.getByLabel('Assignee agent').selectOption(a.name);
        await pane.getByRole('button', { name: 'Add card' }).click();
        const cardBtn = pane.getByRole('button', { name: new RegExp(title) });
        await expect(cardBtn).toBeVisible();
        if ((await cardBtn.getAttribute('aria-expanded')) !== 'true') await cardBtn.click();
        await pane.getByRole('button', { name: 'Start', exact: true }).click();
        // ("Agent started." flashes and is replaced as soon as the card updates from the socket)
        await expect(pane.getByText(new RegExp(`${a.name} · Agent (working|idle)`))).toBeVisible();

        const task = (await waitFor('card with a thread', async () => {
            const r = (await owner.ok('GET', `/channels/${ch.id}/tasks`)) as any;
            const list: any[] = Array.isArray(r) ? r : (r.cards ?? r.tasks ?? []);
            const c = list.find(x => x.title === title);
            return c?.threadId && c?.session ? c : null;
        }));
        expect(task.status).toBe('in_progress');
        const tid = trimId(task.threadId);
        const t = await waitRuns(fh, 'task', 1);
        expect(t[0].directives.edit, 'the kickoff carries the card description').toBe('src/task.txt');
        const reply = await waitReply(owner, ch.id, tid, m => trimId(m.authorId) === a.botId, 'agent reply in the task thread');
        expect(reply.content).toContain('[fake] hello from the fake CLI');
        await waitIdle(owner, ch.id, a.name, trimId(task.session.id)).catch(() => undefined);
        const after = await waitFor('card session idle with a branch', async () => {
            const r = (await owner.ok('GET', `/channels/${ch.id}/tasks`)) as any;
            const c = (Array.isArray(r) ? r : (r.cards ?? r.tasks ?? [])).find((x: any) => x.title === title);
            return c?.session?.branch && !c.session.running ? c : null;
        });
        await expect(pane.getByText(`${after.session.branch} @ ${after.session.headSha.slice(0, 12)}`)).toBeVisible();
        expect(git(fh.workdir, ['show', `${after.session.branch}:src/task.txt`])).toContain('edited by fake-claude');

        await pane.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Review' });
        await expect(pane.locator('section[aria-label="Review"]').getByRole('button', { name: new RegExp(title) })).toBeVisible();
        await snap(page, ti, 'UI-06.task-flow', '01-review', 'A task board with one card in the Review column showing its agent and branch', { ready: pane.locator('section[aria-label="Review"]') });
        const moved = pane.locator('section[aria-label="Review"]').getByRole('button', { name: new RegExp(title) });
        if ((await moved.getAttribute('aria-expanded')) !== 'true') await moved.click();
        await pane.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Done' });
        const r = (await owner.ok('GET', `/channels/${ch.id}/tasks`)) as any;
        await expect.poll(async () => {
            const rr = (await owner.ok('GET', `/channels/${ch.id}/tasks`)) as any;
            return (Array.isArray(rr) ? rr : (rr.cards ?? rr.tasks ?? [])).find((x: any) => x.title === title)?.status;
        }).toBe('done');
        void r;

        // Check PR asks the host for the branch's PR state; it must come back (passed or failed) in time
        await pane.getByRole('button', { name: 'Show' }).click().catch(() => undefined);
        const done = pane.locator('section[aria-label="Done"]').getByRole('button', { name: new RegExp(title) });
        if ((await done.getAttribute('aria-expanded')) !== 'true') await done.click();
        await pane.getByRole('button', { name: 'Check PR' }).click();
        const sid = trimId(after.session.id);
        const cmd = await waitFor('pr_status command to finish', async () => {
            const c = ((await owner.ok('GET', `/channels/${ch.id}/sessions/${sid}/workspace-commands/latest`)) as any).command;
            return c?.action === 'pr_status' && ['succeeded', 'failed'].includes(c.status) ? c : null;
        }, 30_000).catch(async e => {
            const c = ((await owner.ok('GET', `/channels/${ch.id}/sessions/${sid}/workspace-commands/latest`)) as any).command;
            throw new Error(`${e.message}; last state: ${JSON.stringify({ action: c?.action, status: c?.status, result: c?.result })}`);
        });
        // No gh login on the fake host: a known code, shown as text on the card
        expect(['no_pull_request', 'pr_status_failed']).toContain(cmd.result?.error);
    });
});

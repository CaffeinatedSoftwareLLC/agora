/**
 * Diff review on a phone (pixel-7 project; the file name matches its testMatch): a fake run
 * edits 35 files, the session sheet's review lists them 30 at a time, and a patch opens.
 */
import { test, expect, apis, openChannel, loadSeed } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { startFakeHost, type FakeHost } from '../lib/fake-host';
import { agentChannel, agentChip, compose, sheet, startSession, waitIdle, waitRuns } from '../lib/agents';

let fh: FakeHost;

test.describe('diff review on the phone', () => {
    test.describe.configure({ timeout: 120_000 });
    test.beforeAll(async () => { fh = await startFakeHost(loadSeed(), { label: 'fk-mob', profiles: [{ key: 'mob' }] }); });
    test.afterAll(async () => { await fh?.stop(); });

    test('[AG-07.diff-review] Review changes pages 35 files 30 at a time and opens a patch', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.mob;
        const ch = await agentChannel(seed, fh, 'fk-mob', ['mob']);
        const sid = await startSession(owner, ch.id, a.name);
        await waitRuns(fh, 'mob', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        await openChannel(page, ch.id, ch.name);
        await compose(page, ch.name, `@${a.name} many files #fake-edits=35`);
        await waitRuns(fh, 'mob', 2);
        const s = await waitIdle(owner, ch.id, a.name, sid);
        expect(s.run.changedPaths).toHaveLength(35);

        await agentChip(page, a.name).click();
        const sh = sheet(page, a.name);
        await sh.getByRole('button', { name: 'Review changes & checkpoints' }).click();
        await sh.getByRole('button', { name: 'Refresh changed files' }).click();
        const fileButtons = sh.getByRole('button', { name: /^edits\/f\d{3}\.txt$/ });
        await expect(fileButtons).toHaveCount(30, { timeout: 30_000 });
        await sh.getByRole('button', { name: 'More files' }).click();
        await expect(fileButtons).toHaveCount(35, { timeout: 30_000 });
        await expect(sh.getByRole('button', { name: 'More files' })).toHaveCount(0);
        await sh.getByRole('button', { name: 'edits/f035.txt', exact: true }).click();
        const diff = sh.getByLabel('Unified diff');
        await expect(diff).toContainText('+edited by fake-claude', { timeout: 30_000 });
        await diff.scrollIntoViewIfNeeded();
        // Phone layout: no sideways scroll on the page while the sheet is open
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        await snap(page, ti, 'AG-07.diff-review', '01-patch', 'A list of changed files with a patch view on a phone screen', { ready: diff });
    });
});

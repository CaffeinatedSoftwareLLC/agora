import { test, expect, openChannel } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { checkAgentMessageRuns } from '../lib/agent-message-runs';

test.describe('system notices and long history @smoke', () => {
    test('[UI-02.agent-runs] agent messages collapse, expand with badges, and preserve cards', async ({ page, seed }, ti) => {
        await checkAgentMessageRuns(page, seed, ti);
    });
    test('[UI-02.notice-drawer] consecutive notices collapse; expand shows them; state survives reload', async ({ page, seed }, ti) => {
        const name = `notices-${seed.runTag}`;
        await openChannel(page, seed.channels.notices, name);
        const toggle = page.getByRole('button', { name: /^\d+ notices$/ });
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        const label = (await toggle.innerText()).trim();
        const n = Number(/(\d+) notices/.exec(label)?.[1]);
        expect(n, `collapsed row "${label}" counts the seeded start/end notices`).toBeGreaterThanOrEqual(4);
        const endedText = page.getByText(new RegExp(`ended ${seed.agents.codexSub.name}'s session`)).first();
        await expect(endedText).toBeHidden();
        await snap(page, ti, 'UI-02.notice-drawer', '01-collapsed', `A collapsed row reading "${label.replace(/^\W+/, '')}" in the channel`, { ready: toggle });

        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(endedText).toBeVisible();
        await snap(page, ti, 'UI-02.notice-drawer', '02-expanded', 'Several system notices about starting and ending an agent session, listed one per line', { ready: endedText });

        await page.reload();
        const again = page.getByRole('button', { name: /^\d+ notices$/ });
        await expect(again).toHaveAttribute('aria-expanded', 'true');
        await again.click();
        await expect(again).toHaveAttribute('aria-expanded', 'false');
    });

    test('[UI-02.virtualizer] 120-message history renders a window of rows and pages back to the first message', async ({ page, seed }, ti) => {
        const name = `history-${seed.runTag}`;
        await openChannel(page, seed.channels.history, name);
        const last = page.locator('[data-index]').getByText(/^History 120:/);
        await expect(last).toBeVisible();
        const rendered = await page.locator('[data-index]').count();
        expect(rendered, 'virtualized: far fewer DOM rows than messages').toBeLessThan(60);
        await snap(page, ti, 'UI-02.virtualizer', '01-latest', 'A channel showing the latest numbered history messages ending at History 120', { ready: last });

        // Scroll to the top repeatedly until the first message is loaded and rendered.
        const first = page.locator('[data-index]').getByText(/^History 001:/);
        const scroller = page.locator('[data-index]').first().locator('xpath=ancestor::*[contains(@class,"overflow-y-auto") or contains(@style,"overflow")][1]');
        for (let i = 0; i < 25 && !(await first.isVisible()); i++) {
            await scroller.evaluate(el => { el.scrollTop = 0; });
            await page.waitForTimeout(400);
        }
        await expect(first).toBeVisible();
        await snap(page, ti, 'UI-02.virtualizer', '02-oldest', 'The top of the channel history showing History 001', { ready: first });
    });
});

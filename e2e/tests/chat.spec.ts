import { test, expect, apis, openChannel, storageStateFor } from '../lib/fixtures';
import { snap } from '../lib/snap';

test.describe('chat, mentions, threads @smoke', () => {
    test('[UI-01.send-live] owner sends; member sees it live in a second browser', async ({ page, browser, seed }, ti) => {
        const ch = seed.channels.agents, name = `agents-${seed.runTag}`;
        const memberCtx = await browser.newContext({ storageState: storageStateFor('member') });
        const memberPage = await memberCtx.newPage();
        await openChannel(memberPage, ch, name);
        await openChannel(page, ch, name);
        const text = `Live check ${Date.now()}`;
        await page.getByPlaceholder(`Message #${name}`).fill(text);
        await page.getByRole('button', { name: 'Send message' }).click();
        await expect(page.locator('[data-index]').getByText(text)).toBeVisible();
        await expect(page.getByPlaceholder(`Message #${name}`)).toHaveValue('');
        await expect(memberPage.locator('[data-index]').getByText(text)).toBeVisible({ timeout: 10_000 });
        await snap(memberPage, ti, 'UI-01.send-live', '01-member-sees-message', 'A channel showing a just-sent message from owner-e2e',
            { ready: memberPage.locator('[data-index]').getByText(text) });
        // Both users are connected now: the sidebar's online count should say so.
        await expect.soft(memberPage.getByText(/^[1-9]\d* online$/), 'server header online count reflects connected members').toBeVisible({ timeout: 5_000 });
        await memberCtx.close();
    });

    test('[UI-01.mention-enter] @-autocomplete: Enter selects the suggestion and does not send', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const ch = seed.channels.agents, name = `agents-${seed.runTag}`;
        const bot = seed.agents.claude.name;
        await openChannel(page, ch, name);
        const before = (await owner.ok('GET', `/channels/${ch}/messages?limit=5`)) as any[];
        const box = page.getByPlaceholder(`Message #${name}`);
        await box.click();
        await box.pressSequentially(`@${bot.slice(0, -1)}`);
        const option = page.getByRole('button', { name: new RegExp(`${bot}$`) });
        await expect(option).toBeVisible();
        await snap(page, ti, 'UI-01.mention-enter', '01-suggestions', `A mention suggestion list showing ${bot} above the message box`, { ready: option });
        await box.press('Enter');
        await expect(box).toHaveValue(`@${bot} `);
        const after = (await owner.ok('GET', `/channels/${ch}/messages?limit=5`)) as any[];
        expect(after[0]?.id).toBe(before[0]?.id); // nothing sent
        await box.fill('');
    });

    test('[UI-01.mention-case] @MIXED-case mention resolves to the bot (API check)', async ({ page, seed }) => {
        const ch = seed.channels.agents, name = `agents-${seed.runTag}`;
        await openChannel(page, ch, name);
        const upper = seed.agents.claude.name.toUpperCase();
        const text = `@${upper} case check ${Date.now()}`;
        await page.getByPlaceholder(`Message #${name}`).fill(text);
        await page.keyboard.press('Escape'); // close any suggestion list
        const posted = page.waitForResponse(r => r.request().method() === 'POST' && /\/channels\/[^/]+\/messages$/.test(new URL(r.url()).pathname));
        await page.getByRole('button', { name: 'Send message' }).click();
        const res = await (await posted).json();
        await expect(page.locator('[data-index]').getByText(text)).toBeVisible();
        expect(res.content).toBe(text);
        expect((res.mentions ?? []).map((x: string) => x.trim()), 'server resolved the upper-case mention to the bot').toContain(seed.agents.claude.botId);
    });

    test('[UI-01.thread-wake] thread reply mentioning an agent with no session posts the wake notice in the thread', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const ch = seed.channels.general;
        const root = (await owner.ok('POST', `/channels/${ch}/messages`, { content: `Thread root ${seed.runTag} ${Date.now()}` }, [201])) as any;
        await openChannel(page, ch, 'general');
        const row = page.locator('[data-index]').filter({ hasText: root.content }).first();
        await row.hover();
        await row.getByRole('button', { name: 'Reply in thread' }).click();
        const panel = page.locator('aside[aria-label="thread"]');
        await expect(panel.getByRole('heading', { name: /Thread/ })).toBeVisible();
        const mixed = seed.agents.claude.name.replace(/^c/, 'C');
        await panel.getByPlaceholder('Reply...').fill(`@${mixed} please summarise`);
        await panel.getByRole('button', { name: 'Send reply' }).click();
        const notice = panel.getByText(`${seed.agents.claude.name} has no live session here, so nothing woke it.`);
        await expect(notice).toBeVisible({ timeout: 10_000 });
        await snap(page, ti, 'UI-01.thread-wake', '01-wake-notice', 'A thread panel beside the channel with a reply and a system notice saying the agent has no live session',
            { ready: notice });
        // Active-threads bar lists the new thread (live, then after reload)
        const chip = page.getByRole('toolbar', { name: 'Agents and active threads' }).getByRole('button', { name: new RegExp('^Open thread.*' + root.content.slice(0, 20)) });
        await expect.soft(chip, 'new thread appears in the active-threads bar without a reload').toBeVisible({ timeout: 5_000 });
        await page.reload();
        await expect(chip).toBeVisible();
        await chip.click();
        await expect(panel.getByRole('heading', { name: /Thread/ })).toBeVisible();
        // Close / reopen as owner
        await panel.getByRole('button', { name: 'Close thread' }).click();
        await expect(panel.getByRole('heading', { name: /Closed/ })).toBeVisible();
        await panel.getByRole('button', { name: 'Reopen thread' }).click();
        await expect(panel.getByRole('heading', { name: /Closed/ })).toHaveCount(0);
    });
});

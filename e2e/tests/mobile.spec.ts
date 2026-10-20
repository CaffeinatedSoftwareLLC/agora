import { test, expect, openChannel } from '../lib/fixtures';
import { snap } from '../lib/snap';

// Runs only in the pixel-7 project (see playwright.config.ts).
test.describe('mobile viewport @smoke', () => {
    test('[UI-08.mobile-nav] phone layout: channel view, nav overlay, no sideways scroll, 44px composer targets', async ({ page, seed }, ti) => {
        const name = `agents-${seed.runTag}`;
        await openChannel(page, seed.channels.agents, name);
        const box = page.getByPlaceholder(`Message #${name}`);
        await snap(page, ti, 'UI-08.mobile-nav', '01-channel', 'A phone layout showing a single channel with a message box at the bottom', { ready: box });

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, 'no horizontal scroll').toBeLessThanOrEqual(0);

        for (const label of ['Send message', 'Attach file']) {
            const bb = await page.getByRole('button', { name: label }).boundingBox();
            expect(bb, label).toBeTruthy();
            expect(Math.round(bb!.width), `${label} width`).toBeGreaterThanOrEqual(44);
            expect(Math.round(bb!.height), `${label} height`).toBeGreaterThanOrEqual(44);
        }

        await page.getByRole('button', { name: 'Open navigation' }).first().click();
        const nav = page.getByRole('dialog').filter({ has: page.locator('nav[aria-label="Channels"]') }).or(page.locator('nav[aria-label="Channels"][role="dialog"]')).first();
        await expect(nav).toBeVisible();
        await snap(page, ti, 'UI-08.mobile-nav', '02-nav-open', 'A phone navigation overlay listing text channels with a Back control', { ready: nav });
        await page.locator('nav[aria-label="Channels"]').getByRole('button', { name: /general/ }).click();
        await expect(page.getByPlaceholder('Message #general')).toBeVisible();
        await expect(page.locator('nav[aria-label="Channels"]')).toBeHidden();
    });

    test('[UI-08.mobile-thread] phone: message action sheet opens a thread pane with one Back control', async ({ page, seed }, ti) => {
        const name = `agents-${seed.runTag}`;
        await openChannel(page, seed.channels.agents, name);
        const row = page.locator('[data-index]').filter({ hasText: 'Duis aute irure' }).first();
        await expect(row).toBeVisible();
        await row.getByRole('button', { name: 'Message actions' }).click();
        await page.getByRole('button', { name: /Reply in thread/ }).click();
        const pane = page.locator('aside[aria-label="thread"]');
        await expect(pane.getByRole('heading', { name: /Thread/ })).toBeVisible();
        const back = pane.getByRole('button', { name: /^Back \/ Close/ });
        await expect(back).toHaveCount(1);
        await snap(page, ti, 'UI-08.mobile-thread', '01-thread', 'A phone screen showing a thread pane with a Back control and a reply box', { ready: back });
        await back.click();
        await expect(pane).toBeHidden();
    });
});

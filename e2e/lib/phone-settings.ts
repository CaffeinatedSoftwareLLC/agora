import type { Page, TestInfo } from '@playwright/test';
import { expect } from './fixtures';
import { snap } from './snap';

export async function checkPhoneSettings(page: Page, ti: TestInfo) {
    await page.goto('/settings');
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav).toBeVisible();
    await expect(page.getByRole('main', { name: 'Settings section' })).toHaveCount(0);
    await snap(page, ti, 'UI-08.settings-sections', '01-list', 'Phone Settings shows the section list at full width', { ready: nav });
    const sections = ['Roles', 'Role Assignment', 'Channel Overrides', 'Bots', 'Agents', 'AI', 'Instance Settings', 'File Storage'];
    for (const section of sections) {
        await nav.getByRole('link', { name: section, exact: true }).click();
        const main = page.getByRole('main', { name: 'Settings section' });
        await expect(main.getByRole('heading').first(), section).toBeVisible();
        await expect(page.getByText(/^Loading/)).toHaveCount(0);
        await expect(nav).toHaveCount(0);
        const width = page.viewportSize()!.width;
        expect((await main.boundingBox())!.width, `${section} content column is full width`).toBeGreaterThanOrEqual(width * 0.9);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${section} document overflow`).toBeLessThanOrEqual(0);
        expect(await main.evaluate(el => el.scrollWidth - el.clientWidth), `${section} content overflow`).toBeLessThanOrEqual(1);
        const back = page.getByRole('link', { name: 'Back to settings', exact: true });
        await expect(page.getByRole('link', { name: /^Back/ })).toHaveCount(1);
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        if (section === 'Agents') await snap(page, ti, 'UI-08.settings-sections', '02-agents', 'The Agents section fills the phone width with one Back control', { ready: back });
        await back.click();
        await expect(nav).toBeVisible();
    }
    await nav.getByRole('link', { name: 'Agents', exact: true }).click();
    await page.setViewportSize({ width: 839, height: 412 });
    await expect(nav).toBeVisible();
    await expect(page.getByRole('main', { name: 'Settings section' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to settings' })).toHaveCount(0);
    await page.setViewportSize({ width: 412, height: 839 });
    await expect(nav).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to settings' })).toBeVisible();
}

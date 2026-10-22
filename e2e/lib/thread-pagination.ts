import type { Page, TestInfo } from '@playwright/test';
import { apis, expect, openChannel } from './fixtures';
import { freshChannel, rowWith } from './helpers';
import { snap } from './snap';
import type { Seed } from './seed-types';

export async function checkThreadPagination(page: Page, seed: Seed, ti: TestInfo, phone: boolean) {
    const { owner } = apis(seed);
    const ch = await freshChannel(seed, 'thread-pages');
    const rootText = 'Review with 65 replies';
    const root = await owner.ok('POST', `/channels/${ch.id}/messages`, { content: rootText }, [201]) as { id: string };
    const endpoint = `/channels/${ch.id}/messages/${root.id.trim()}/replies`;
    for (let n = 1; n <= 65; n++) await owner.ok('POST', endpoint, { content: `Paged reply ${String(n).padStart(2, '0')}` }, [201]);
    const pane = page.locator('aside[aria-label="thread"]');
    async function openThread() {
        await openChannel(page, ch.id, ch.name);
        const rootRow = rowWith(page, rootText).first();
        if (phone) {
            await rootRow.getByRole('button', { name: 'Message actions' }).click();
            await page.getByRole('dialog', { name: 'Message actions' }).getByRole('button', { name: 'Reply in thread' }).click();
        } else {
            await rootRow.hover();
            await rootRow.getByRole('button', { name: 'Reply in thread' }).click();
        }
    }
    await openThread();
    const list = pane.getByRole('log', { name: 'Thread replies' });
    await expect(list.getByText('Paged reply 65', { exact: true })).toBeVisible();
    await expect(list.getByText('Paged reply 01', { exact: true })).toHaveCount(0);
    await expect(list.getByText('Paged reply 16', { exact: true })).toHaveCount(1);
    await snap(page, ti, 'UI-01.thread-pagination', '01-newest', 'A long thread opens at its newest reply, number 65', { ready: list.getByText('Paged reply 65', { exact: true }) });

    // Hold the older response so we can measure the visible row before and after prepend.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const routePattern = `**${endpoint}?**`;
    await page.route(routePattern, async route => {
        if (new URL(route.request().url()).searchParams.has('before')) await gate;
        await route.continue();
    });
    try {
        const olderRequest = page.waitForRequest(request => new URL(request.url()).pathname === endpoint && new URL(request.url()).searchParams.has('before'));
        await list.evaluate(el => { el.scrollTop = 0; });
        await olderRequest;
        const anchor = list.getByText('Paged reply 16', { exact: true });
        const before = (await anchor.boundingBox())!.y;
        release();
        await expect(list.getByText('Paged reply 01', { exact: true })).toHaveCount(1);
        await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before), 'prepending keeps the visible reply anchored').toBeLessThanOrEqual(4);
        await expect(pane.getByRole('button', { name: 'Load older replies', exact: true })).toHaveCount(0);
        await list.evaluate(el => { el.scrollTop = 0; });
        await expect(list.getByText('Paged reply 01', { exact: true })).toBeVisible();
        await snap(page, ti, 'UI-01.thread-pagination', '02-oldest', 'Scrolling up loads the oldest replies without losing the reading position', { ready: list.getByText('Paged reply 01', { exact: true }) });
    } finally {
        release();
        await page.unroute(routePattern);
    }
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await owner.ok('POST', endpoint, { content: 'Paged reply 66 live' }, [201]);
    await expect(list.getByText('Paged reply 66 live', { exact: true })).toBeVisible();
    await page.reload();
    await openThread();
    await expect(pane.getByText('Paged reply 66 live', { exact: true })).toBeVisible();
    await expect(pane.getByText('Paged reply 01', { exact: true })).toHaveCount(0);
}

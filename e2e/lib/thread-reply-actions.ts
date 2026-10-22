import type { Locator, Page } from '@playwright/test';
import { apis, expect, openChannel } from './fixtures';
import { freshChannel, rowWith, uniq } from './helpers';
import type { Seed } from './seed-types';

/** Shared by the desktop threads spec and the pixel-7 mobile spec (#204). */
export async function checkThreadReplyActions(page: Page, seed: Seed, phone: boolean) {
    const { owner } = apis(seed);
    const channel = await freshChannel(seed, 'reply-actions');
    const rootText = uniq(seed, 'parent');
    const original = uniq(seed, 'own-reply');
    const edited = `${original} edited`;
    const root = await owner.ok('POST', `/channels/${channel.id}/messages`, { content: rootText }, [201]) as { id: string };
    const reply = await owner.ok('POST', `/channels/${channel.id}/messages/${root.id.trim()}/replies`, { content: original }, [201]) as { id: string };
    const replyPath = `/channels/${channel.id}/messages/${reply.id.trim()}`;

    async function action(client: Page, row: Locator, name: 'Reply in thread' | 'Edit' | 'Delete') {
        if (phone) {
            await row.getByRole('button', { name: 'Message actions' }).click();
            const sheet = client.getByRole('dialog', { name: 'Message actions' });
            await expect(sheet).toBeVisible();
            await sheet.getByRole('button', { name: name === 'Edit' ? 'Edit message' : name === 'Delete' ? 'Delete message' : name }).click();
        } else {
            await row.hover();
            await row.getByRole('button', { name, exact: true }).click();
        }
    }
    async function openPane(client: Page) {
        await openChannel(client, channel.id, channel.name);
        await action(client, rowWith(client, rootText).first(), 'Reply in thread');
        const pane = client.locator('aside[aria-label="thread"]');
        await expect(pane.getByText(original, { exact: true })).toBeVisible();
        return pane;
    }

    const pane = await openPane(page);
    const observer = await page.context().newPage();
    try {
        const otherPane = await openPane(observer);
        const ownRow = () => pane.locator('div.group').filter({ hasText: original }).first();
        await action(page, ownRow(), 'Edit');
        const editor = pane.locator('textarea:not([placeholder])');
        await expect(editor).toBeVisible();
        await editor.fill(edited);
        const patch = page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === replyPath);
        await editor.press('Enter');
        expect((await patch).status()).toBe(200);
        await expect(pane.getByText(edited, { exact: true })).toBeVisible();
        await expect(otherPane.getByText(edited, { exact: true })).toBeVisible();
        const afterEdit = await owner.ok('GET', `/channels/${channel.id}/messages/${root.id.trim()}/replies`) as { id: string; content: string | null; deletedAt?: string }[];
        expect(afterEdit.find(r => r.id.trim() === reply.id.trim())?.content).toBe(edited);

        const deletion = page.waitForResponse(r => r.request().method() === 'DELETE' && new URL(r.url()).pathname === replyPath);
        await action(page, ownRow(), 'Delete');
        expect((await deletion).status()).toBe(200);
        await expect(pane.getByText('[message deleted]', { exact: true })).toBeVisible();
        await expect(otherPane.getByText('[message deleted]', { exact: true })).toBeVisible();
        const afterDelete = await owner.ok('GET', `/channels/${channel.id}/messages/${root.id.trim()}/replies`) as { id: string; content: string | null; deletedAt?: string }[];
        const tombstone = afterDelete.find(r => r.id.trim() === reply.id.trim());
        expect(tombstone?.content).toBeNull();
        expect(tombstone?.deletedAt).toBeTruthy();
    } finally { await observer.close(); }
}

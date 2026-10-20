import { test, expect, apis, openChannel, storageStateFor } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { freshChannel, rowWith } from '../lib/helpers';

test.describe('threads: replies, active-threads bar, who may close', () => {
    test('[UI-01.thread-member-close] owner starts and replies; member sees it but cannot close or reopen (403, no change)', async ({ page, browser, seed }, ti) => {
        const { owner, member } = apis(seed);
        const ch = await freshChannel(seed, 'thr');
        const root = (await owner.ok('POST', `/channels/${ch.id}/messages`, { content: `Thread root ${seed.runTag} ${Date.now()}` }, [201])) as any;
        const rootState = async () => ((await owner.ok('GET', `/channels/${ch.id}/messages?limit=10`)) as any[]).find(m => m.id === root.id);

        // Owner: start the thread from the message and reply in it
        await openChannel(page, ch.id, ch.name);
        const row = rowWith(page, root.content).first();
        await row.hover();
        await row.getByRole('button', { name: 'Reply in thread' }).click();
        const panel = page.locator('aside[aria-label="thread"]');
        await expect(panel.getByRole('heading', { name: /Thread/ })).toBeVisible();
        const replies = [`First reply ${seed.runTag}`, `Second reply ${seed.runTag}`];
        for (const r of replies) {
            await panel.getByPlaceholder('Reply...').fill(r);
            await panel.getByRole('button', { name: 'Send reply' }).click();
            // Exactly one copy once settled: the optimistic row and the socket echo can overlap
            // for a moment when the echo beats the POST response (threadStore.sendReply)
            await expect(panel.getByRole('paragraph').filter({ hasText: r })).toHaveCount(1);
            await expect(panel.getByPlaceholder('Reply...')).toHaveValue('');
        }
        const chip = page.getByRole('toolbar', { name: 'Agents and active threads' })
            .getByRole('button', { name: new RegExp('^Open thread.*' + root.content.slice(0, 20)) });
        await expect(chip, 'thread shows in the active-threads bar').toBeVisible();
        await snap(page, ti, 'UI-01.thread-member-close', '01-owner-thread', 'A thread panel open beside the channel with two replies', { ready: panel.getByRole('paragraph').filter({ hasText: replies[1] }) });

        // Persisted: two replies on the root, nothing else
        const apiReplies = (await owner.ok('GET', `/channels/${ch.id}/messages/${root.id}/replies`)) as any;
        const list: any[] = Array.isArray(apiReplies) ? apiReplies : apiReplies.replies ?? apiReplies.messages;
        expect(list.map(r => r.content)).toEqual(replies);
        expect((await rootState()).replyCount).toBe(2);
        expect((await rootState()).threadClosedAt).toBeUndefined();

        // Member: sees the thread, no Close button
        const ctx = await browser.newContext({ storageState: storageStateFor('member') });
        const mp = await ctx.newPage();
        await openChannel(mp, ch.id, ch.name);
        const mChip = mp.getByRole('toolbar', { name: 'Agents and active threads' })
            .getByRole('button', { name: new RegExp('^Open thread.*' + root.content.slice(0, 20)) });
        await mChip.click();
        const mPanel = mp.locator('aside[aria-label="thread"]');
        await expect(mPanel.getByRole('paragraph').filter({ hasText: replies[1] })).toBeVisible();
        await expect(mPanel.getByRole('button', { name: 'Close thread' })).toHaveCount(0);
        // A hidden button is not a refusal: the API must say no and change nothing
        const close = await member.req('PATCH', `/channels/${ch.id}/messages/${root.id}/thread`, { closed: true });
        expect(close.status).toBe(403);
        expect((await rootState()).threadClosedAt, 'still open after the member tried').toBeUndefined();

        // Owner closes; the member sees it closed live and cannot reopen it
        await panel.getByRole('button', { name: 'Close thread' }).click();
        await expect(panel.getByRole('heading', { name: /Closed/ })).toBeVisible();
        expect((await rootState()).threadClosedAt).toBeTruthy();
        await expect(mPanel.getByRole('heading', { name: /Closed/ })).toBeVisible();
        const closedAt = (await rootState()).threadClosedAt;
        const reopen = await member.req('PATCH', `/channels/${ch.id}/messages/${root.id}/thread`, { closed: false });
        expect(reopen.status).toBe(403);
        expect((await rootState()).threadClosedAt, 'still closed, same timestamp').toBe(closedAt);

        // Owner reopens
        await panel.getByRole('button', { name: 'Reopen thread' }).click();
        await expect(panel.getByRole('heading', { name: /Closed/ })).toHaveCount(0);
        expect((await rootState()).threadClosedAt).toBeUndefined();
        await ctx.close();
    });
});

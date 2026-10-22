import type { Locator, Page } from '@playwright/test';
import { checkAgentMessageRuns } from '../lib/agent-message-runs';
import { checkThreadPagination } from '../lib/thread-pagination';
import { checkPhoneSettings } from '../lib/phone-settings';
import { checkThreadReplyActions } from '../lib/thread-reply-actions';
import { test, expect, openChannel, apis } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { freshChannel, makeBot, uniq } from '../lib/helpers';

interface Target { label: string; w: number; h: number }

/** Every rendered, visible button under the given elements, with its size in CSS px. */
async function buttonsIn(scope: Locator): Promise<Target[]> {
    return scope.evaluateAll(els => {
        const out: { label: string; w: number; h: number }[] = [];
        for (const el of els) {
            for (const b of Array.from(el.querySelectorAll('button'))) {
                const r = b.getBoundingClientRect();
                const cs = getComputedStyle(b);
                if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
                const label = (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
                out.push({ label, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });
            }
        }
        return out;
    });
}

const small = (ts: Target[], min: number) => ts.filter(t => t.w < min || t.h < min);

/** Horizontal overflow of the page (0 or less: no sideways scroll). */
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

// Runs only in the pixel-7 project (see playwright.config.ts).
test.describe('mobile viewport @smoke', () => {
    test('[UI-08.agent-runs] phone agent drawers wrap names and preserve cards and protocol badges', async ({ page, seed }, ti) => {
        await checkAgentMessageRuns(page, seed, ti);
    });
    test('[UI-08.thread-pagination] phone thread opens newest and pages older beyond 50', async ({ page, seed }, ti) => {
        await checkThreadPagination(page, seed, ti, true);
    });
    test('[UI-08.settings-sections] every phone settings section is full width with one Back control', async ({ page }, ti) => {
        await checkPhoneSettings(page, ti);
    });
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

test.describe('mobile touch targets and width', () => {
    test('[UI-08.touch-targets] every button in message cards, tool cards and file/canvas cards is at least 44x44; notice drawer at least 32', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const ch = await freshChannel(seed, 'touch');
        const bot = await makeBot(seed, uniq(seed, 'tt-bot'), [ch.id]);
        // A plain message, a message with a file card, a canvas card and a tool permission card
        await owner.ok('POST', `/channels/${ch.id}/messages`, { content: `Touch target check ${seed.runTag}: a plain message with a [link](https://example.com).` }, [201]);
        const fd = new FormData();
        fd.append('channel_id', ch.id);
        fd.append('file', new Blob([`touch target fixture ${seed.runTag}\n`], { type: 'text/plain' }), 'touch-notes.txt');
        const up = await owner.req('POST', '/files/upload', fd);
        expect(up.status, JSON.stringify(up.data)).toBe(201);
        await owner.ok('POST', `/channels/${ch.id}/messages`, { content: 'Notes attached.', attachments: [up.data.id] }, [201]);
        const title = `Touch canvas ${seed.runTag}`;
        await bot.api.ok('POST', `/channels/${ch.id}/messages`, { content: 'Published a canvas page.', artifact: { title, kind: 'html', content: '<h1>Touch</h1>' } }, [201]);
        const relayId = 'tchab';
        await bot.api.ok('POST', `/channels/${ch.id}/permission-relays`, { relayId, toolName: 'Bash', description: 'List the files in the work folder', inputPreview: 'ls -la' }, [201]);

        await openChannel(page, ch.id, ch.name);
        const rows = page.locator('[data-index]');
        await expect(rows.filter({ hasText: 'Notes attached.' })).toBeVisible();
        await expect(page.getByRole('button', { name: `Open ${title} in the canvas` })).toBeVisible();
        const relay = rows.filter({ hasText: 'Bash' }).filter({ has: page.getByRole('button', { name: /Allow/ }) }).last();
        await expect(relay, 'the permission relay card with Allow/Deny').toBeVisible({ timeout: 15_000 });
        await snap(page, ti, 'UI-08.touch-targets', '01-cards', 'A phone screen showing a message with a file card, a canvas card and a permission request card with Allow and Deny buttons', { ready: relay });

        const targets = await buttonsIn(rows);
        test.info().annotations.push({ type: 'note', description: `message/card buttons measured: ${JSON.stringify(targets)}` });
        expect(targets.length, 'buttons found in the message rows').toBeGreaterThanOrEqual(4);
        expect(small(targets, 44), 'buttons in message rows and cards under 44x44 CSS px').toEqual([]);

        // Notice drawer (32 px allowed): collapsed toggle, then the expanded notices
        await openChannel(page, seed.channels.notices, `notices-${seed.runTag}`);
        const toggle = page.getByRole('button', { name: /^\d+ notices$/ }).first();
        await expect(toggle).toBeVisible();
        const drawerRow = rows.filter({ has: toggle });
        const collapsed = await buttonsIn(drawerRow);
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const expanded = await buttonsIn(rows.filter({ hasText: /session|Started|ended/i }));
        test.info().annotations.push({ type: 'note', description: `notice drawer buttons: ${JSON.stringify([...collapsed, ...expanded])}` });
        expect(collapsed.length).toBeGreaterThanOrEqual(1);
        expect(small([...collapsed, ...expanded], 32), 'notice drawer buttons under 32x32 CSS px').toEqual([]);
        await toggle.click(); // leave the drawer collapsed
    });

    test('[UI-08.no-hscroll-360] at 360 px wide the channel, thread and settings pages never scroll sideways', async ({ page, seed }) => {
        await page.setViewportSize({ width: 360, height: 780 });
        const results: { where: string; overflow: number }[] = [];

        const name = `agents-${seed.runTag}`;
        await openChannel(page, seed.channels.agents, name);
        results.push({ where: 'channel', overflow: await overflowX(page) });

        const row = page.locator('[data-index]').filter({ hasText: 'Ut enim ad minim' }).first();
        await expect(row).toBeVisible();
        await row.getByRole('button', { name: 'Message actions' }).click();
        await page.getByRole('button', { name: /Reply in thread/ }).click();
        const pane = page.locator('aside[aria-label="thread"]');
        await expect(pane.getByRole('heading', { name: /Thread/ })).toBeVisible();
        results.push({ where: 'thread', overflow: await overflowX(page) });

        const pages = [
            '/settings/roles', '/settings/role-assign', '/settings/overrides', '/settings/bots', '/settings/agents', '/settings/ai',
            '/settings/instance', '/settings/storage', '/account', '/admin', '/admin/users', '/admin/pending', '/admin/provider-terms',
        ];
        for (const p of pages) {
            await page.goto(p);
            await expect(page.getByRole('heading').first(), `${p} rendered`).toBeVisible({ timeout: 15_000 });
            await expect(page.getByText(/^Loading/)).toHaveCount(0, { timeout: 15_000 });
            results.push({ where: p, overflow: await overflowX(page) });
        }
        test.info().annotations.push({ type: 'note', description: `overflow at 360px: ${JSON.stringify(results)}` });
        expect(results.filter(r => r.overflow > 0), 'pages wider than the 360 px viewport').toEqual([]);
    });
});
test('[UI-01.thread-reply-actions] phone sheet edits and deletes an own reply, including another client', async ({ page, seed }) => {
    await checkThreadReplyActions(page, seed, true);
});

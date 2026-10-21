import { test, expect, apis, openChannel, storageStateFor } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { freshChannel, rowWith } from '../lib/helpers';
import type { WebSocketRoute } from '@playwright/test';

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

// ---- Live edit/delete, Markdown, sanitizing, reconnect, hidden channels (not smoke) ----

test.describe('chat: edit, delete, rendering, reconnect, hidden channels', () => {
    test('[UI-01.edit-delete-live] send, edit and delete; the member sees each change live', async ({ page, browser, seed }, ti) => {
        const { owner } = apis(seed);
        const ch = await freshChannel(seed, 'live');
        const memberCtx = await browser.newContext({ storageState: storageStateFor('member') });
        const memberPage = await memberCtx.newPage();
        await openChannel(memberPage, ch.id, ch.name);
        await openChannel(page, ch.id, ch.name);

        const text = `Original ${seed.runTag} ${Date.now()}`;
        await page.getByPlaceholder(`Message #${ch.name}`).fill(text);
        await page.getByRole('button', { name: 'Send message' }).click();
        await expect(memberPage.locator('[data-index]').getByText(text)).toBeVisible();
        let rows = (await owner.ok('GET', `/channels/${ch.id}/messages?limit=20`)) as any[];
        expect(rows.filter(m => m.content === text), 'exactly one message row').toHaveLength(1);
        const msgId = rows.find(m => m.content === text).id;

        // Edit
        const edited = `Changed ${seed.runTag} ${Date.now()}`;
        const row = rowWith(page, text).last();
        await row.hover();
        await row.getByRole('button', { name: 'Edit', exact: true }).click();
        const box = page.locator('[data-index] textarea');
        await box.fill(edited);
        await box.press('Enter');
        const memberRow = rowWith(memberPage, edited).last();
        await expect(memberRow).toBeVisible();
        await expect(memberRow.getByText('(edited)')).toBeVisible();
        await expect(memberPage.getByText(text)).toHaveCount(0);
        rows = (await owner.ok('GET', `/channels/${ch.id}/messages?limit=20`)) as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(msgId);
        expect(rows[0].content).toBe(edited);
        expect(rows[0].editedAt, 'editedAt persisted').toBeTruthy();
        await snap(memberPage, ti, 'UI-01.edit-delete-live', '01-member-sees-edit', 'A channel message marked (edited) as seen by a second user', { ready: memberRow });

        // Delete (the product asks no confirmation)
        const row2 = rowWith(page, edited).last();
        await row2.hover();
        await row2.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(memberPage.getByText(edited)).toHaveCount(0);
        await expect(memberPage.getByText('[message deleted]')).toHaveCount(1);
        await expect(page.getByText('[message deleted]')).toHaveCount(1);
        rows = (await owner.ok('GET', `/channels/${ch.id}/messages?limit=20`)) as any[];
        expect(rows, 'still one row: a delete is a tombstone, not a second message').toHaveLength(1);
        expect(rows[0].deletedAt, 'deletedAt persisted').toBeTruthy();
        expect(rows[0].content).toBeNull();
        await memberCtx.close();
    });

    test('[UI-01.markdown] code block, list and a link that opens a new tab with rel=noopener', async ({ page, context, seed }, ti) => {
        const ch = await freshChannel(seed, 'md');
        const linkUrl = `https://example.com/agora-e2e-${seed.runTag}`;
        // Never leave the machine: the new tab is answered locally
        await context.route('https://example.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>e2e target</title><p>e2e target</p>' }));
        await openChannel(page, ch.id, ch.name);
        const head = `Markdown ${seed.runTag}`;
        const md = `${head}\n\n\`\`\`\nconst e2e = 1;\n\`\`\`\n\n- alpha item\n- beta item\n\n[e2e link](${linkUrl})`;
        await page.getByPlaceholder(`Message #${ch.name}`).fill(md);
        await page.getByRole('button', { name: 'Send message' }).click();
        const row = rowWith(page, head).last();
        await expect(row.locator('pre code')).toHaveText(/const e2e = 1;/);
        await expect(row.locator('ul > li')).toHaveText(['alpha item', 'beta item']);
        const link = row.getByRole('link', { name: 'e2e link' });
        await expect(link).toHaveAttribute('href', linkUrl);
        await expect(link).toHaveAttribute('target', '_blank');
        expect((await link.getAttribute('rel')) ?? '').toMatch(/\bnoopener\b/);
        await snap(page, ti, 'UI-01.markdown', '01-rendered', 'A message rendered as Markdown: a code block, a two-item bullet list and an underlined link', { ready: link });
        const popupP = page.waitForEvent('popup');
        await link.click();
        const popup = await popupP;
        await popup.waitForLoadState('domcontentloaded');
        expect(popup.url()).toBe(linkUrl);
        expect(await popup.evaluate(() => window.opener === null), 'new tab has no opener').toBe(true);
        await popup.close();
    });

    test('[UI-01.sanitize] ANSI escapes are stripped and a private key block is redacted', async ({ page, seed }, ti) => {
        const { member, owner } = apis(seed);
        const ch = await freshChannel(seed, 'clean');
        const ESC = '\u001b';
        // Built from parts so no key-shaped block sits in the source
        const pem = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
        const pemEnd = ['-----END', 'PRIVATE KEY-----'].join(' ');
        const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCe2eFAKEe2eFAKE';
        const head = `Terminal ${seed.runTag}`;
        const raw = (h: string) => `${h}: ${ESC}[31mred${ESC}[0m text${ESC}]0;title${ESC}\\ end\n${pem}\n${body}\n${pemEnd}\nafter-key`;

        // Agents relay terminal output through the API: the server cleans it before storing
        const posted = await member.req('POST', `/channels/${ch.id}/messages`, { content: raw(head) });
        expect(posted.status).toBe(201);
        const stored = (await owner.ok('GET', `/channels/${ch.id}/messages?limit=5`)) as any[];
        expect(stored).toHaveLength(1);
        const c: string = stored[0].content;
        expect(c.includes(ESC), 'no escape byte stored').toBe(false);
        expect(c.includes('BEGIN PRIVATE'), 'no key header stored').toBe(false);
        expect(c.includes(body), 'no key body stored').toBe(false);
        expect(c).toContain('red text end');
        expect(c).toContain('[private key redacted]');
        expect(c).toContain('after-key');

        // The same text typed into the composer
        await openChannel(page, ch.id, ch.name);
        const head2 = `Composer ${seed.runTag}`;
        await page.getByPlaceholder(`Message #${ch.name}`).fill(raw(head2));
        const resP = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/channels/${ch.id}/messages`);
        await page.getByRole('button', { name: 'Send message' }).click();
        const res = await (await resP).json();
        expect(String(res.content).includes('BEGIN PRIVATE'), 'composer post redacted too').toBe(false);
        expect(String(res.content).includes(ESC), 'composer post has no escape byte').toBe(false);

        const row = rowWith(page, head).last();
        await expect(row.getByText(/private key redacted/)).toBeVisible();
        await expect(rowWith(page, head2).last().getByText(/private key redacted/)).toBeVisible();
        const shown = await page.locator('[data-index]').allInnerTexts();
        expect(shown.some(t => t.includes('BEGIN PRIVATE') || t.includes(body)), 'no key text on screen').toBe(false);
        await snap(page, ti, 'UI-01.sanitize', '01-redacted', 'A message where a private key block is shown as "[private key redacted]" and terminal colour codes are gone', { ready: row });
    });

    test('[UI-02.reconnect] offline then online: chat is not blank, missed messages load, new-messages pill', async ({ browser, seed }, ti) => {
        const { owner } = apis(seed);
        const ch = await freshChannel(seed, 'recon');
        for (let i = 1; i <= 40; i++) {
            await owner.ok('POST', `/channels/${ch.id}/messages`, { content: `Backlog ${String(i).padStart(2, '0')} ${seed.runTag}` }, [201]);
        }
        const ctx = await browser.newContext({ storageState: storageStateFor('member') });
        // setOffline does not cut a WebSocket that is already open (Chromium), so the socket is
        // proxied: going offline also closes it and refuses new handshakes until back online.
        let offline = false;
        const sockets: WebSocketRoute[] = [];
        await ctx.routeWebSocket(/\/socket\.io\//, ws => {
            if (offline) { void ws.close({ code: 4000, reason: 'e2e offline' }); return; }
            ws.connectToServer();
            sockets.push(ws);
        });
        const page = await ctx.newPage();
        await openChannel(page, ch.id, ch.name);
        await expect(page.locator('[data-index]').getByText(`Backlog 40 ${seed.runTag}`)).toBeVisible();

        offline = true;
        await ctx.setOffline(true);
        for (const ws of sockets.splice(0)) await ws.close({ code: 4000, reason: 'e2e offline' });
        // The status dot in the channel header (role img, aria-label = socket state)
        await expect(page.getByRole('img', { name: /^(disconnected|reconnecting)$/ })).toBeVisible({ timeout: 30_000 });
        const missed = `Missed while offline ${seed.runTag}`;
        await owner.ok('POST', `/channels/${ch.id}/messages`, { content: missed }, [201]);
        await expect(page.locator('[data-index]').getByText(missed), 'nothing arrives while offline').toHaveCount(0);
        offline = false;
        await ctx.setOffline(false);
        await expect(page.getByRole('img', { name: 'connected', exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('[data-index]').getByText(missed)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText('Loading messages...')).toHaveCount(0);
        expect(await page.locator('[data-index]').count(), 'chat is not blank after reconnect').toBeGreaterThan(5);

        // Scrolled up, new messages show a pill instead of jumping
        const scroller = page.locator('[data-index]').first().locator('xpath=ancestor::*[contains(@class,"overflow-y-auto")][1]');
        await scroller.evaluate(el => { el.scrollTop = 0; });
        await expect(page.locator('[data-index]').getByText(missed)).toBeHidden();
        for (const n of [1, 2]) await owner.ok('POST', `/channels/${ch.id}/messages`, { content: `Arrived ${n} ${seed.runTag}` }, [201]);
        const pill = page.getByRole('button', { name: /^2 new messages$/ });
        await expect(pill).toBeVisible();
        await snap(page, ti, 'UI-02.reconnect', '01-pill', 'A channel scrolled up with a "2 new messages" pill above the message box', { ready: pill });
        await pill.click();
        await expect(page.locator('[data-index]').getByText(`Arrived 2 ${seed.runTag}`)).toBeVisible();
        await expect(pill).toHaveCount(0);
        await ctx.close();
    });

    test('[ID-04.hidden-channel] ViewChannel denied to @everyone: hidden from the member in the list, by URL and over REST', async ({ page, browser, seed }, ti) => {
        const { owner, member } = apis(seed);
        const ch = await freshChannel(seed, 'secret');
        const roles = (await owner.ok('GET', `/servers/${seed.serverId}/roles`)) as any[];
        const everyone = roles.find(r => r.isEveryone).id;
        await owner.ok('PUT', `/channels/${ch.id}/overrides/roles/${everyone}`, { allow: '0', deny: (1n << 10n).toString() });
        const marker = `Secret marker ${seed.runTag} ${Date.now()}`;
        await owner.ok('POST', `/channels/${ch.id}/messages`, { content: marker }, [201]);

        // The owner still sees it (proves the selectors below would find it)
        await openChannel(page, ch.id, ch.name);
        await expect(page.locator('[data-index]').getByText(marker)).toBeVisible();

        const ctx = await browser.newContext({ storageState: storageStateFor('member') });
        const mp = await ctx.newPage();
        await openChannel(mp, seed.channels.general, 'general');
        await expect(mp.getByText(`agents-${seed.runTag}`).first()).toBeVisible(); // the list is rendered
        await expect(mp.getByText(ch.name)).toHaveCount(0);
        await mp.goto(`/app/${ch.id}`);
        await expect(mp.getByText('Select a channel', { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(mp.getByPlaceholder(`Message #${ch.name}`)).toHaveCount(0);
        await expect(mp.getByText(marker)).toHaveCount(0);
        await snap(mp, ti, 'ID-04.hidden-channel', '01-direct-url', 'An empty "Select a channel" view: the member opened a hidden channel by URL and sees nothing of it',
            { ready: mp.getByText('Select a channel', { exact: true }) });

        // REST with the member's cookie session, and with a bearer token
        const viaCookie = await mp.request.get(`/channels/${ch.id}/messages`);
        expect(viaCookie.status()).toBe(403);
        expect((await viaCookie.text()).includes(marker)).toBe(false);
        expect((await member.req('GET', `/channels/${ch.id}/messages`)).status).toBe(403);
        const list = (await member.ok('GET', `/servers/${seed.serverId}/channels`)) as any[];
        expect(list.some(c => c.id === ch.id), 'channel list API hides it').toBe(false);
        // A post into it is refused and creates nothing
        expect((await member.req('POST', `/channels/${ch.id}/messages`, { content: `member post ${seed.runTag}` })).status).toBe(403);
        const rows = (await owner.ok('GET', `/channels/${ch.id}/messages?limit=10`)) as any[];
        expect(rows.map(r => r.content)).toEqual([marker]);
        await ctx.close();
    });
});

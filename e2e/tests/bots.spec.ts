import type { Page } from '@playwright/test';
import { test, expect, apis } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { e2eEnv } from '../lib/env';
import { freshChannel, makeBot, scrubText, uniq } from '../lib/helpers';

/** A bot's expandable row on /settings/bots. */
const botRow = (page: Page, name: string) => page.locator('div.rounded-lg.overflow-hidden').filter({ has: page.getByText(name, { exact: true }) });

async function openBots(page: Page) {
    await page.goto('/settings/bots');
    await expect(page.getByRole('heading', { name: 'Bot Management' })).toBeVisible({ timeout: 15_000 });
}

/** Mirrors inviteCommand() in agora-ui/src/features/settings/CreateAgentInviteModal.tsx. */
function expectedCommand(client: 'claude' | 'codex' | 'gemini', instance: string, code: string) {
    const args = `--instance "${instance}" --channel general --invite ${code}`;
    if (client === 'claude') return `claude mcp add --transport stdio --scope user agora -- agora-mcp ${args}`;
    if (client === 'codex') return `codex mcp add agora -- agora-mcp ${args}`;
    return `gemini mcp add --scope user agora agora-mcp -- ${args}`;
}

test.describe('bots, tokens and agent invites', () => {
    test('[ID-05.bot-token-once] create a bot and mint a token: shown once, then only metadata', async ({ page, seed }, ti) => {
        const { owner, anon } = apis(seed);
        const name = uniq(seed, 'tokenbot');
        await openBots(page);
        await page.getByRole('button', { name: 'Create Bot' }).click();
        const createDlg = page.getByRole('dialog', { name: 'Create Bot' });
        await createDlg.getByLabel('Bot Username').fill(name);
        const created = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/servers/${seed.serverId}/bots`);
        await createDlg.getByRole('button', { name: 'Create', exact: true }).click();
        expect((await created).status()).toBe(201);
        const bots = (await owner.ok('GET', `/servers/${seed.serverId}/bots`)) as any[];
        const mine = bots.filter(b => b.username === name);
        expect(mine, 'one bot created').toHaveLength(1);
        const botId: string = mine[0].id;

        const row = botRow(page, name);
        await row.getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).click();
        await row.getByRole('button', { name: 'New Token' }).click();
        const dlg = page.getByRole('dialog', { name: 'Token Created' });
        const tokenEl = dlg.locator('.font-mono');
        await expect(tokenEl).toBeVisible();
        const token = (await tokenEl.innerText()).trim();   // kept in memory only
        expect(/^bot_[0-9A-HJKMNP-TV-Z]{26}\.[0-9a-f]{64}$/.test(token), 'token has the bot_<id>.<secret> shape').toBe(true);
        await expect(dlg.getByText('Copy this token now. It will not be shown again.')).toBeVisible();
        // The screenshot never carries the token: masked in pixels and replaced in the DOM text
        await scrubText(page, token, 'bot_••••••••');
        await snap(page, ti, 'ID-05.bot-token-once', '01-token-dialog', 'A dialog showing a new bot token (masked) with a Copy button and a warning it will not be shown again',
            { ready: dlg.getByRole('button', { name: 'Copy' }), mask: [tokenEl] });
        const me = await anon.with(`Bot ${token}`).req('GET', '/bots/@me');
        expect([me.status, me.data?.id?.trim()]).toEqual([200, botId]);
        await dlg.getByRole('button', { name: 'Done' }).click();
        await expect(dlg).toHaveCount(0);

        // Stored as metadata only
        const tokens = (await owner.ok('GET', `/servers/${seed.serverId}/bots/${botId}/tokens`)) as any[];
        expect(tokens).toHaveLength(1);
        expect(JSON.stringify(tokens).includes(token.split('.')[1]), 'token list has no secret').toBe(false);
        expect(Object.keys(tokens[0]).sort()).toEqual(['createdAt', 'id', 'lastUsedAt', 'name', 'revokedAt']);

        await page.reload();
        await expect(page.getByRole('heading', { name: 'Bot Management' })).toBeVisible({ timeout: 15_000 });
        const row2 = botRow(page, name);
        await row2.getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).click();
        const tokenRow = row2.getByText('Unnamed');
        await expect(tokenRow).toBeVisible();
        await expect(row2.getByRole('button', { name: 'Revoke' })).toHaveCount(1);
        expect(await page.evaluate(t => document.documentElement.outerHTML.includes(t), token), 'token is nowhere in the page after reload').toBe(false);
        await snap(page, ti, 'ID-05.bot-token-once', '02-after-reload', 'A bot detail panel whose Tokens section lists one unnamed token with its creation date and a Revoke button, no token value',
            { ready: tokenRow });
    });

    test('[ID-05.invite-dialog] Invite Agent shows the setup command for Claude Code, Codex and Gemini with an expiry', async ({ page, seed }, ti) => {
        const instance = e2eEnv().baseURL;
        const name = uniq(seed, 'invbot');
        await openBots(page);
        await page.getByRole('button', { name: 'Invite Agent' }).first().click();
        const dlg = page.getByRole('dialog', { name: 'Invite Agent' });
        await dlg.getByLabel('New bot username').fill(name);
        await dlg.getByLabel('Instance URL reachable by the agent').fill(instance);
        const resP = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/servers/${seed.serverId}/agent-invites`);
        await dlg.getByRole('button', { name: 'Create Invite' }).click();
        const res = await resP;
        expect(res.status()).toBe(201);
        const inv = await res.json();
        const code: string = inv.code;
        expect(/^[0-9a-f]{64}$/.test(code)).toBe(true);
        const minutes = (Date.parse(inv.expiresAt) - Date.now()) / 60_000;
        expect(minutes, 'expires in about 10 minutes').toBeGreaterThan(8);
        expect(minutes).toBeLessThanOrEqual(10.5);
        await expect(dlg.getByText(/^Single use\. Expires .+\. Start the agent before it expires\.$/)).toBeVisible();

        const cmd = dlg.getByLabel('Setup command');
        const agent = dlg.getByLabel('Agent', { exact: true });
        for (const [value, label] of [['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini CLI']] as const) {
            await agent.selectOption({ label });
            const shown = (await cmd.innerText()).trim();
            // Compared with the code blanked out, so a failure message never carries it
            expect(shown.split(code).join('<code>'), `${label} command`).toBe(expectedCommand(value, instance, '<code>'));
            expect(shown.includes(code), `${label} command carries the invite code`).toBe(true);
        }
        const link = dlg.getByText(/^Invite link \(use with --invite\):/);
        await agent.selectOption({ label: 'Claude Code' });
        await scrubText(page, code, '••••••••');
        await snap(page, ti, 'ID-05.invite-dialog', '01-claude-command', 'An invite dialog for Claude Code with an expiry time, the setup command and invite link masked out, and a Copy Setup Command button',
            { ready: cmd, mask: [cmd, link] });
        // The invite created a bot with access to #general only, and no token yet
        const { owner } = apis(seed);
        const detail = (await owner.ok('GET', `/servers/${seed.serverId}/bots/${inv.botId}`)) as any;
        expect(detail.username).toBe(name);
        expect(detail.channels.map((c: any) => c.name)).toEqual(['general']);
        expect((await owner.ok('GET', `/servers/${seed.serverId}/bots/${inv.botId}/tokens`)) as any[]).toHaveLength(0);
    });

    test('[ID-05.invite-redeem] redeeming an agent invite returns a working token once; the second redeem is 410', async ({ seed }) => {
        const { owner, anon } = apis(seed);
        const inv = (await owner.ok('POST', `/servers/${seed.serverId}/agent-invites`, { username: uniq(seed, 'redeembot') }, [201])) as any;
        const first = await anon.req('POST', '/agent-invites/redeem', { code: inv.code });
        expect(first.status).toBe(200);
        expect(first.data.botId).toBe(inv.botId);
        const me = await anon.with(`Bot ${first.data.token}`).req('GET', '/bots/@me');
        expect([me.status, me.data?.id?.trim()]).toEqual([200, inv.botId]);
        const second = await anon.req('POST', '/agent-invites/redeem', { code: inv.code });
        expect([second.status, second.data?.error]).toEqual([410, 'invite_invalid_or_expired']);
        expect(second.data?.token, 'no token on replay').toBeUndefined();
        const tokens = (await owner.ok('GET', `/servers/${seed.serverId}/bots/${inv.botId}/tokens`)) as any[];
        expect(tokens.map(t => t.name), 'exactly one token minted').toEqual(['Agent invite']);
    });

    test('[ID-05.bot-pause] a paused bot\'s post is refused (423) and creates no message; resume restores it', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const ch = await freshChannel(seed, 'pause');
        const name = uniq(seed, 'pausebot');
        const bot = await makeBot(seed, name, [ch.id]);
        const before = await bot.api.req('POST', `/channels/${ch.id}/messages`, { content: `Before pause ${seed.runTag}` });
        expect(before.status).toBe(201);

        await openBots(page);
        const row = botRow(page, name);
        page.once('dialog', d => { expect(d.type()).toBe('prompt'); void d.accept('e2e pause'); });
        const pauseRes = page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/servers/${seed.serverId}/bots/${bot.botId}/pause`);
        await row.getByRole('button', { name: 'Pause', exact: true }).click();
        expect((await pauseRes).status()).toBe(200);
        const badge = row.getByText('PAUSED', { exact: true });
        await expect(badge).toBeVisible();
        await snap(page, ti, 'ID-05.bot-pause', '01-paused', 'A bot row marked PAUSED with a Resume button', { ready: badge });
        const listed = ((await owner.ok('GET', `/servers/${seed.serverId}/bots`)) as any[]).find(b => b.id === bot.botId);
        expect(listed.pausedAt).toBeTruthy();
        expect(listed.pausedReason).toBe('e2e pause');

        const refused = await bot.api.req('POST', `/channels/${ch.id}/messages`, { content: `While paused ${seed.runTag}` });
        expect([refused.status, refused.data?.error]).toEqual([423, 'bot_paused']);
        const rows = (await owner.ok('GET', `/channels/${ch.id}/messages?limit=10`)) as any[];
        expect(rows.map(r => r.content), 'no message row from the paused post').toEqual([`Before pause ${seed.runTag}`]);
        expect((await bot.api.req('GET', `/channels/${ch.id}/messages`)).status, 'reading still works').toBe(200);

        const resumeRes = page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/servers/${seed.serverId}/bots/${bot.botId}/pause`);
        await row.getByRole('button', { name: 'Resume', exact: true }).click();
        expect((await resumeRes).status()).toBe(200);
        await expect(badge).toHaveCount(0);
        expect((await bot.api.req('POST', `/channels/${ch.id}/messages`, { content: `After resume ${seed.runTag}` })).status).toBe(201);
    });
});

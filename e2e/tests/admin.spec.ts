/**
 * Instance admin and moderation (beta-test-plan §2.2 "Admin and moderation"). These change
 * instance-wide state: the registration policy (to queue pending users), the file size limit,
 * and bans. Each original value is read first and put back in a finally; users that get banned
 * or rejected are run-tagged throwaways (bans have no undo: there is no unban endpoint).
 * Provider terms (`ID-06.provider-terms`) is covered in settings.spec.ts.
 */
import type { Page } from '@playwright/test';
import { test, expect, apis, openChannel } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { e2eEnv } from '../lib/env';
import { freshChannel } from '../lib/helpers';
import {
    fileSettings, findThrowaway, loginStatus, registerThrowaway, restoreFileSettings, withPolicy,
    FILE_SETTING_KEYS, type Throwaway,
} from '../lib/throwaway';

type Owner = ReturnType<typeof apis>['owner'];

const MB = 1024 * 1024;

async function adminUser(owner: Owner, username: string) {
    const r = (await owner.ok('GET', `/admin/users?search=${encodeURIComponent(username)}`)) as any;
    return (r.users as any[]).find(u => u.username === username) ?? null;
}

async function isMember(owner: Owner, serverId: string, userId: string) {
    return ((await owner.ok('GET', `/servers/${serverId}/members`)) as any[]).some(m => String(m.id).trim() === userId);
}

/** The number shown in a dashboard stat card. */
async function statValue(page: Page, label: string): Promise<number> {
    const card = page.locator('div.bg-surface').filter({ has: page.getByText(label, { exact: true }) });
    const text = await card.locator('p.text-2xl').innerText();
    expect(text.trim(), `${label} is a number`).toMatch(/^\d+$/);
    return Number(text.trim());
}

async function upload(api: Owner, channelId: string, name: string, bytes: Buffer, mime = 'text/plain') {
    const fd = new FormData();
    fd.append('channel_id', channelId);
    fd.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), name);
    return api.req('POST', '/files/upload', fd);
}

const totalFiles = async (owner: Owner) => ((await owner.ok('GET', '/admin/storage')) as any).totalFiles as number;

test.describe('instance admin', () => {
    test('[ID-06.admin-stats] the dashboard shows the user and pending counts the API reports', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const before = (await owner.ok('GET', '/admin/stats')) as any;
        await page.goto('/admin');
        await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 });
        const total = await statValue(page, 'Total Users');
        const pending = await statValue(page, 'Pending Approvals');
        const after = (await owner.ok('GET', '/admin/stats')) as any;
        // Other data can change between the two reads, so the shown value must lie between them
        expect(total).toBeGreaterThanOrEqual(Math.min(before.totalUsers, after.totalUsers));
        expect(total).toBeLessThanOrEqual(Math.max(before.totalUsers, after.totalUsers));
        expect(total, 'at least owner-e2e and member-e2e').toBeGreaterThanOrEqual(2);
        expect(pending).toBeGreaterThanOrEqual(Math.min(before.pendingCount, after.pendingCount));
        expect(pending).toBeLessThanOrEqual(Math.max(before.pendingCount, after.pendingCount));
        // The page shows a review link exactly when something is pending
        await expect(page.getByRole('link', { name: 'Review pending users' })).toHaveCount(pending > 0 ? 1 : 0);
        test.info().annotations.push({ type: 'note', description: `serverCount (${after.serverCount}) is returned by GET /admin/stats but the dashboard does not show it` });
        await snap(page, ti, 'ID-06.admin-stats', '01-dashboard', 'An admin dashboard with a Total Users count and a Pending Approvals count',
            { ready: page.getByText('Total Users', { exact: true }) });
    });

    test('[ID-06.pending-queue] pending queue: reject deletes the account, approve activates it and joins the instance server', async ({ page, seed }) => {
        const { owner } = apis(seed);
        const statsBefore = (await owner.ok('GET', '/admin/stats')) as any;
        let keep!: Throwaway;
        let drop!: Throwaway;
        try {
            await withPolicy(owner, 'approval', async () => {
                keep = await registerThrowaway(seed, 'q-appr');
                drop = await registerThrowaway(seed, 'q-rej');
            });
            expect([keep.status, drop.status]).toEqual(['pending', 'pending']);

            // Dashboard: both counts went up by two
            await page.goto('/admin');
            await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 });
            expect(await statValue(page, 'Total Users')).toBe(statsBefore.totalUsers + 2);
            expect(await statValue(page, 'Pending Approvals')).toBe(statsBefore.pendingCount + 2);
            await page.getByRole('link', { name: 'Review pending users' }).click();
            await page.waitForURL(/\/admin\/pending/);
            await expect(page.getByRole('heading', { name: 'Pending Users' })).toBeVisible();
            const card = (u: Throwaway) => page.locator('div.bg-surface').filter({ hasText: u.username });
            await expect(card(keep)).toBeVisible();
            await expect(card(drop)).toBeVisible();

            // Reject: a confirmation, then the account is gone
            await card(drop).getByRole('button', { name: 'Reject' }).click();
            await expect(page.getByText(`Are you sure you want to reject ${drop.username}? This will delete their account.`)).toBeVisible();
            const rejected = page.waitForResponse(r => new URL(r.url()).pathname === `/admin/reject-user/${drop.id}`);
            await page.getByRole('button', { name: 'Reject', exact: true }).last().click();
            expect((await rejected).status()).toBe(200);
            await expect(card(drop)).toHaveCount(0);
            expect(await adminUser(owner, drop.username), 'rejected account deleted').toBeNull();
            expect((await loginStatus(drop.username, drop.password)).status).toBe(401);

            // Approve: active, a member of the instance server, can log in (fails until #158)
            const approved = page.waitForResponse(r => new URL(r.url()).pathname === `/admin/approve-user/${keep.id}`);
            await card(keep).getByRole('button', { name: 'Approve' }).click();
            expect((await approved).status()).toBe(200);
            await expect(card(keep)).toHaveCount(0);
            await expect(page.locator('p.text-danger')).toHaveCount(0);
            expect((await adminUser(owner, keep.username))?.accountStatus).toBe('active');
            expect(await isMember(owner, seed.serverId, keep.id)).toBe(true);
            expect((await loginStatus(keep.username, keep.password)).status).toBe(200);

            const statsAfter = (await owner.ok('GET', '/admin/stats')) as any;
            expect(statsAfter.totalUsers).toBe(statsBefore.totalUsers + 1);
            expect(statsAfter.pendingCount).toBe(statsBefore.pendingCount);
        } finally {
            // Throwaways left pending (an approve or reject that failed) are rejected, so the queue holds nothing of ours
            for (const u of [keep, drop]) {
                const left = u ? await adminUser(owner, u.username) : null;
                if (left?.accountStatus === 'pending') await owner.req('POST', `/admin/reject-user/${left.id}`);
            }
        }
    });

    test('[ID-06.ban-disconnects] banning a user closes their open page\'s socket and signs them out; they cannot log in', async ({ page, browser, seed }, ti) => {
        const { owner } = apis(seed);
        // The user the queue test approved, or a new one under the current (open) policy
        const u = await findThrowaway(owner, seed, 'q-appr') ?? await registerThrowaway(seed, 'ban');
        expect(u.status, 'the ban target is an active throwaway').toBe('active');
        test.info().annotations.push({ type: 'note', description: `banned throwaway user ${u.username}; there is no unban endpoint (issue #9), so it stays banned` });

        const ctx = await browser.newContext({ baseURL: e2eEnv().baseURL, storageState: { cookies: [], origins: [] } });
        const victim = await ctx.newPage();
        const sockets: { url: string; closed: boolean }[] = [];
        victim.on('websocket', ws => {
            const rec = { url: ws.url(), closed: false };
            sockets.push(rec);
            ws.on('close', () => { rec.closed = true; });
        });
        const io = () => sockets.filter(s => s.url.includes('/socket.io/'));
        try {
            await victim.goto('/login');
            await victim.getByLabel('Username or email').fill(u.username);
            await victim.getByLabel('Password').fill(u.password);
            await victim.getByRole('button', { name: 'Sign in', exact: true }).click();
            await victim.waitForURL(/\/app/, { timeout: 20_000 });
            await expect(victim.getByPlaceholder(/^Message #/)).toBeVisible({ timeout: 20_000 });
            await expect.poll(() => io().filter(s => !s.closed).length, { message: 'victim has an open socket' }).toBeGreaterThan(0);

            // The owner bans from All Users
            await page.goto('/admin/users');
            await expect(page.getByRole('heading', { name: 'All Users' })).toBeVisible({ timeout: 15_000 });
            await page.getByPlaceholder('Search users...').fill(u.username);
            const row = page.locator('tbody tr').filter({ hasText: u.username });
            await expect(row).toHaveCount(1);
            await row.getByRole('button', { name: 'Ban' }).click();
            await expect(page.getByText(`Are you sure you want to ban ${u.username}?`)).toBeVisible();
            const banned = page.waitForResponse(r => new URL(r.url()).pathname === `/admin/users/${u.id}/ban`);
            await page.getByRole('button', { name: 'Ban', exact: true }).last().click();
            expect((await banned).status()).toBe(200);
            await expect(page.getByText('Account banned')).toBeVisible();
            await expect(row.getByText('Banned', { exact: true })).toBeVisible();
            await snap(page, ti, 'ID-06.ban-disconnects', '01-admin-banned', 'An admin user table where one user is marked Banned, with an "Account banned" note',
                { ready: page.getByText('Account banned') });

            // The banned user's page: socket closed by the server, signed out to /login
            await expect.poll(() => io().every(s => s.closed), { message: 'victim socket closed', timeout: 15_000 }).toBe(true);
            await victim.waitForURL(/\/login/, { timeout: 15_000 });
            expect((await ctx.request.get('/auth/session')).status(), 'the banned session is refused').not.toBe(200);

            // Signing in again is refused with the suspended message
            await victim.getByLabel('Username or email').fill(u.username);
            await victim.getByLabel('Password').fill(u.password);
            await victim.getByRole('button', { name: 'Sign in', exact: true }).click();
            await expect(victim.getByText('Your account has been suspended. Contact an administrator.')).toBeVisible();
            await snap(victim, ti, 'ID-06.ban-disconnects', '02-victim-login', 'A login page saying the account has been suspended',
                { ready: victim.getByText('Your account has been suspended. Contact an administrator.') });
            const api = await loginStatus(u.username, u.password);
            expect([api.status, api.error, api.token]).toEqual([403, 'account_suspended', undefined]);
            expect((await adminUser(owner, u.username))?.accountStatus).toBe('suspended');
        } finally {
            await ctx.close();
        }
    });

    test('[ID-06.storage-max-size] max file size 1 MB in Storage settings: a 2 MB upload is refused (413) and no file is stored', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const original = await fileSettings(owner);
        test.info().annotations.push({ type: 'setting', description: `files.max_size_bytes ${original['files.max_size_bytes']} -> ${MB} (all file settings restored after)` });
        // "Off" retention and "no quota" are null. A 0 here is #155: a null saved through
        // PATCH /admin/settings/files is stored as 0, and quota 0 makes GET /admin/storage a 500.
        for (const k of ['files.retention_days', 'files.storage_quota_bytes']) {
            expect.soft(original[k] === null || (typeof original[k] === 'number' && (original[k] as number) >= 1), `${k} is null or >= 1 (got ${JSON.stringify(original[k])})`).toBe(true);
        }
        const ch = await freshChannel(seed, 'size');
        const twoMb = Buffer.alloc(2 * MB, 'a');
        try {
            // Set through the API, not the page's Save button: the page saves every field, and its
            // "Off (keep forever)" retention (null) is stored as 0 by the API (Ajv coercion), which
            // can't be undone through the API. The page is checked to show the new limit instead.
            await owner.ok('PATCH', '/admin/settings/files', { 'files.max_size_bytes': MB });
            await page.goto('/settings/storage');
            await expect(page.getByRole('heading', { name: 'File Storage' })).toBeVisible({ timeout: 15_000 });
            await expect(page.getByLabel('Max File Size (MB)')).toHaveValue('1');
            await expect(page.getByText('1,048,576 bytes')).toBeVisible();
            await expect(page.getByText('Total Files', { exact: true }), 'storage stats load').toBeVisible();
            await snap(page, ti, 'ID-06.storage-max-size', '01-settings', 'A file storage settings page showing storage usage and a max file size of 1 MB',
                { ready: page.getByText('1,048,576 bytes') });
            const now = await fileSettings(owner);
            expect(now['files.max_size_bytes']).toBe(MB);
            for (const k of FILE_SETTING_KEYS.filter(k => k !== 'files.max_size_bytes')) {
                expect(JSON.stringify(now[k]), `${k} unchanged`).toBe(JSON.stringify(original[k]));
            }

            const filesBefore = await totalFiles(owner);
            await openChannel(page, ch.id, ch.name);
            const res = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/files/upload');
            await page.locator('input[type="file"]').setInputFiles({ name: 'two-mb.txt', mimeType: 'text/plain', buffer: twoMb });
            const up = await res;
            const body = await up.json().catch(() => ({}));
            test.info().annotations.push({ type: 'note', description: `browser upload -> ${up.status()} ${JSON.stringify(body)}` });
            expect(up.status()).toBe(413);
            await expect(page.getByText(/too large|maximum allowed size/i).first()).toBeVisible();

            const direct = await upload(owner, ch.id, 'two-mb.txt', twoMb);
            expect(direct.status).toBe(413);
            expect(await totalFiles(owner), 'no file row was created').toBe(filesBefore);
            expect(((await owner.ok('GET', `/channels/${ch.id}/messages`)) as any[]).length, 'nothing was posted').toBe(0);
        } finally {
            await restoreFileSettings(owner, original);
        }
    });

    test('[ID-06.storage-authority] the admin max size is the only cap: under a 3 MB limit a 2 MB file is accepted', async ({ seed }) => {
        // CLAUDE.md: "All file limits ... are admin-configurable via instance_settings, no hardcoded
        // caps anywhere else." A 2 MB file under a 3 MB setting must be stored. Fails until #157
        // (@fastify/multipart's 1 MiB default fileSize refuses it first).
        const { owner } = apis(seed);
        const original = await fileSettings(owner);
        test.info().annotations.push({ type: 'setting', description: `files.max_size_bytes ${original['files.max_size_bytes']} -> ${3 * MB} (restored after)` });
        const ch = await freshChannel(seed, 'size-ok');
        try {
            await owner.ok('PATCH', '/admin/settings/files', { 'files.max_size_bytes': 3 * MB });
            expect((await fileSettings(owner))['files.max_size_bytes']).toBe(3 * MB);
            const before = await totalFiles(owner);
            const r = await upload(owner, ch.id, 'two-mb-ok.txt', Buffer.alloc(2 * MB, 'b'));
            expect(r.status, JSON.stringify(r.data)).toBe(201);
            expect(r.data.size).toBe(2 * MB);
            expect(await totalFiles(owner)).toBe(before + 1);
            // Over the setting is still refused by the setting's own check
            const over = await upload(owner, ch.id, 'four-mb.txt', Buffer.alloc(4 * MB, 'c'));
            expect([over.status, over.data?.error]).toEqual([413, 'File exceeds maximum allowed size']);
        } finally {
            await restoreFileSettings(owner, original);
        }
    });

    test('[ID-06.moderator-kick] Members page: a moderator kicks member-e2e', async () => {
        test.skip(true, 'not_applicable: no kick endpoint exists. src/routes has no route that removes a server member (servers.ts, roles.ts and admin.ts only add members, assign roles or ban instance-wide); the Moderation > Members page (agora-ui/src/features/moderation/MemberList.tsx) is a read-only table. Tracked as issue #9 "Add kick/ban/unban endpoints and moderation actions UI".');
    });
});

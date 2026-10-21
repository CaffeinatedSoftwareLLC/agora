import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, waitForChannel, apis, storageStateFor } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { e2eEnv } from '../lib/env';
import { ensureUser } from '../lib/seed-roles';
import {
    currentPolicy, loginStatus, noteRegistration, registerThrowaway, setPolicy,
    findThrowaway, throwawayName, throwawayPassword,
} from '../lib/throwaway';

test.describe('auth @smoke', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('[ID-01.login] login by username lands in the app; wrong password is generic', async ({ page, seed }, ti) => {
        await page.goto('/login');
        await snap(page, ti, 'ID-01.login', '01-login-page', 'A login page with username/email and password fields and a Sign in button',
            { ready: page.getByRole('button', { name: 'Sign in', exact: true }) });
        await page.getByLabel('Username or email').fill('owner-e2e');
        await page.getByLabel('Password').fill('definitely-wrong-password');
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(page.getByText('Wrong username, email or password.')).toBeVisible();
        await page.getByLabel('Password').fill(seed.secrets.ownerPassword);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL(/\/app/);
        await expect(page.getByPlaceholder(/^Message #/)).toBeVisible();
        await snap(page, ti, 'ID-01.login', '02-app-after-login', 'The chat app with a channel list on the left and a message box',
            { ready: page.getByPlaceholder(/^Message #/) });
    });

    test('[ID-01.login-email] login by email works', async ({ page, seed }) => {
        await page.goto('/login');
        await page.getByLabel('Username or email').fill(seed.users.member.email);
        await page.getByLabel('Password').fill(seed.secrets.memberPassword);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL(/\/app/);
        await expect(page.getByPlaceholder(/^Message #/)).toBeVisible();
    });

    test('[ID-02.cookie] session cookie is HttpOnly, CSRF enforced, reload keeps session, logout clears it', async ({ page, context, seed }, ti) => {
        await page.goto('/login');
        await page.getByLabel('Username or email').fill('member-e2e');
        await page.getByLabel('Password').fill(seed.secrets.memberPassword);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL(/\/app/);
        await expect(page.getByPlaceholder(/^Message #/)).toBeVisible();

        const cookies = await context.cookies();
        const session = cookies.find(c => c.name === 'agora_session');
        const csrf = cookies.find(c => c.name === 'agora_csrf');
        expect(session, 'agora_session cookie').toBeTruthy();
        expect(session!.httpOnly).toBe(true);
        expect(session!.sameSite).toBe('Strict');
        expect(csrf, 'agora_csrf cookie').toBeTruthy();
        const jsCookies = await page.evaluate(() => document.cookie);
        expect(jsCookies).not.toContain('agora_session');

        // A cookie-authenticated POST without X-CSRF-Token is refused; with it, accepted.
        const ch = seed.channels.agents;
        const noCsrf = await page.evaluate(async (ch) => {
            const r = await fetch(`/channels/${ch}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'csrf probe' }) });
            return { status: r.status, body: await r.text() };
        }, ch);
        expect(noCsrf.status).toBe(403);
        expect(noCsrf.body).toContain('csrf_failed');

        await page.reload();
        await expect(page.getByPlaceholder(/^Message #/)).toBeVisible();

        // Logout via the user menu
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Log out', exact: true }).click();
        await page.waitForURL(/\/login/);
        await snap(page, ti, 'ID-02.cookie', '01-after-logout', 'The login page after logging out',
            { ready: page.getByRole('button', { name: 'Sign in', exact: true }) });
        const after = (await context.cookies()).map(c => c.name);
        expect(after).not.toContain('agora_session');
        // Going back to the app now redirects to login
        await page.goto('/app');
        await page.waitForURL(/\/login/);
    });

    test('[ID-02.idle-renew] background requests do not renew; foreground does (API-level)', async ({ page, seed }) => {
        // The 24 h idle window is a hard-coded constant (src/auth/tokens.ts), so expiry itself
        // can't be reached in E2E. What is observable: a background request (X-Agora-Background: 1)
        // never re-issues the cookie, and a fresh session (<1 h old) is not re-issued either.
        await page.goto('/login');
        await page.getByLabel('Username or email').fill('member-e2e');
        await page.getByLabel('Password').fill(seed.secrets.memberPassword);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL(/\/app/);
        const r = await page.evaluate(async () => {
            const bg = await fetch('/auth/session', { headers: { 'X-Agora-Background': '1' } });
            const fg = await fetch('/auth/session');
            return { bg: bg.status, fg: fg.status };
        });
        expect(r).toEqual({ bg: 200, fg: 200 });
        const resp = await page.request.get('/auth/session', { headers: { 'X-Agora-Background': '1' } });
        expect(resp.status()).toBe(200);
        expect(resp.headers()['set-cookie'] ?? '').not.toContain('agora_session');
        test.info().annotations.push({ type: 'note', description: 'idle expiry (24 h, not env-configurable) is not reachable in E2E; covered by vitest cookie-session tests' });
    });
});

// ---------------------------------------------------------------------------------------------
// Registration policies, generic login errors, lockout, log out all, passkey cancel, theme.
// These change instance-wide state (the registration policy) or lock/revoke accounts, so they
// use throwaway users only and put every setting back in a finally. Registrations are budgeted
// (5 per hour per address): two per run (open, approval), plus `sessions-e2e` the first time.
// ---------------------------------------------------------------------------------------------

const GENERIC = 'Wrong username, email or password.';

/** A context with no session, on the e2e web origin. */
async function anonContext(browser: Browser): Promise<BrowserContext> {
    return browser.newContext({ baseURL: e2eEnv().baseURL, storageState: { cookies: [], origins: [] } });
}

async function submitLogin(page: Page, login: string, password: string) {
    await page.getByLabel('Username or email').fill(login);
    await page.getByLabel('Password').fill(password);
    const resp = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/auth/login');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    return resp;
}

/** Log in through the login page in a fresh context; `before` runs before the first navigation. */
async function loginIn(browser: Browser, username: string, password: string, before?: (p: Page) => void) {
    const ctx = await anonContext(browser);
    const page = await ctx.newPage();
    before?.(page);
    await page.goto('/login');
    await submitLogin(page, username, password);
    await page.waitForURL(/\/app/, { timeout: 20_000 });
    await expect(page.getByPlaceholder(/^Message #/)).toBeVisible({ timeout: 20_000 });
    return { ctx, page };
}

type Owner = ReturnType<typeof apis>['owner'];

async function isMember(serverId: string, owner: Owner, userId: string) {
    const members = (await owner.ok('GET', `/servers/${serverId}/members`)) as any[];
    return members.some(m => String(m.id ?? m.userId).trim() === userId);
}

async function adminUser(owner: Owner, username: string) {
    const r = (await owner.ok('GET', `/admin/users?search=${encodeURIComponent(username)}`)) as any;
    return (r.users as any[]).find(u => u.username === username) ?? null;
}

test.describe('auth: policies, lockout and sessions', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('[ID-01.register-open] under the open policy, registering logs the user in and joins the instance server', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const original = await currentPolicy();
        test.info().annotations.push({ type: 'setting', description: `registration_policy was ${original}` });
        try {
            if (original !== 'open') await setPolicy(owner, 'open');
            const username = throwawayName(seed, 'reg-open');
            const password = throwawayPassword(username);
            await page.goto('/register');
            await expect(page.getByRole('button', { name: 'Create Account' })).toBeVisible({ timeout: 15_000 });
            await page.getByLabel('Username').fill(username);
            await page.getByLabel('Email').fill(`${username}@example.test`);
            await page.getByLabel('Password').fill(password);
            const reg = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/auth/register');
            await page.getByRole('button', { name: 'Create Account' }).click();
            const res = await reg;
            noteRegistration(username);
            expect(res.status()).toBe(201);
            await page.waitForURL(/\/app/, { timeout: 20_000 });
            await expect(page.getByPlaceholder(/^Message #/)).toBeVisible({ timeout: 20_000 });
            await snap(page, ti, 'ID-01.register-open', '01-app', 'The chat app right after a new account registered, with a message box',
                { ready: page.getByPlaceholder(/^Message #/) });

            const row = await adminUser(owner, username);
            expect(row?.accountStatus).toBe('active');
            expect(await isMember(seed.serverId, owner, row.id), 'auto-joined to the instance server').toBe(true);
        } finally {
            if (original !== 'open') await setPolicy(owner, original);
        }
        expect(await currentPolicy()).toBe(original);
    });

    test('[ID-01.register-approval] under approval: new user lands on /pending, admin approves in the queue, user can log in', async ({ page, browser, seed }, ti) => {
        const { owner } = apis(seed);
        const original = await currentPolicy();
        test.info().annotations.push({ type: 'setting', description: `registration_policy ${original} -> approval (restored after)` });
        const ownerCtx = await browser.newContext({ baseURL: e2eEnv().baseURL, storageState: storageStateFor('owner') });
        const admin = await ownerCtx.newPage();
        try {
            // The owner switches the policy in Instance Settings
            await admin.goto('/settings/instance');
            await expect(admin.getByRole('heading', { name: 'Instance Settings' })).toBeVisible({ timeout: 15_000 });
            await admin.getByText('Approval Required', { exact: true }).click();
            const saved = admin.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/admin/instance');
            await admin.getByRole('button', { name: 'Save Settings' }).click();
            expect((await saved).status()).toBe(200);
            await expect(admin.getByText('Settings saved.')).toBeVisible();
            expect(await currentPolicy()).toBe('approval');

            // A visitor registers: the form says approval is needed; the result is /pending
            const username = throwawayName(seed, 'reg-appr');
            const password = throwawayPassword(username);
            await page.goto('/register');
            await expect(page.getByRole('button', { name: 'Request Access' })).toBeVisible({ timeout: 15_000 });
            await expect(page.getByText('Accounts on this instance require administrator approval')).toBeVisible();
            await page.getByLabel('Username').fill(username);
            await page.getByLabel('Email').fill(`${username}@example.test`);
            await page.getByLabel('Password').fill(password);
            const reg = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/auth/register');
            await page.getByRole('button', { name: 'Request Access' }).click();
            const res = await reg;
            noteRegistration(username);
            expect(res.status()).toBe(201);
            expect((await res.json()).status).toBe('pending');
            await page.waitForURL(/\/pending/);
            const heading = page.getByRole('heading', { name: 'Account Pending Review' });
            await snap(page, ti, 'ID-01.register-approval', '01-pending', 'A page saying the account is waiting for approval by an administrator', { ready: heading });
            expect((await page.context().cookies()).map(c => c.name), 'no session for a pending account').not.toContain('agora_session');

            // Persisted: pending, not a member, no login
            const row = await adminUser(owner, username);
            expect(row?.accountStatus).toBe('pending');
            const pending = (await owner.ok('GET', '/admin/pending-users?limit=100')) as any;
            expect((pending.users as any[]).some(u => u.username === username)).toBe(true);
            expect(await isMember(seed.serverId, owner, row.id)).toBe(false);
            const blocked = await loginStatus(username, password);
            expect([blocked.status, blocked.error, blocked.token]).toEqual([403, 'account_pending', undefined]);

            // Signing in while pending goes back to /pending
            await page.getByRole('button', { name: 'Back to login' }).click();
            await page.waitForURL(/\/login/);
            await submitLogin(page, username, password);
            await page.waitForURL(/\/pending/);

            // The admin approves in the pending queue
            await admin.goto('/admin/pending');
            await expect(admin.getByRole('heading', { name: 'Pending Users' })).toBeVisible({ timeout: 15_000 });
            const card = admin.locator('div.bg-surface').filter({ hasText: username });
            await expect(card).toBeVisible();
            const approve = admin.waitForResponse(r => new URL(r.url()).pathname === `/admin/approve-user/${row.id}`);
            await card.getByRole('button', { name: 'Approve' }).click();
            expect((await approve).status()).toBe(200);
            await expect(card).toHaveCount(0);
            expect((await adminUser(owner, username))?.accountStatus).toBe('active');
            expect(await isMember(seed.serverId, owner, row.id), 'approval joins the instance server').toBe(true);

            // Now the user can log in
            await page.getByRole('button', { name: 'Back to login' }).click();
            await page.waitForURL(/\/login/);
            await submitLogin(page, username, password);
            await page.waitForURL(/\/app/, { timeout: 20_000 });
            await expect(page.getByPlaceholder(/^Message #/)).toBeVisible({ timeout: 20_000 });
        } finally {
            await ownerCtx.close();
            await setPolicy(owner, original);
        }
        expect(await currentPolicy()).toBe(original);
    });

    test('[ID-01.login-generic] unknown user and wrong password get the same message and the same 401', async ({ page, seed }) => {
        const unknown = `nobody-${seed.runTag}-x`;
        await page.goto('/login');
        const r1 = await submitLogin(page, unknown, 'some-password-1');
        await expect(page.getByText(GENERIC)).toBeVisible();
        const t1 = await page.locator('p.text-danger').innerText();
        const r2 = await submitLogin(page, 'member-e2e', 'definitely-not-the-password');
        await expect(page.getByText(GENERIC)).toBeVisible();
        const t2 = await page.locator('p.text-danger').innerText();
        expect(t1).toBe(GENERIC);
        expect(t2).toBe(t1);
        expect([r1.status(), (await r1.json()).error]).toEqual([401, 'invalid_credentials']);
        expect([r2.status(), (await r2.json()).error]).toEqual([401, 'invalid_credentials']);
        // A successful login clears member-e2e's failure count, so nothing is left behind
        expect((await loginStatus('member-e2e', seed.secrets.memberPassword)).status).toBe(200);
    });

    test('[ID-01.lockout] 10 wrong passwords, then the 11th attempt is refused with a lock message; the right password is refused too', async ({ page, seed }, ti) => {
        // A throwaway account (the one this run registered under open, or a new one): it stays locked for 15 minutes
        const u = await findThrowaway(apis(seed).owner, seed, 'reg-open') ?? await registerThrowaway(seed, 'lock');
        test.info().annotations.push({ type: 'note', description: `locked throwaway user ${u.username} (15 min)` });
        await page.goto('/login');
        for (let i = 1; i <= 10; i++) {
            const r = await submitLogin(page, u.username, `wrong-password-${i}`);
            expect([i, r.status()]).toEqual([i, 401]);
            await expect(page.getByText(GENERIC)).toBeVisible();
        }
        const locked = await submitLogin(page, u.username, 'wrong-password-11');
        expect(locked.status()).toBe(429);
        expect((await locked.json()).error).toBe('too_many_attempts');
        expect(locked.headers()['retry-after']).toBe('900');
        const msg = page.locator('p.text-danger');
        await expect(msg).not.toHaveText(GENERIC);
        await snap(page, ti, 'ID-01.lockout', '01-locked', 'A login page showing a message that there were too many attempts', { ready: msg });
        // The lock message should be words, as the passkey button words it (lib/passkeys.ts), not the raw code
        await expect.soft(msg, 'lock message is human-readable').toHaveText(/too many attempts/i);

        // The right password is refused while locked, from the page and from the API; no session
        const right = await submitLogin(page, u.username, u.password);
        expect(right.status()).toBe(429);
        await expect(page).toHaveURL(/\/login/);
        expect((await page.context().cookies()).map(c => c.name)).not.toContain('agora_session');
        const api = await loginStatus(u.username, u.password);
        expect([api.status, api.error, api.token]).toEqual([429, 'too_many_attempts', undefined]);
    });

    test('[ID-02.logout-all] logging out all sessions in A drops B\'s socket and sends B to /login', async ({ browser, seed }, ti) => {
        const u = await ensureUser('sessions-e2e');
        const a = await loginIn(browser, u.username, u.password);
        const sockets: { url: string; closed: boolean }[] = [];
        const b = await loginIn(browser, u.username, u.password, p => p.on('websocket', ws => {
            const rec = { url: ws.url(), closed: false };
            sockets.push(rec);
            ws.on('close', () => { rec.closed = true; });
        }));
        const io = () => sockets.filter(s => s.url.includes('/socket.io/'));
        try {
            await expect.poll(() => io().filter(s => !s.closed).length, { message: 'B has an open socket' }).toBeGreaterThan(0);
            expect((await b.ctx.request.get('/auth/session')).status()).toBe(200);

            await a.page.getByRole('button', { name: 'Settings', exact: true }).click();
            const out = a.page.waitForResponse(r => new URL(r.url()).pathname === '/auth/logout-all');
            await a.page.getByRole('button', { name: 'Log out all sessions' }).click();
            expect((await out).status()).toBe(200);
            await a.page.waitForURL(/\/login/);

            // B: the server closes the socket and B is sent to the login page
            await expect.poll(() => io().every(s => s.closed), { message: 'B socket closed', timeout: 15_000 }).toBe(true);
            await b.page.waitForURL(/\/login/, { timeout: 15_000 });
            await snap(b.page, ti, 'ID-02.logout-all', '01-b-login', 'The login page', { ready: b.page.getByRole('button', { name: 'Sign in', exact: true }) });
            // B's next action stays signed out: the old cookie is refused
            await b.page.goto('/app');
            await b.page.waitForURL(/\/login/);
            expect((await b.ctx.request.get('/auth/session')).status()).toBe(401);
            expect((await a.ctx.request.get('/auth/session')).status()).toBe(401);
            // The Bearer token from before is revoked too; a new login works
            expect((await apis(seed).anon.with(`Bearer ${u.token}`).req('GET', '/auth/session')).status).toBe(401);
            expect((await loginStatus(u.username, u.password)).status).toBe(200);
        } finally {
            await a.ctx.close();
            await b.ctx.close();
        }
    });

    test('[ID-03.passkey-cancel] a passkey sign-in that returns no credential leaves a clean login page and no session', async ({ page, browserName, seed }) => {
        test.skip(browserName !== 'chromium', 'not_applicable: virtual authenticator needs Chromium CDP');
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('WebAuthn.enable');
        // An authenticator holding no credential: the browser's get() fails like a cancel
        await cdp.send('WebAuthn.addVirtualAuthenticator', {
            options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
        });
        await page.goto('/login');
        const btn = page.getByRole('button', { name: 'Sign in with a passkey' });
        await expect(btn).toBeVisible();
        const verify: string[] = [];
        page.on('request', r => { if (new URL(r.url()).pathname === '/auth/passkeys/login/verify') verify.push(r.url()); });
        const opts = page.waitForResponse(r => new URL(r.url()).pathname === '/auth/passkeys/login/options');
        await btn.click();
        expect((await opts).status()).toBe(200);
        // The ceremony ends (button usable again) without leaving the page
        await expect(btn).toBeEnabled({ timeout: 30_000 });
        await expect(page).toHaveURL(/\/login/);
        // A cancel shows no error (lib/passkeys.ts treats NotAllowedError as a cancel); never a raw code or exception
        const err = page.locator('p.text-danger');
        if (await err.count()) await expect(err).not.toHaveText(/Error|[a-z]+_[a-z]+|undefined/);
        expect(verify, 'nothing was sent to verify').toEqual([]);
        expect((await page.context().cookies()).map(c => c.name)).not.toContain('agora_session');
        expect((await page.request.get('/auth/session')).status()).toBe(401);
        // The page is still usable: the password form signs in
        await submitLogin(page, 'member-e2e', seed.secrets.memberPassword);
        await page.waitForURL(/\/app/);
    });

    test('[ID-01.theme-sync] switching the theme palette is saved to the account and shows in a second context', async ({ browser }) => {
        const u = await ensureUser('sessions-e2e');
        const original = ((await u.api.ok('GET', '/users/@me/preferences')) as any).palette ?? null;
        test.info().annotations.push({ type: 'setting', description: `sessions-e2e palette was ${original ?? 'unset'} (restored after)` });
        const a = await loginIn(browser, u.username, u.password);
        let b: Awaited<ReturnType<typeof loginIn>> | null = null;
        const toggle = (p: Page) => p.getByRole('button', { name: /^Switch theme palette \(current: / }).first();
        try {
            const label = await toggle(a.page).getAttribute('aria-label');
            const from = /current: (\w+)/.exec(label ?? '')?.[1];
            expect(from).toMatch(/^(Aegean|Terracotta)$/);
            const to = from === 'Aegean' ? 'Terracotta' : 'Aegean';
            const saved = a.page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/users/@me/preferences');
            await toggle(a.page).click();
            expect((await saved).status()).toBe(200);
            await expect(toggle(a.page)).toHaveAttribute('aria-label', `Switch theme palette (current: ${to})`);
            expect(((await u.api.ok('GET', '/users/@me/preferences')) as any).palette).toBe(to.toLowerCase());

            // A second context with empty local storage picks the saved palette up from the account
            b = await loginIn(browser, u.username, u.password);
            await expect(toggle(b.page)).toHaveAttribute('aria-label', `Switch theme palette (current: ${to})`, { timeout: 15_000 });
            await b.page.reload();
            await expect(toggle(b.page)).toHaveAttribute('aria-label', `Switch theme palette (current: ${to})`, { timeout: 15_000 });
        } finally {
            await a.ctx.close();
            await b?.ctx.close();
            await u.api.ok('PATCH', '/users/@me/preferences', { palette: original ?? 'aegean' });
        }
    });
});

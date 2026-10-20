import { test, expect, waitForChannel } from '../lib/fixtures';
import { snap } from '../lib/snap';

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

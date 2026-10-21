/**
 * Instance setup (beta-test-plan §2.2 "Setup and auth"). The agora-e2e instance is set up by
 * global-setup on its first run, so the fresh-instance wizard can't be shown here, and this
 * harness must not bring up a second instance for it. What is checked instead: on a set-up
 * instance, setup is refused for a wrong token and for the right one, and no user is created.
 */
import { test, expect, apis } from '../lib/fixtures';
import { e2eEnv } from '../lib/env';
import { throwawayName, throwawayPassword } from '../lib/throwaway';

test.describe('instance setup', () => {
    test('[ID-01.setup-wizard] a fresh instance shows the setup wizard and completes it', async () => {
        test.skip(true, 'not_applicable: the agora-e2e instance is already set up (global-setup does it on the first run); a fresh instance would need a second stack, which this harness must not start. Wizard UI is covered by agora-ui unit tests.');
    });

    test('[ID-01.setup-refused] on a set-up instance, setup is refused (wrong token and right token) and no user is created', async ({ page, seed, sensitive }) => {
        const { owner, anon } = apis(seed);
        const { setupToken } = e2eEnv();
        expect(setupToken, '.env.e2e has AGORA_SETUP_TOKEN').toBeTruthy();
        sensitive.add(setupToken!);

        // The browser shows the app's login page, not the setup wizard
        await page.goto('/');
        await page.waitForURL(/\/app|\/login/);
        await expect(page.getByPlaceholder(/^Message #/)).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText('Set Up Agora')).toHaveCount(0);
        await expect(page.getByLabel('Setup Token')).toHaveCount(0);

        const before = (await owner.ok('GET', '/admin/stats')) as any;
        const status = (await anon.ok('GET', '/instance/status')) as any;
        expect(status.initialized).toBe(true);

        const attempt = async (token: string) => {
            const username = throwawayName(seed, 'setup');
            const r = await anon.req('POST', '/instance/setup', {
                setupToken: token, username, email: `${username}@example.test`, password: throwawayPassword(username),
                instanceName: 'Hijacked', registrationPolicy: 'open',
            });
            return { ...r, username };
        };

        // Wrong token. The "already set up" check runs before the token check
        // (src/routes/instance.ts), so a set-up instance answers 409 for any token: it never
        // tells a caller whether the token was right.
        const wrong = await attempt('not-the-setup-token-' + seed.runTag);
        expect([wrong.status, wrong.data?.error]).toEqual([409, 'instance_already_initialized']);

        // The right token: still refused, the token is single use
        const right = await attempt(setupToken!);
        expect([right.status, right.data?.error]).toEqual([409, 'instance_already_initialized']);

        // Nothing changed: no such users, no new admin, same instance name and policy
        for (const u of [wrong.username, right.username]) {
            const found = (await owner.ok('GET', `/admin/users?search=${encodeURIComponent(u)}`)) as any;
            expect(found.total, `no user ${u}`).toBe(0);
        }
        const after = (await owner.ok('GET', '/admin/stats')) as any;
        expect(after.totalUsers, 'no user was created by the refused setups').toBe(before.totalUsers);
        const statusAfter = (await anon.ok('GET', '/instance/status')) as any;
        expect(statusAfter).toEqual(status);

        // From the page too (same origin, the session cookie goes along): refused the same way
        const fromPage = await page.evaluate(async () => {
            const r = await fetch('/instance/setup', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ setupToken: 'x', username: 'nobody-setup', email: 'nobody-setup@example.test', password: 'password-123' }),
            });
            return { status: r.status, body: await r.text() };
        });
        expect(fromPage.status).toBe(409);
        expect(fromPage.body).toContain('instance_already_initialized');
    });
});

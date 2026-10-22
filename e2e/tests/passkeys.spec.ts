import { test, expect } from '../lib/fixtures';
import { snap } from '../lib/snap';

test.describe('passkeys @smoke', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('[ID-03.passkey] add a passkey with a virtual authenticator, sign in with it, remove it', async ({ page, browserName, seed }, ti) => {
        test.skip(browserName !== 'chromium', 'not_applicable: virtual authenticator needs Chromium CDP');
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('WebAuthn.enable');
        await cdp.send('WebAuthn.addVirtualAuthenticator', {
            options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
        });

        // Password login as member
        await page.goto('/login');
        await page.getByLabel('Username or email').fill('member-e2e');
        await page.getByLabel('Password').fill(seed.secrets.memberPassword);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL(/\/app/);

        await page.goto('/account');
        await expect(page.getByRole('heading', { name: 'Passkeys' })).toBeVisible();
        const keyName = `E2E key ${seed.runTag}`;
        await page.getByLabel('Passkey name').fill(keyName);
        await page.getByRole('button', { name: 'Add a passkey' }).click();
        const item = page.getByRole('list', { name: 'Your passkeys' }).getByRole('listitem').filter({ hasText: keyName });
        await expect(item).toBeVisible({ timeout: 15_000 });
        await snap(page, ti, 'ID-03.passkey', '01-listed', 'An account page listing one passkey', { ready: item });

        // Log out, sign in with the passkey (no password)
        await page.goto('/app');
        await page.getByRole('button', { name: 'Account menu' }).click();
        await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
        await page.waitForURL(/\/login/);
        await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
        await page.waitForURL(/\/app/, { timeout: 15_000 });
        await expect(page.getByPlaceholder(/^Message #/)).toBeVisible();

        // Remove it
        await page.goto('/account');
        page.once('dialog', d => d.accept());
        await page.getByRole('button', { name: `Remove ${keyName}` }).click();
        await expect(item).toHaveCount(0);
    });
});

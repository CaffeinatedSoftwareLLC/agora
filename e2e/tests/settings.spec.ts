import { test, expect, openChannel } from '../lib/fixtures';
import { snap } from '../lib/snap';

test.describe('admin and settings pages @smoke', () => {
    test('[ID-06.provider-terms] provider terms page lists the seeded documents; Check now queues', async ({ page }, ti) => {
        await page.goto('/admin/provider-terms');
        await expect(page.getByRole('heading', { name: 'Provider terms', level: 1 })).toBeVisible({ timeout: 15_000 });
        const rows = page.locator('table tbody tr');
        await expect(rows.first()).toBeVisible();
        expect(await rows.count()).toBeGreaterThanOrEqual(13);
        await snap(page, ti, 'ID-06.provider-terms', '01-list', 'A provider terms dashboard listing documents with their status', { ready: rows.first() });
        const check = page.getByRole('button', { name: 'Check now' });
        if (await check.isEnabled()) {
            await check.click();
            await expect(page.getByText(/Check queued/).first()).toBeVisible();
        } else {
            await expect(page.getByText(/Check queued/).first()).toBeVisible();
        }
    });

    test('[ID-06.admin-reload] hard-loading /admin pages serves the app, not API JSON', async ({ page }) => {
        // nginx proxies any path starting with /admin to the API (regex has no anchor);
        // only /admin/provider-terms is exempted. Reloading the dashboard breaks in prod.
        for (const p of ['/admin', '/admin/users', '/admin/pending']) {
            const res = await page.goto(p);
            expect.soft(res?.headers()['content-type'] ?? '', `${p} content-type`).toContain('text/html');
        }
    });

    test('[AG-10.agents-page] agents settings: auth badges and ChatGPT plan states per profile auth mode', async ({ page, seed }, ti) => {
        const { codexKey, codexSub, codexPlan, claude } = seed.agents;
        const host = `e2e-host-${seed.runTag}`;
        await page.goto('/settings/agents');
        await expect(page.getByRole('heading', { name: 'Agents', level: 2 })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(host).first()).toBeVisible();

        await expect(page.getByTestId(`auth-${claude.name}`)).toContainText('API key');
        await expect(page.getByTestId(`auth-${codexKey.name}`)).toContainText('API key');
        await expect(page.getByTestId(`auth-${codexSub.name}`)).toContainText('subscription (owner only)');
        await expect(page.getByTestId(`auth-${codexPlan.name}`)).toContainText('ChatGPT plan (plan owner only)');

        // Non-siwc codex profiles: no Continue button, an explanation instead
        for (const p of [codexKey, codexSub]) {
            const box = page.getByTestId(`plan-${p.profileId}`);
            await expect(box).toBeVisible();
            await expect(box.getByRole('status')).toContainText('Not connected');
            await expect(box).toContainText("doesn't run this profile with Sign in with ChatGPT");
            await expect(box.getByRole('button', { name: 'Continue with ChatGPT' })).toHaveCount(0);
        }
        const keyBox = page.getByTestId(`plan-${codexKey.profileId}`);
        await keyBox.scrollIntoViewIfNeeded();
        await snap(page, ti, 'AG-10.agents-page', '01-non-siwc', 'An agents settings page where a codex profile shows "Not connected" and an explanation instead of a Continue with ChatGPT button',
            { ready: keyBox });

        // siwc profile: Continue -> Request sent (no host process runs, so it stays there)
        const planBox = page.getByTestId(`plan-${codexPlan.profileId}`);
        await planBox.scrollIntoViewIfNeeded();
        const cont = planBox.getByRole('button', { name: 'Continue with ChatGPT' });
        await expect(cont).toBeVisible();
        await cont.click();
        await expect(planBox.getByRole('status')).toContainText(`Request sent. Waiting for ${host} to pick it up`);
        await snap(page, ti, 'AG-10.agents-page', '02-siwc-requested', 'A ChatGPT plan box saying the request was sent and is waiting for the host', { ready: planBox });
    });

    test('[ID-04.invite-dialog] Invite People shows a fresh code and copies it', async ({ page, context, seed }, ti) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await openChannel(page, seed.channels.general, 'general');
        await page.getByRole('button', { name: 'Invite People' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByRole('heading', { name: 'Invite People' })).toBeVisible();
        const code = dialog.locator('.font-mono').first();
        await expect(code).toHaveText(/^[0-9a-f]{8}$/);
        await snap(page, ti, 'ID-04.invite-dialog', '01-dialog', 'An invite dialog showing a (masked) invite code with a Copy button',
            { ready: code, mask: [code] });
        await dialog.getByRole('button', { name: 'Copy' }).click();
        await expect(dialog.getByRole('button', { name: 'Copied!' })).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await code.innerText());
    });
});

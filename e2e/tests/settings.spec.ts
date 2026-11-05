import { test, expect, openChannel, apis } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { Api } from '../lib/api';
import { e2eEnv } from '../lib/env';
import type { Seed } from '../lib/seed-types';

/**
 * Put the seeded ChatGPT plan profile back to a state where Continue is enabled. An earlier
 * repeat or run left its request pending, and no host process runs to pick it up (#150).
 * Acts as the seeded host: pick up the request, then report the profile signed out.
 */
async function resetPlanRequest(seed: Seed) {
    const { owner } = apis(seed);
    const plans = (await owner.ok('GET', `/servers/${seed.serverId}/agent-plans`)) as any[];
    const plan = plans.find(p => String(p.profileId).trim() === seed.agents.codexPlan.profileId);
    if (!plan || !['requested', 'in_progress', 'disconnect_requested'].includes(plan.status)) return;
    const host = new Api(e2eEnv().apiURL).with(`AgentHost ${seed.secrets.hostToken}`);
    // A request still waiting wins over the host's report, so take it first (oldest first, one per call)
    for (let i = 0; i < 10; i++) {
        const next = await host.req('GET', '/agent-hosts/@me/plan-requests/next');
        if (next.status === 204) break;
        if (next.status !== 200) throw new Error(`plan-requests/next -> ${next.status}`);
    }
    await host.ok('POST', `/agent-hosts/@me/plans/${seed.agents.codexPlan.name}`, { status: 'disconnected' }, [200]);
}

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
        await resetPlanRequest(seed);
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

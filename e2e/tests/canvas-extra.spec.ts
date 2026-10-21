/**
 * Canvas scenarios not in canvas.spec.ts (beta-test-plan §2.2 "Canvas" and "Canvas escape
 * attempts"): version 2 actually renders and the picker switches back, Source and Download,
 * a meta refresh is stripped, and a frame that navigates itself is reset with a notice.
 * Canary requests are intercepted by page.route; nothing leaves the machine.
 */
import { test, expect, apis, openChannel } from '../lib/fixtures';
import { snap } from '../lib/snap';

const CANARY = 'https://egress-canary.agora-e2e.test';
const page1 = (h: string) => `<!doctype html><html><body style="font-family:sans-serif;background:#f4f1ea;color:#222"><h1 id="h">${h}</h1><p>Canvas version test.</p></body></html>`;

test.describe('canvas versions, source, download and navigation escapes', () => {
    test('[UI-05.canvas-versions] v2 renders; v1 is selectable with Go to latest; Source and Download match the version', async ({ page, seed }, ti) => {
        const { bot } = apis(seed);
        const ch = seed.channels.agents, name = `agents-${seed.runTag}`;
        const title = `E2E versions ${seed.runTag} ${Date.now() % 100000}`;
        await bot.ok('POST', `/channels/${ch}/messages`, { content: 'Version 1.', artifact: { title, kind: 'html', content: page1('Version one') } }, [201]);
        const list = (await bot.ok('GET', `/channels/${ch}/artifacts`)) as any;
        const art = (Array.isArray(list) ? list : list.artifacts).find((x: any) => x.title === title);
        const v2 = page1('Version two');
        await bot.ok('POST', `/channels/${ch}/messages`, { content: 'Version 2.', artifact: { id: art.id, title, kind: 'html', content: v2 } }, [201]);
        const detail = (await bot.ok('GET', `/channels/${ch}/artifacts/${art.id}`)) as any;
        expect(detail.latestVersion).toBe(2);

        await openChannel(page, ch, name);
        await page.getByRole('button', { name: `Open ${title} in the canvas` }).last().click();
        const pane = page.locator('aside[aria-label="canvas"]');
        const frame = page.frameLocator(`aside[aria-label="canvas"] iframe[title="${title}"]`);
        await expect(frame.locator('#h')).toHaveText('Version two');
        const picker = pane.getByRole('combobox', { name: 'Version' });
        await expect(picker.locator('option:checked')).toHaveText('v2 (latest)');
        await picker.selectOption({ label: 'v1' });
        await expect(frame.locator('#h')).toHaveText('Version one');
        const latest = pane.getByRole('button', { name: 'Go to latest (v2)' });
        await expect(latest).toBeVisible();
        await snap(page, ti, 'UI-05.canvas-versions', '01-old-version', 'A canvas pane showing version 1 of a page with a Go to latest (v2) button', { ready: latest });
        await latest.click();
        await expect(frame.locator('#h')).toHaveText('Version two');

        const source = pane.getByRole('button', { name: 'Source' });
        await source.click();
        await expect(source).toHaveAttribute('aria-pressed', 'true');
        await expect(pane.locator('pre')).toContainText('<h1 id="h">Version two</h1>');
        await source.click();
        await expect(frame.locator('#h')).toHaveText('Version two');

        const [download] = await Promise.all([page.waitForEvent('download'), pane.getByRole('button', { name: 'Download' }).click()]);
        expect(download.suggestedFilename()).toMatch(/-v2\.html$/);
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(c as Buffer);
        expect(Buffer.concat(chunks).toString('utf8')).toBe(v2);
    });

    test('[UI-05.canvas-escape-nav] a meta refresh is stripped; location= resets the frame with a notice', async ({ page, seed }, ti) => {
        const { bot } = apis(seed);
        const hits: string[] = [];
        await page.route(`${CANARY}/**`, route => { hits.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1 id="h">CANARY PAGE</h1>' }); });
        const ch = seed.channels.agents, name = `agents-${seed.runTag}`;
        const metaTitle = `E2E meta ${seed.runTag} ${Date.now() % 100000}`;
        const meta = `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${CANARY}/meta"></head><body><h1 id="h">Meta page stays</h1></body></html>`;
        await bot.ok('POST', `/channels/${ch}/messages`, { content: 'Meta refresh probe.', artifact: { title: metaTitle, kind: 'html', content: meta } }, [201]);
        await openChannel(page, ch, name);
        await page.getByRole('button', { name: `Open ${metaTitle} in the canvas` }).last().click();
        const pane = page.locator('aside[aria-label="canvas"]');
        const mframe = page.frameLocator(`aside[aria-label="canvas"] iframe[title="${metaTitle}"]`);
        await expect(mframe.locator('#h')).toHaveText('Meta page stays');
        await page.waitForTimeout(2500);
        await expect(mframe.locator('#h')).toHaveText('Meta page stays');
        // Only the canvas's own CSP meta is left; the artifact's refresh tag is gone
        expect(await mframe.locator('meta[http-equiv]').evaluateAll(ms => ms.map(m => m.getAttribute('http-equiv')))).toEqual(['Content-Security-Policy']);
        expect(hits.filter(u => u.endsWith('/meta')), 'the refresh target was never requested').toEqual([]);
        await pane.getByRole('button', { name: 'Source' }).click();
        await expect(pane.locator('pre')).toContainText('http-equiv="refresh"');
        await pane.getByRole('button', { name: 'Source' }).click();

        const navTitle = `E2E nav ${seed.runTag} ${Date.now() % 100000}`;
        const nav = `<!doctype html><html><body><h1 id="h">About to navigate</h1><script>setTimeout(function(){ location = '${CANARY}/nav'; }, 300);</script></body></html>`;
        await bot.ok('POST', `/channels/${ch}/messages`, { content: 'Navigation probe.', artifact: { title: navTitle, kind: 'html', content: nav } }, [201]);
        await page.getByRole('button', { name: `Open ${navTitle} in the canvas` }).last().click();
        const notice = pane.getByText('This artifact tried to open another page, so the frame was reset. That page may already have received one request from your browser (it learns your IP address), even with network off.');
        await expect(notice).toBeVisible({ timeout: 10_000 });
        await expect(pane.getByRole('button', { name: 'Reload it' })).toBeVisible();
        await expect(pane.locator(`iframe[title="${navTitle}"]`), 'the navigated frame is gone').toHaveCount(0);
        await snap(page, ti, 'UI-05.canvas-escape-nav', '01-reset-notice', 'A canvas pane replaced by a notice that the artifact tried to open another page, with a Reload it button', { ready: notice });
    });
});

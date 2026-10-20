import { test, expect, apis, openChannel } from '../lib/fixtures';
import { snap } from '../lib/snap';

const PAGE = `<!doctype html><html><body style="font-family:sans-serif;background:#f4f1ea;color:#222">
<h1 id="h">E2E canvas page</h1><p>Rendered inside the sandboxed canvas frame.</p><ul id="probes"></ul>
<script>
const out = (k, v) => { const li = document.createElement('li'); li.id = k; li.textContent = k + ': ' + v; document.getElementById('probes').appendChild(li); };
try { const d = parent.document; out('parent', 'reachable ' + (d ? 'yes' : 'no')); } catch (e) { out('parent', 'blocked'); }
try { out('cookie', document.cookie === '' ? 'empty' : 'visible'); } catch (e) { out('cookie', 'blocked'); }
fetch('https://example.com/').then(() => out('fetch', 'allowed')).catch(() => out('fetch', 'blocked'));
</script></body></html>`;

test.describe('canvas @smoke', () => {
    test('[UI-05.canvas-render] a bot-published HTML artifact renders in a sandboxed pane, network off by default', async ({ page, seed }, ti) => {
        const { bot } = apis(seed);
        const ch = seed.channels.agents, name = `agents-${seed.runTag}`;
        const title = `E2E canvas ${seed.runTag}`;
        await bot.ok('POST', `/channels/${ch}/messages`, { content: 'Published a canvas page.', artifact: { title, kind: 'html', content: PAGE } }, [201]);
        await openChannel(page, ch, name);
        const open = page.getByRole('button', { name: `Open ${title} in the canvas` });
        await expect(open).toBeVisible();
        await open.click();
        const pane = page.locator('aside[aria-label="canvas"]');
        await expect(pane.getByRole('heading', { name: title })).toBeVisible();
        const iframe = pane.locator(`iframe[title="${title}"]`);
        await expect(iframe).toBeVisible();
        expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts');
        await expect(pane.getByRole('button', { name: 'Network off' })).toBeVisible();

        const frame = page.frameLocator(`aside[aria-label="canvas"] iframe[title="${title}"]`);
        await expect(frame.locator('#h')).toHaveText('E2E canvas page');
        // UI-05.canvas-escape: in-frame probes, no vision needed
        await expect(frame.locator('#parent')).toHaveText('parent: blocked');
        await expect(frame.locator('#fetch')).toHaveText('fetch: blocked', { timeout: 10_000 });
        await expect(frame.locator('#cookie')).not.toHaveText(/visible/);
        await snap(page, ti, 'UI-05.canvas-render', '01-pane', 'A side pane rendering an HTML page titled "E2E canvas page" next to the chat',
            { ready: iframe });

        // Second version updates the pane's version picker
        const art = (await bot.ok('GET', `/channels/${ch}/artifacts`)) as any;
        const list: any[] = Array.isArray(art) ? art : (art.artifacts ?? []);
        const a = list.find(x => x.title === title);
        expect(a, 'artifact listed').toBeTruthy();
        await bot.ok('POST', `/channels/${ch}/messages`, { content: 'Version 2.', artifact: { id: a.id, title, kind: 'html', content: PAGE.replace('E2E canvas page', 'E2E canvas page v2') } }, [201]);
        await expect(pane.getByRole('combobox', { name: 'Version' }).or(pane.getByRole('button', { name: /Go to latest/ })).first()).toBeVisible({ timeout: 10_000 });
    });
});

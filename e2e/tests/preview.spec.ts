/**
 * Browser preview through the fake host (beta-test-plan §2.2 "Browser preview"): the host has a
 * `preview` block pointing at Playwright's Chromium; the test serves a page on the session's
 * own port (from AGORA_PREVIEW_PORTS, recorded by the fake CLI) and asks for a screenshot as
 * the agent's bot. A port outside the session's range is refused by the host before loading.
 */
import http from 'node:http';
import { chromium } from '@playwright/test';
import { test, expect, apis, openChannel, loadSeed } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { startFakeHost, waitFor, type FakeHost } from '../lib/fake-host';
import { agentChannel, expectNotice, startSession, trimId, waitIdle, waitMessage, waitRuns } from '../lib/agents';

let fh: FakeHost;
const PORT_BASE = 47310;

function serve(port: number, html: string) {
    const hits: string[] = [];
    const server = http.createServer((req, res) => { hits.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
    return new Promise<{ hits: string[]; close: () => Promise<void> }>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve({ hits, close: () => new Promise(r => server.close(() => r())) }));
    });
}

test.describe('browser preview with the fake host', () => {
    test.describe.configure({ timeout: 150_000 });
    test.beforeAll(async () => {
        fh = await startFakeHost(loadSeed(), { label: 'fk-prev', profiles: [{ key: 'prev' }], preview: { browser: chromium.executablePath(), portBase: PORT_BASE, portsPerSession: 2 } });
    });
    test.afterAll(async () => { await fh?.stop(); });

    test('[AG-08.browser-preview] in-range localhost page → screenshot posted; out-of-range port → port_not_in_session_range', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const a = fh.agents.prev;
        const ch = await agentChannel(seed, fh, 'fk-prev', ['prev']);
        const sid = await startSession(owner, ch.id, a.name);
        const [t] = await waitRuns(fh, 'prev', 1);
        await waitIdle(owner, ch.id, a.name, sid);
        const m = /^(\d+)-(\d+)$/.exec(t.previewPorts ?? '');
        expect(m, 'the run got its preview port range').toBeTruthy();
        const [first, last] = [Number(m![1]), Number(m![2])];
        expect(last - first + 1).toBe(2);

        const inside = await serve(first, '<!doctype html><title>E2E preview</title><h1 style="font-family:sans-serif">Preview page</h1><script>console.error("e2e console error")</script>');
        const outside = await serve(last + 1, '<!doctype html><title>Outside</title><h1>Should never load</h1>');
        try {
            const url = `http://localhost:${first}/`;
            const req = (await a.bot.ok('POST', `/channels/${ch.id}/browser-previews`, { url, width: 800, height: 600, fullPage: false }, [202])) as any;
            const done = await waitFor('preview result', async () => {
                const r = (await a.bot.ok('GET', `/channels/${ch.id}/browser-previews/${req.id}`)) as any;
                return ['succeeded', 'failed'].includes(r.status) ? r : null;
            }, 90_000, 1000);
            expect([done.status, done.result?.error ?? null]).toEqual(['succeeded', null]);
            expect(inside.hits.length).toBeGreaterThan(0);
            const msg = await waitMessage(owner, ch.id, x => trimId(x.id) === trimId(done.messageId), 'preview message');
            expect(msg.content).toMatch(new RegExp(`^Browser preview of ${url.replace(/[.]/g, '\\.')} \\(“E2E preview”\\)\\. Console: 1 error`));
            expect(msg.attachments).toHaveLength(1);
            await openChannel(page, ch.id, ch.name);
            const row = page.locator('[data-index]').filter({ hasText: `Browser preview of ${url}` }).last();
            const img = row.locator('img').first();
            await expect(img).toBeVisible();
            await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
            await snap(page, ti, 'AG-08.browser-preview', '01-preview-posted', 'A bot message with a browser screenshot of a page titled "Preview page" and a console summary', { ready: img });

            // Out of range: refused by the host before loading; the page there is never requested
            const bad = `http://localhost:${last + 1}/`;
            const req2 = (await a.bot.ok('POST', `/channels/${ch.id}/browser-previews`, { url: bad, width: 800, height: 600, fullPage: false }, [202])) as any;
            const failed = await waitFor('out-of-range preview result', async () => {
                const r = (await a.bot.ok('GET', `/channels/${ch.id}/browser-previews/${req2.id}`)) as any;
                return ['succeeded', 'failed'].includes(r.status) ? r : null;
            }, 90_000, 1000);
            expect([failed.status, failed.result?.error]).toEqual(['failed', 'port_not_in_session_range']);
            expect(outside.hits, 'nothing loaded from the out-of-range port').toEqual([]);
            await expectNotice(page, `Browser preview of ${bad} failed: port_not_in_session_range`);
        } finally { await inside.close(); await outside.close(); }
    });
});

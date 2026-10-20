import { test, expect } from '../lib/fixtures';

test.describe('admin page and API share URLs @smoke', () => {
    test('[ID-06.admin-vary] page load then fetch of /admin/storage with the HTTP cache on', async ({ page }) => {
        // /admin/storage is both the SPA page (Accept: text/html) and the API endpoint the
        // page fetches. Without Vary: Accept the browser can answer the fetch from the
        // cached HTML. Load the page twice so the HTML is in cache, then fetch with the
        // default cache mode, the same call StorageSettings makes.
        for (let i = 0; i < 2; i++) {
            const nav = await page.goto('/admin/storage');
            expect(nav?.headers()['content-type'] ?? '').toContain('text/html');
            expect(nav?.headers()['vary'] ?? '').toMatch(/accept/i);
        }
        const res = await page.evaluate(async () => {
            const r = await fetch('/admin/storage', { credentials: 'same-origin' });
            const body = await r.text();
            let json = true;
            try { JSON.parse(body); } catch { json = false; }
            return { type: r.headers.get('content-type') ?? '', vary: r.headers.get('vary') ?? '', json, head: body.slice(0, 200) };
        });
        expect(res.type, res.head).toContain('application/json');
        expect(res.json, res.head).toBe(true);
        expect(res.vary).toMatch(/accept/i);
    });
});

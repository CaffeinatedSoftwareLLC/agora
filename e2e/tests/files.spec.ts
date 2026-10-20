import fs from 'node:fs';
import path from 'node:path';
import { test, expect, apis, openChannel } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { E2E_DIR } from '../lib/env';

const fixture = (f: string) => path.join(E2E_DIR, 'fixtures', f);

test.describe('files @smoke', () => {
    test('[UI-03.upload-image] upload an image by button: inline preview; download is the (EXIF-stripped) 64x48 PNG', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const ch = seed.channels.agents, name = `agents-${seed.runTag}`;
        await openChannel(page, ch, name);
        await page.locator('input[type=file]').first().setInputFiles(fixture('e2e-image.png'));
        const caption = `Image upload ${Date.now()}`;
        await page.getByPlaceholder(`Message #${name}`).fill(caption);
        await page.getByRole('button', { name: 'Send message' }).click();
        const img = page.locator('[data-index]').locator('img[alt="e2e-image.png"]').last();
        await expect(img).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(64);
        await snap(page, ti, 'UI-03.upload-image', '01-inline-preview', 'A message with a small gradient image shown inline as a preview', { ready: img });

        const msgs = (await owner.ok('GET', `/channels/${ch}/messages?limit=10`)) as any[];
        const m = msgs.find(x => x.content === caption);
        expect(m?.attachments?.length).toBe(1);
        // Images are re-encoded on upload (EXIF strip), so compare the decoded size, not bytes.
        const dl = await page.request.get(`/files/${m.attachments[0].id}`);
        expect(dl.status()).toBe(200);
        const body = await dl.body();
        expect(body.subarray(1, 4).toString()).toBe('PNG');
        expect([body.readUInt32BE(16), body.readUInt32BE(20)]).toEqual([64, 48]);

        // Full view overlay
        await img.click();
        await expect(page.locator('img[alt="e2e-image.png"]')).toHaveCount(2);
        await page.keyboard.press('Escape');
    });

    test('[UI-03.upload-pdf] a PDF uploads and downloads from its attachment button', async ({ page, seed }) => {
        const ch = seed.channels.agents, name = `agents-${seed.runTag}`;
        await openChannel(page, ch, name);
        await page.locator('input[type=file]').first().setInputFiles(fixture('e2e-doc.pdf'));
        await page.getByPlaceholder(`Message #${name}`).fill(`PDF upload ${Date.now()}`);
        await page.getByRole('button', { name: 'Send message' }).click();
        // The generic file card is a clickable <div> (no button role), so locate it by its name text.
        const btn = page.locator('[data-index]').getByText('e2e-doc.pdf', { exact: true }).last();
        await expect(btn).toBeVisible({ timeout: 15_000 });
        const download = page.waitForEvent('download');
        await btn.click();
        const d = await download;
        expect(d.suggestedFilename()).toBe('e2e-doc.pdf');
        expect(Buffer.compare(fs.readFileSync(await d.path()), fs.readFileSync(fixture('e2e-doc.pdf'))), 'downloaded bytes identical').toBe(0);
    });

    test('[UI-03.magic-bytes] an .exe renamed to .png is refused by the server', async ({ seed }) => {
        const { member } = apis(seed);
        const fd = new FormData();
        fd.append('channel_id', seed.channels.agents);
        fd.append('file', new Blob([fs.readFileSync(fixture('renamed-exe.png'))], { type: 'image/png' }), 'renamed-exe.png');
        const r = await member.req('POST', '/files/upload', fd);
        expect(r.status, JSON.stringify(r.data)).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
    });
});

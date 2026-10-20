import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { test, expect, apis, openChannel, loadSeed } from '../lib/fixtures';
import { snap } from '../lib/snap';
import { E2E_DIR } from '../lib/env';
import type { Api } from '../lib/api';
import { freshChannel, makeBot, rowWith, sha256, uniq } from '../lib/helpers';
import { blankPng } from '../lib/png';
import { seedRoles, type RoleSeed } from '../lib/seed-roles';

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

// ---- Drag-drop, paste, bytes, access across servers and bots, oversized images, encryption at rest ----

/** Upload through the API and attach to a new message (bots only read files attached to a live message). */
async function uploadAndPost(api: Api, channelId: string, name: string, bytes: Buffer, mime: string, content: string) {
    const fd = new FormData();
    fd.append('channel_id', channelId);
    fd.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), name);
    const up = await api.req('POST', '/files/upload', fd);
    if (up.status !== 201) throw new Error(`upload ${name} -> ${up.status} ${JSON.stringify(up.data).slice(0, 200)}`);
    const msg = (await api.ok('POST', `/channels/${channelId}/messages`, { content, attachments: [up.data.id] }, [201])) as any;
    return { fileId: up.data.id as string, messageId: msg.id as string };
}

/** A File inside the page built from bytes in this process, wrapped in a DataTransfer. */
async function dataTransferWith(page: Page, name: string, mime: string, bytes: Buffer) {
    return page.evaluateHandle(({ name, mime, b64 }) => {
        const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([data], name, { type: mime }));
        return dt;
    }, { name, mime, b64: bytes.toString('base64') });
}

const run = promisify(execFile);
/** Runs a command on the WSL Ubuntu Docker daemon (the one the agora-e2e project lives on). */
async function wslDocker(args: string[]) {
    try {
        const r = await run('wsl.exe', ['-d', 'Ubuntu', '--', 'docker', ...args], { timeout: 90_000, windowsHide: true });
        return { code: 0, stdout: r.stdout.toString().trim() };
    } catch (e: any) {
        if (e.code === 'ENOENT') throw e;
        return { code: typeof e.code === 'number' ? e.code : 1, stdout: String(e.stdout ?? '').trim(), stderr: String(e.stderr ?? '').trim() };
    }
}

test.describe('files: drop, paste, access, limits, encryption at rest', () => {
    let rs: RoleSeed;
    test.beforeAll(async () => { rs = await seedRoles(loadSeed()); });

    test('[UI-03.drag-drop] dropping an image on the composer uploads it with an inline preview', async ({ page, seed }, ti) => {
        const { owner } = apis(seed);
        const ch = await freshChannel(seed, 'drop');
        await openChannel(page, ch.id, ch.name);
        const box = page.getByPlaceholder(`Message #${ch.name}`);
        const dt = await dataTransferWith(page, 'dropped-e2e.png', 'image/png', fs.readFileSync(fixture('e2e-image.png')));
        for (const type of ['dragenter', 'dragover', 'drop']) await box.dispatchEvent(type, { dataTransfer: dt });
        const caption = `Dropped ${seed.runTag}`;
        await box.fill(caption);
        const send = page.getByRole('button', { name: 'Send message' });
        await expect(send).toBeEnabled({ timeout: 15_000 });
        await send.click();
        const img = rowWith(page, caption).locator('img[alt="dropped-e2e.png"]');
        await expect(img).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(64);
        await snap(page, ti, 'UI-03.drag-drop', '01-inline-preview', 'A message with an inline image preview of a small gradient image', { ready: img });
        const msgs = (await owner.ok('GET', `/channels/${ch.id}/messages?limit=5`)) as any[];
        expect(msgs).toHaveLength(1);
        expect(msgs[0].attachments.map((a: any) => [a.name, a.mime, a.width, a.height])).toEqual([['dropped-e2e.png', 'image/png', 64, 48]]);
    });

    test('[UI-03.paste] pasting an image into the composer uploads it', async ({ page, seed }) => {
        const { owner } = apis(seed);
        const ch = await freshChannel(seed, 'paste');
        await openChannel(page, ch.id, ch.name);
        const box = page.getByPlaceholder(`Message #${ch.name}`);
        const dt = await dataTransferWith(page, 'pasted-e2e.png', 'image/png', fs.readFileSync(fixture('e2e-image.png')));
        await box.evaluate((el, d) => {
            el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d as DataTransfer, bubbles: true, cancelable: true }));
        }, dt);
        const caption = `Pasted ${seed.runTag}`;
        await box.fill(caption);
        const send = page.getByRole('button', { name: 'Send message' });
        await expect(send).toBeEnabled({ timeout: 15_000 });
        await send.click();
        await expect(rowWith(page, caption).locator('img[alt="pasted-e2e.png"]')).toBeVisible({ timeout: 15_000 });
        const msgs = (await owner.ok('GET', `/channels/${ch.id}/messages?limit=5`)) as any[];
        expect(msgs).toHaveLength(1);
        expect(msgs[0].attachments.map((a: any) => a.name)).toEqual(['pasted-e2e.png']);
    });

    test('[UI-03.download-sha256] a dropped PDF downloads with the same sha256 as the fixture', async ({ page, seed }) => {
        const { owner } = apis(seed);
        const ch = await freshChannel(seed, 'pdf');
        const pdf = fs.readFileSync(fixture('e2e-doc.pdf'));
        await openChannel(page, ch.id, ch.name);
        const box = page.getByPlaceholder(`Message #${ch.name}`);
        const dt = await dataTransferWith(page, 'e2e-doc.pdf', 'application/pdf', pdf);
        for (const type of ['dragenter', 'dragover', 'drop']) await box.dispatchEvent(type, { dataTransfer: dt });
        const caption = `PDF bytes ${seed.runTag}`;
        await box.fill(caption);
        const send = page.getByRole('button', { name: 'Send message' });
        await expect(send).toBeEnabled({ timeout: 15_000 });
        await send.click();
        await expect(rowWith(page, caption).getByText('e2e-doc.pdf', { exact: true })).toBeVisible({ timeout: 15_000 });
        const msgs = (await owner.ok('GET', `/channels/${ch.id}/messages?limit=5`)) as any[];
        const att = msgs[0].attachments;
        expect(att).toHaveLength(1);
        const dl = await page.request.get(`/files/${att[0].id}`);
        expect(dl.status()).toBe(200);
        expect(dl.headers()['content-type']).toBe('application/pdf');
        expect(sha256(await dl.body())).toBe(sha256(pdf));
    });

    test('[UI-03.cross-server-403] a file in another server is 403 for people who are not its members', async ({ page, seed }) => {
        const { owner, member } = apis(seed);
        const bytes = Buffer.from(`Other server file ${seed.runTag}\n`);
        const f = await uploadAndPost(rs.outsider.api, rs.other.generalId, `other-${seed.runTag}.txt`, bytes, 'text/plain', `Other server ${seed.runTag}`);
        const mine = await rs.outsider.api.req('GET', `/files/${f.fileId}`);
        expect(mine.status, 'its own member can read it').toBe(200);
        // The plan expects 403 (beta-test-plan §1.5, §2.2). Soft, so the no-bytes checks below
        // still run and the report shows every status actually returned.
        for (const [who, api] of [['owner-e2e', owner], ['member-e2e', member]] as const) {
            const r = await api.req('GET', `/files/${f.fileId}`);
            expect.soft(r.status, `${who} bearer GET /files/:id`).toBe(403);
            expect(r.status, `${who} is refused`).not.toBe(200);
            expect(String(r.data).includes('Other server file'), `${who} gets no bytes`).toBe(false);
            expect((await api.req('GET', `/files/${f.fileId}/text`)).status, `${who} /text`).not.toBe(200);
            expect((await api.req('GET', `/files/${f.fileId}/image`)).status, `${who} /image`).not.toBe(200);
            expect((await api.req('GET', `/channels/${rs.other.generalId}/messages`)).status, `${who} messages`).toBe(403);
        }
        const viaCookie = await page.request.get(`/files/${f.fileId}`);
        expect.soft(viaCookie.status(), 'owner cookie session GET /files/:id').toBe(403);
        expect(viaCookie.status()).not.toBe(200);
    });

    test('[UI-04.bot-file-access] bot token: its channel 200 (same bytes), another channel 403, paused 403', async ({ seed }) => {
        const { owner } = apis(seed);
        const a = await freshChannel(seed, 'botfiles');
        const b = await freshChannel(seed, 'nobot');
        const bot = await makeBot(seed, uniq(seed, 'filebot'), [a.id]);
        const bytes = Buffer.from(`Bot readable ${seed.runTag}\n`);
        const inA = await uploadAndPost(owner, a.id, 'in-a.txt', bytes, 'text/plain', `File in A ${seed.runTag}`);
        const inB = await uploadAndPost(owner, b.id, 'in-b.txt', Buffer.from(`Not for the bot ${seed.runTag}\n`), 'text/plain', `File in B ${seed.runTag}`);
        try {
            const ok = await bot.api.req('GET', `/files/${inA.fileId}`);
            expect(ok.status).toBe(200);
            expect(ok.data).toBe(bytes.toString());
            const no = await bot.api.req('GET', `/files/${inB.fileId}`);
            expect(no.status).toBe(403);
            expect(String(no.data).includes('Not for the bot')).toBe(false);

            await owner.ok('PATCH', `/servers/${seed.serverId}/bots/${bot.botId}/pause`, { paused: true, reason: 'e2e' });
            const paused = await bot.api.req('GET', `/files/${inA.fileId}`);
            expect([paused.status, paused.data?.error]).toEqual([403, 'bot_paused']);
            expect((await bot.api.req('GET', `/files/${inA.fileId}/image`)).status, 'paused: /image refused too').toBe(403);
        } finally {
            await owner.req('PATCH', `/servers/${seed.serverId}/bots/${bot.botId}/pause`, { paused: false });
        }
        expect((await bot.api.req('GET', `/files/${inA.fileId}`)).status, 'resumed: readable again').toBe(200);
    });

    test('[UI-04.image-41mp] GET /files/:id/image on a 41 MP PNG is 413 (bot and owner)', async ({ seed }) => {
        const { owner } = apis(seed);
        const ch = await freshChannel(seed, 'bigimg');
        const bot = await makeBot(seed, uniq(seed, 'imgbot'), [ch.id]);
        const png = blankPng(6500, 6400); // 41.6 MP, ~40 KB
        expect(png.length).toBeLessThan(2 * 1024 * 1024);
        const big = await uploadAndPost(owner, ch.id, 'huge-41mp.png', png, 'image/png', `41 MP ${seed.runTag}`);
        const small = await uploadAndPost(owner, ch.id, 'small.png', fs.readFileSync(fixture('e2e-image.png')), 'image/png', `small ${seed.runTag}`);
        const r = await bot.api.req('GET', `/files/${big.fileId}/image`);
        expect(r.status, JSON.stringify(r.data).slice(0, 200)).toBe(413);
        expect(String(r.data?.error)).toMatch(/too large/);
        expect((await owner.req('GET', `/files/${big.fileId}/image`)).status).toBe(413);
        // The route itself works for a normal image (so the 413 is the pixel cap)
        const okSmall = await bot.api.req('GET', `/files/${small.fileId}/image`);
        expect(okSmall.status).toBe(200);
        expect([okSmall.data.width, okSmall.data.height]).toEqual([64, 48]);
    });

    test('[UI-03.volume-ciphertext] an uploaded text file is not stored in plaintext on the files volume', async ({ seed }) => {
        const { owner } = apis(seed);
        let vols: string[];
        try {
            vols = (await wslDocker(['volume', 'ls', '--filter', 'name=agora-e2e', '--format', '{{.Name}}'])).stdout.split(/\r?\n/).filter(Boolean);
        } catch {
            test.skip(true, 'wsl.exe not available on this host: the agora-e2e volume cannot be inspected');
            return;
        }
        const vol = vols.find(v => /^agora-e2e_[\w-]*files$/.test(v));
        expect(vol, `files volume among ${vols.join(', ')}`).toBeTruthy();
        expect(vol!.startsWith('agora-e2e_'), 'never touch a volume outside the e2e project').toBe(true);

        const marker = `E2E-PLAINTEXT-MARKER-${seed.runTag}-${Date.now()}`;
        const name = `plaintext-probe-${seed.runTag}.txt`;
        const ch = await freshChannel(seed, 'atrest');
        const f = await uploadAndPost(owner, ch.id, name, Buffer.from(`${marker}\n`.repeat(20)), 'text/plain', `At rest ${seed.runTag}`);
        expect((await owner.req('GET', `/files/${f.fileId}`)).data, 'the API still returns the plaintext').toContain(marker);

        const sh = (cmd: string) => wslDocker(['run', '--rm', '-v', `${vol}:/d:ro`, 'alpine', 'sh', '-c', cmd]);
        // Positive control: this file's blob is on this volume (so the grep looks in the right place)
        const blob = await sh(`find /d -type f -path "*${f.fileId}*"`);
        expect(blob.stdout.split(/\r?\n/).filter(Boolean), 'one blob for the file').toHaveLength(1);
        expect(blob.stdout.includes(name), 'no file name in the storage path').toBe(false);
        const grep = await sh(`grep -rl "${marker}" /d`);
        expect(grep.stdout, 'no blob contains the marker').toBe('');
        expect(grep.code, 'grep found nothing (exit 1)').toBe(1);
        const byName = await sh(`find /d -name "*plaintext-probe*"`);
        expect(byName.stdout).toBe('');
    });
});

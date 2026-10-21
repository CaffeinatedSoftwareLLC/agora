import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '../lib/fixtures';
import { knownSecrets, scanDir } from '../lib/leak-scan';
import { runtimeSecrets, Sensitive, writeFailureEvidence } from '../lib/sensitive';

// Synthetic values in the real shapes: a bot token and a 64-hex invite code. Never real ones.
const TOKEN = 'bot_01JE2EEVIDENCE0000000000AA.' + 'ab'.repeat(32);
const INVITE = 'cd'.repeat(32);
const PAGE = `<main><h1>Token Created</h1><p class="font-mono">${TOKEN}</p>
    <pre>claude mcp add agora -- agora-mcp --invite ${INVITE}</pre><input value="${INVITE}"></main>`;

function evidenceDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agora-e2e-evidence-')); }
const read = (dir: string) => fs.readdirSync(dir).map(f => [f, f.endsWith('.png') ? '' : fs.readFileSync(path.join(dir, f), 'utf8')] as const);

test.describe('failure evidence for tests that show secrets @smoke', () => {
    test('[SEC-04.evidence-scrub] a failure while a token or invite dialog is open retains no PNG and no secret text', async ({ page }) => {
        await page.setContent(PAGE);
        for (const known of [true, false]) {
            // known: the test registered the values; unknown: it only called begin() before the
            // reveal and failed before reading them, so scrubbing has to go by shape
            const s = new Sensitive();
            s.begin();
            if (known) { s.add(TOKEN); s.add(INVITE); }
            const dir = evidenceDir();
            try {
                await writeFailureEvidence(page, dir, {
                    test: 'bots > token dialog', status: 'failed',
                    errors: [`expect(received).toBe(expected)\nReceived: "${TOKEN}"\nInvite: ${INVITE}`],
                }, [`console: invite ${INVITE} token ${TOKEN}`], s);
                const files = read(dir);
                expect(files.map(([f]) => f).sort(), `known=${known}`).toEqual(['error.json', 'failure-png-withheld.txt', 'failure.txt']);
                for (const [f, text] of files) {
                    expect(text.includes(TOKEN), `${f} has no token (known=${known})`).toBe(false);
                    expect(text.includes(INVITE), `${f} has no invite code (known=${known})`).toBe(false);
                }
                // The end-of-run leak scan agrees, with the registered values in its list
                expect(scanDir(dir, knownSecrets([{ ...runtimeSecrets() }]))).toEqual([]);
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        }
        // Registered values reach the leak scanner's list
        expect(runtimeSecrets()).toEqual(expect.arrayContaining([TOKEN, INVITE]));
    });

    test('[SEC-04.evidence-plain] a test that showed no secret keeps its screenshot', async ({ page }) => {
        await page.setContent('<main><h1>Nothing secret</h1></main>');
        const dir = evidenceDir();
        try {
            await writeFailureEvidence(page, dir, { test: 'plain', status: 'failed', errors: ['boom'] }, [], new Sensitive());
            expect(fs.readdirSync(dir).sort()).toEqual(['error.json', 'failure.png', 'failure.txt']);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});

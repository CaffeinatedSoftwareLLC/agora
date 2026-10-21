import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { SECRETS_DIR } from './env';
import { LEAK_PATTERNS } from './leak-scan';

/**
 * Secrets a test puts on screen (a minted bot token, an invite code). Call `begin()` before
 * the click that reveals one, and `add(value)` as soon as its value is known. From `begin()`
 * on, failure evidence for the test keeps no screenshot (pixels can't be scrubbed) and its
 * DOM text, error and console output are scrubbed of every added value and of anything shaped
 * like a token or an invite code. Added values are also written to secrets/runtime-secrets.json
 * so the end-of-run leak scan (finalize.ts) looks for them in everything retained.
 */
export class Sensitive {
    active = false;
    readonly values: string[] = [];
    begin() { this.active = true; }
    add(value: string) {
        this.active = true;
        if (!value || value.length < 8 || this.values.includes(value)) return;
        this.values.push(value);
        recordRuntimeSecret(value);
    }
    /** Replace every known value, and while active every token/invite-shaped string. */
    scrub(text: string): string {
        let out = text;
        for (const v of this.values) out = out.split(v).join('[secret]');
        if (this.active) {
            for (const [, re] of LEAK_PATTERNS) out = out.replace(new RegExp(re.source, 'g'), '[secret]');
            out = out.replace(SECRET_SHAPES, '[secret]');
        }
        return out;
    }
}

// Invite codes are 64 hex characters; bot tokens end in one. Only scrubbed in sensitive tests,
// where no legitimate hash needs to survive in the failure text.
const SECRET_SHAPES = /\b[0-9a-f]{64}\b/g;

export const RUNTIME_SECRETS_FILE = path.join(SECRETS_DIR, 'runtime-secrets.json');

function recordRuntimeSecret(value: string) {
    let list: string[] = [];
    try { list = JSON.parse(fs.readFileSync(RUNTIME_SECRETS_FILE, 'utf8')); } catch { /* first one */ }
    if (list.includes(value)) return;
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_SECRETS_FILE, JSON.stringify([...list, value]), { mode: 0o600 });
}

export function runtimeSecrets(): string[] {
    try { return JSON.parse(fs.readFileSync(RUNTIME_SECRETS_FILE, 'utf8')); } catch { return []; }
}

export interface FailureInfo { test: string; status: string; errors: string[] }

/**
 * Write failure evidence for one test into `dir`: failure.png (only when the test showed no
 * secret), failure.txt (page text) and error.json. Everything text passes through
 * `sensitive.scrub` first.
 */
export async function writeFailureEvidence(page: Page, dir: string, info: FailureInfo, consoleErrors: string[], sensitive: Sensitive) {
    fs.mkdirSync(dir, { recursive: true });
    if (sensitive.active) {
        fs.writeFileSync(path.join(dir, 'failure-png-withheld.txt'), 'No screenshot: this test showed a secret on screen, and pixels cannot be scrubbed.\n');
    } else {
        try { await page.screenshot({ path: path.join(dir, 'failure.png'), animations: 'disabled', timeout: 5000 }); } catch { /* page gone */ }
    }
    try { fs.writeFileSync(path.join(dir, 'failure.txt'), sensitive.scrub(await page.evaluate(() => document.body?.innerText ?? ''))); } catch { /* page gone */ }
    fs.writeFileSync(path.join(dir, 'error.json'), sensitive.scrub(JSON.stringify({
        test: info.test,
        url: (() => { try { return page.url(); } catch { return null; } })(),
        status: info.status,
        errors: info.errors.map(e => e.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 4000)),
        console_errors: consoleErrors,
    }, null, 2)));
}

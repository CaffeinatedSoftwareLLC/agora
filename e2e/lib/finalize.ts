/**
 * Called by the summary reporter once the run ends, pass or fail:
 *  1. leak-scans artifacts/<run-id>/ (manifest, DOM text, failure evidence) against the
 *     seeded secrets and key patterns; any hit is quarantined (moved out of the run dir
 *     into secrets/, which is deleted) and recorded in leak-report.json;
 *  2. writes summary.json (pass/fail counts) next to the manifest;
 *  3. deletes secrets/: storageState files, seed.json (bot/host tokens, passwords),
 *     the raw Playwright output (traces hold cookies and request bodies) and report.json.
 *
 * Instance-lifetime credentials in e2e/.env.e2e are removed by e2e/down.sh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { artifactsDir, readEnvFile, SECRETS_DIR, SEED_FILE } from './env';
import { knownSecrets, scanDir } from './leak-scan';

export async function finalize(summary?: unknown) {
    const dir = artifactsDir();
    let seedSecrets: Record<string, unknown> | undefined;
    try { seedSecrets = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')).secrets; } catch { /* seeding failed early */ }
    let envSecrets: Record<string, string> = {};
    try {
        const e = readEnvFile();
        envSecrets = { a: e.DB_PASSWORD, b: e.JWT_SECRET, c: e.AGORA_ENCRYPTION_KEY, d: e.AGORA_SETUP_TOKEN, e: e.E2E_OWNER_PASSWORD, f: e.E2E_MEMBER_PASSWORD };
    } catch { /* gone */ }
    const secrets = knownSecrets([seedSecrets, envSecrets]);

    if (summary && fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

    const hits = scanDir(dir, secrets);
    if (hits.length) {
        const q = path.join(SECRETS_DIR, 'quarantine');
        fs.mkdirSync(q, { recursive: true });
        for (const h of hits) {
            if (!fs.existsSync(h.file)) continue;
            const rel = path.relative(dir, h.file);
            const png = h.file.replace(/\.txt$/, '.png');
            for (const f of [h.file, png]) if (fs.existsSync(f)) fs.renameSync(f, path.join(q, path.basename(f)));
            console.error(`leak-scan: quarantined ${rel} (${h.kind})`);
        }
        fs.writeFileSync(path.join(dir, 'leak-report.json'), JSON.stringify(
            { status: 'secret_leak', hits: hits.map(h => ({ file: path.relative(dir, h.file), kind: h.kind })) }, null, 2));
    }

    if (process.env.E2E_KEEP_SECRETS === '1') {
        console.warn('E2E_KEEP_SECRETS=1: secrets/ left in place for debugging. Delete it when done.');
        return;
    }
    fs.rmSync(SECRETS_DIR, { recursive: true, force: true });
}

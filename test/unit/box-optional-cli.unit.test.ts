import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * box/agora-optional-cli (docs/agent-boxes.md §6.1): a vendor's missing file skips that CLI and records it; a
 * file that downloaded but does not match its checksum fails hard. Runs the real script with a fake curl.
 */
const script = join(__dirname, '../../box/agora-optional-cli');
const posix = process.platform !== 'win32' || !!process.env.FORCE_SH_TESTS;

function run(args: string[], fake: { code?: string; rc?: number; body?: string }) {
    const dir = mkdtempSync(join(tmpdir(), 'optcli-'));
    const curl = join(dir, 'curl');
    writeFileSync(curl, `#!/bin/sh
out=''; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
[ -z "$FAKE_RC" ] || { echo "curl: (6) Could not resolve host" >&2; exit "$FAKE_RC"; }
printf '%s' "$FAKE_BODY" > "$out"; printf '%s' "$FAKE_CODE"
`);
    chmodSync(curl, 0o755);
    const missing = join(dir, 'missing-clis');
    const r = spawnSync('sh', [script, ...args.map(a => a.replace('OUT', join(dir, 'out')))], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AGORA_MISSING_FILE: missing, TMPDIR: dir,
            FAKE_CODE: fake.code ?? '200', FAKE_BODY: fake.body ?? '', ...(fake.rc ? { FAKE_RC: String(fake.rc) } : {}) },
    });
    return { status: r.status, stderr: r.stderr, missing: existsSync(missing) ? readFileSync(missing, 'utf8') : '', out: existsSync(join(dir, 'out')) };
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe.skipIf(!posix)('agora-optional-cli fetch', () => {
    it('installs: the file came down and matches', () => {
        const r = run(['fetch', 'devin', 'https://x/devin.tar.gz', sha('payload'), 'OUT'], { body: 'payload' });
        expect(r.status).toBe(0);
        expect(r.missing).toBe('');
        expect(r.out).toBe(true);
    });
    for (const code of ['403', '404', '410']) {
        it(`HTTP ${code}: skipped (75), recorded, warned, no file kept`, () => {
            const r = run(['fetch', 'devin', 'https://x/devin.tar.gz', sha('payload'), 'OUT'], { code, body: 'Forbidden' });
            expect(r.status).toBe(75);
            expect(r.missing).toBe(`devin\tdownload_unavailable\tHTTP ${code}\n`);
            expect(r.stderr).toContain('WARNING: agora-box: devin is NOT in this box image');
            expect(r.out).toBe(false);
        });
    }
    it('a network or DNS failure is skipped too, as download_failed', () => {
        const r = run(['fetch', 'omp', 'https://x/omp', sha('payload'), 'OUT'], { rc: 6 });
        expect(r.status).toBe(75);
        expect(r.missing).toMatch(/^omp\tdownload_failed\tcurl exit 6/);
    });
    it('a checksum mismatch on a file that downloaded fails hard: not skipped, not recorded, not kept', () => {
        const r = run(['fetch', 'devin', 'https://x/devin.tar.gz', sha('expected'), 'OUT'], { body: 'tampered' });
        expect(r.status).toBe(1);
        expect(r.missing).toBe('');
        expect(r.out).toBe(false);
        expect(r.stderr).toContain('does not match its pinned sha256');
    });
    it('a wrong invocation is an error, never a skip', () => {
        expect(run(['fetch', 'devin'], {}).status).toBe(2);
        expect(run(['bogus'], {}).status).toBe(2);
    });
});

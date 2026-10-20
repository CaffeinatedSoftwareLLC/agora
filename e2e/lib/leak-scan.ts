import fs from 'node:fs';
import path from 'node:path';

/** Patterns that should never appear in retained or uploaded evidence. */
export const LEAK_PATTERNS: Array<[string, RegExp]> = [
    ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{10,}/],
    ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
    ['google-key', /AIza[0-9A-Za-z_-]{30,}/],
    ['agora-bot-token', /\bbot_[A-Za-z0-9_-]{16,}/],
    ['agora-host-token', /\bhost_[A-Za-z0-9_-]{16,}/],
    ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['canary', /CANARY-[A-Za-z0-9-]+-SECRET/],
];

export interface LeakHit { file: string; kind: string; }

const TEXT_EXT = new Set(['.txt', '.json', '.jsonl', '.md', '.log', '.csv', '.html', '.yml']);

/** Scan text content for exact secret values and patterns. Returns the kinds found (never the values). */
export function scanText(text: string, secrets: string[]): string[] {
    const kinds: string[] = [];
    for (const s of secrets) {
        if (s && s.length >= 8 && text.includes(s)) { kinds.push('exact-secret'); break; }
    }
    for (const [kind, re] of LEAK_PATTERNS) if (re.test(text)) kinds.push(kind);
    return kinds;
}

/** Recursively scan every text file under dir. PNGs are covered by the .txt captured next to them. */
export function scanDir(dir: string, secrets: string[]): LeakHit[] {
    const hits: LeakHit[] = [];
    if (!fs.existsSync(dir)) return hits;
    const walk = (d: string) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, ent.name);
            if (ent.isDirectory()) { walk(p); continue; }
            if (!TEXT_EXT.has(path.extname(ent.name).toLowerCase())) continue;
            for (const kind of scanText(fs.readFileSync(p, 'utf8'), secrets)) hits.push({ file: p, kind });
        }
    };
    walk(dir);
    return hits;
}

/** Self-test: a contaminated sample must be caught, or callers must refuse to upload. */
export function selfTest(): boolean {
    const canary = 'CANARY-selftest-0001-SECRET';
    const samples: Array<[string, string[]]> = [
        [`cookie: agora_session=${canary}`, []],
        ['key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', []],
        ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl', []],
        ['the password is hunter2-e2e-pass', ['hunter2-e2e-pass']],
    ];
    const clean = 'A message list with three system notices and a composer.';
    return samples.every(([t, s]) => scanText(t, s).length > 0) && scanText(clean, []).length === 0;
}

/** Collect every secret value the harness knows about (kept in memory only). */
export function knownSecrets(sources: Array<Record<string, unknown> | undefined>): string[] {
    const out = new Set<string>();
    const visit = (v: unknown) => {
        if (typeof v === 'string') { if (v.length >= 8) out.add(v); return; }
        if (v && typeof v === 'object') for (const x of Object.values(v)) visit(x);
    };
    for (const s of sources) visit(s);
    return [...out];
}

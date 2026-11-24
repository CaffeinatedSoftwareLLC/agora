#!/usr/bin/env node
// Early warning for the box image's third-party downloads (docs/agent-boxes.md §6.1): checks that every
// pinned vendor artifact box/Dockerfile downloads still exists and still matches its pinned sha256 (release
// files, streamed through sha256), and that every pinned npm version still resolves (`npm view`). Reads the pins
// from box/Dockerfile itself, so there is nothing to keep in step. Never bumps anything.
// Exit 1 and a line naming the pin for each one that is broken: the maintainers hear before a user's install does.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(join(root, 'box/Dockerfile'), 'utf8').replace(/\\r?\n/g, ' ');
const args = Object.fromEntries([...dockerfile.matchAll(/^ARG ([A-Z0-9_]+)=(\S+)$/gm)].map(m => [m[1], m[2]]));
const subst = (s, extra = {}) => s.replace(/\$\{(\w+)\}/g, (_, k) => extra[k] ?? args[k] ?? `\${${k}}`);
const failures = [];
const fail = (pin, why) => { failures.push(`${pin}: ${why}`); console.error(`::error title=Box image pin broken::${pin}: ${why}`); };

// npm pins: agora-optional-cli npm NAME "pkg@${VAR}"
for (const m of dockerfile.matchAll(/agora-optional-cli npm (\w+) "([^"]+)"/g)) {
    const spec = subst(m[2]);
    try {
        const out = execFileSync('npm', ['view', spec, 'version', 'deprecated', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
        const info = out.trim() ? JSON.parse(out) : null;
        if (!info || (typeof info === 'object' && !info.version && !Array.isArray(info))) fail(`${m[1]} (${spec})`, 'npm does not list this version');
        else {
            console.log(`ok    ${m[1]} ${spec} is on npm`);
            if (info.deprecated) console.log(`::warning title=Box image pin deprecated::${m[1]} ${spec} is deprecated on npm: ${info.deprecated}`);
        }
    } catch (e) {
        const text = `${e.stderr ?? ''}${e.message}`;
        fail(`${m[1]} (${spec})`, /E404|E410|ETARGET|notarget|No match/i.test(text) ? 'npm no longer has this version' : `npm view failed: ${text.slice(0, 160)}`);
    }
}

// Release files: agora-optional-cli fetch NAME "URL" ... with the per-CPU `arch=...; sum=...` pairs of the same step
for (const step of dockerfile.split(/(?=^RUN )/m)) {
    const f = /agora-optional-cli fetch (\w+) "([^"]+)"/.exec(step);
    if (!f) continue;
    for (const c of step.matchAll(/(amd64|arm64)\) arch=(\S+?); sum=([0-9a-f]{64})/g)) {
        const [, cpu, arch, sum] = c;
        const url = subst(f[2], { arch });
        const pin = `${f[1]} ${cpu} (${url})`;
        try {
            const res = await fetch(url, { redirect: 'follow' });
            if (!res.ok) { fail(pin, `the vendor answers HTTP ${res.status} (file removed or moved)`); continue; }
            const hash = createHash('sha256');
            for await (const chunk of res.body) hash.update(chunk);
            const got = hash.digest('hex');
            if (got !== sum) fail(pin, `sha256 is ${got}, the Dockerfile pins ${sum}`);
            else console.log(`ok    ${pin} exists and matches its sha256`);
        } catch (e) { fail(pin, `could not download: ${e.message}`); }
    }
}
if (!args.DEVIN_VERSION) fail('box/Dockerfile', 'no pins found: the checker is out of date');
if (failures.length) {
    console.error(`\n${failures.length} pinned vendor download(s) in box/Dockerfile are broken:\n - ${failures.join('\n - ')}\n`
        + 'New installs still build (the CLI is skipped and reported), but its agent cannot start. Bump the pin, its sha256 and box/VERSION '
        + '(docs/agent-boxes.md §16; src/lib/boxes/adapters.ts and agora-host/src/box-adapters.ts hold the same pins).');
    process.exit(1);
}
console.log('every pinned vendor download is still available and matches');

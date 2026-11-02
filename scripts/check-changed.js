#!/usr/bin/env node
/**
 * Run, on this machine, the checks CI would run for what this branch changed.
 *
 * Agents run this before pushing, so CI is a final check instead of the place bugs are
 * found. The areas match the path filters in .github/workflows/ci.yml. Changes are
 * counted against origin/main, including uncommitted and untracked files.
 *
 * Backend tests need the test database: TEST_DATABASE_URL (see .env.example), for
 * example the `agora-test` compose project.
 *
 * Usage:
 *   node scripts/check-changed.js           # Backend: only tests related to the changes
 *   node scripts/check-changed.js --all     # Full suites of every changed area
 *   node scripts/check-changed.js --dry-run # Print the commands, run nothing
 */

const { execSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CHECK_BASE || 'origin/main';
const all = process.argv.includes('--all');
const dryRun = process.argv.includes('--dry-run');

function git(args) {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
}

const changed = [...new Set([
    ...git(`diff --name-only ${BASE}...HEAD`),
    ...git('diff --name-only HEAD'),
    ...git('ls-files --others --exclude-standard'),
])].map(f => f.replace(/\\/g, '/'));

const ci = changed.includes('.github/workflows/ci.yml');
const under = (...prefixes) => changed.some(f => prefixes.some(p => f.startsWith(p)));
const area = {
    backend: ci || under('src/', 'test/', 'scripts/') || changed.includes('agora-ui/nginx.conf') || changed.some(f => /^(package(-lock)?\.json|tsconfig[^/]*\.json|vitest[^/]*\.ts)$/.test(f)),
    cross: under('agora-mcp/', 'agora-host/'),
    frontend: ci || under('agora-ui/'),
    host: ci || under('agora-host/'),
    mcp: ci || under('agora-mcp/'),
    relay: ci || under('agora-push-relay/'),
};

// Backend tests that import agora-mcp or agora-host, for when only those changed.
function crossTests() {
    const out = spawnSync('git', ['grep', '-lE', "from '(\\.\\./)+agora-(mcp|host)/", '--', 'test'], { cwd: ROOT, encoding: 'utf8' });
    return out.stdout.split('\n').map(s => s.trim()).filter(Boolean).sort();
}

const steps = [];
const add = (label, dir, cmd) => steps.push({ label, dir, cmd });
if (area.backend) {
    add('backend build', '.', 'npm run build');
    add('backend tests', '.', all ? 'npx vitest run' : `npx vitest run --changed ${BASE}`);
} else if (area.cross) {
    add('backend tests that use agora-mcp or agora-host', '.', `npx vitest run ${crossTests().join(' ')}`);
}
if (area.frontend) {
    add('frontend lint', 'agora-ui', 'npm run lint');
    add('frontend typecheck', 'agora-ui', 'npx tsc -b');
    add('frontend build', 'agora-ui', 'npx vite build');
    add('frontend tests', 'agora-ui', all ? 'npx vitest run' : `npx vitest run --changed ${BASE}`);
}
if (area.host) { add('agora-host build', 'agora-host', 'npm run build'); add('agora-host tests', 'agora-host', 'npm test'); }
if (area.mcp) { add('agora-mcp build', 'agora-mcp', 'npm run build'); add('agora-mcp tests', 'agora-mcp', 'npm test'); }
if (area.relay) { add('push relay type-check', 'agora-push-relay', 'npm run check'); add('push relay tests', 'agora-push-relay', 'npm test'); }

console.log(`${changed.length} changed file(s) against ${BASE}; areas: ${Object.keys(area).filter(k => area[k]).join(', ') || 'none'}`);
if (steps.length === 0) { console.log('Nothing to check.'); process.exit(0); }

const failed = [];
for (const step of steps) {
    console.log(`\n=== ${step.label}: (${step.dir}) ${step.cmd}`);
    if (dryRun) continue;
    const started = Date.now();
    const r = spawnSync(step.cmd, { cwd: path.join(ROOT, step.dir), stdio: 'inherit', shell: true });
    console.log(`--- ${step.label}: ${r.status === 0 ? 'passed' : 'FAILED'} in ${Math.round((Date.now() - started) / 1000)}s`);
    if (r.status !== 0) failed.push(step.label);
}
if (!dryRun) console.log(failed.length ? `\nFailed: ${failed.join(', ')}` : '\nAll checks passed.');
process.exit(failed.length ? 1 : 0);

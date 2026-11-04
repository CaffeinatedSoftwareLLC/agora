#!/usr/bin/env node
/**
 * Copy the Agora skills to every folder an agent looks for them in, and into the
 * agora-skills plugin (plugins/agora-skills/skills) that Claude Code and Codex install.
 *
 * .claude/skills/agora-* is the source. Edit the skills there, then run this.
 *
 * When the plugin's copy changes, this also raises the patch version in both plugin
 * manifests. Installed plugins update only when that version changes, so every change
 * to the skills reaches users.
 *
 * Usage:
 *   node scripts/sync-skills.js                  # Overwrite the copies with the source
 *   node scripts/sync-skills.js --check          # Change nothing; exit 1 if a copy differs
 *   node scripts/sync-skills.js --check --base origin/main
 *                                                # Also fail if the plugin's skills changed
 *                                                # since that ref without a version change
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = '.claude/skills';
const PLUGIN = 'plugins/agora-skills';
const PLUGIN_SKILLS = `${PLUGIN}/skills`;
const MIRRORS = ['.agents/skills', '.codex/skills', '.gemini/skills', '.opencode/skills', PLUGIN_SKILLS];
const MANIFESTS = [`${PLUGIN}/.claude-plugin/plugin.json`, `${PLUGIN}/.codex-plugin/plugin.json`];
const MARKETPLACES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];

const args = process.argv.slice(2);
const check = args.includes('--check');
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1] : null;
if (baseIndex >= 0 && !base) {
    console.error('--base needs a git ref, for example --base origin/main');
    process.exit(2);
}

function listFiles(dir, base = dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
    });
}

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const writeJson = (rel, value) => fs.writeFileSync(path.join(ROOT, rel), `${JSON.stringify(value, null, 2)}\n`);

const sourceDir = path.join(ROOT, SOURCE);
const skills = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('agora-'))
    .map((entry) => entry.name);

const problems = [];
let pluginChanged = false;

for (const mirror of MIRRORS) {
    const mirrorDir = path.join(ROOT, mirror);

    // Skills that were removed or renamed in the source
    const stale = fs.existsSync(mirrorDir)
        ? fs.readdirSync(mirrorDir).filter((name) => name.startsWith('agora-') && !skills.includes(name))
        : [];
    for (const name of stale) {
        if (check) problems.push(`${mirror}/${name} is not in ${SOURCE}`);
        else fs.rmSync(path.join(mirrorDir, name), { recursive: true });
        if (mirror === PLUGIN_SKILLS) pluginChanged = true;
    }

    for (const skill of skills) {
        const from = path.join(sourceDir, skill);
        const to = path.join(mirrorDir, skill);

        const wanted = listFiles(from);
        const found = listFiles(to);
        const differences = [];
        for (const file of wanted) {
            const label = `${mirror}/${skill}/${file.split(path.sep).join('/')}`;
            if (!found.includes(file)) differences.push(`${label} is missing`);
            else if (!fs.readFileSync(path.join(from, file)).equals(fs.readFileSync(path.join(to, file)))) {
                differences.push(`${label} differs from ${SOURCE}`);
            }
        }
        for (const file of found.filter((f) => !wanted.includes(f))) {
            differences.push(`${mirror}/${skill}/${file.split(path.sep).join('/')} is not in ${SOURCE}`);
        }
        if (differences.length === 0) continue;

        if (mirror === PLUGIN_SKILLS) pluginChanged = true;
        if (check) {
            problems.push(...differences);
        } else {
            fs.rmSync(to, { recursive: true, force: true });
            fs.cpSync(from, to, { recursive: true });
        }
    }
}

// The plugin manifests and the two marketplace files must agree on the plugin.
const manifests = MANIFESTS.map((rel) => ({ rel, json: readJson(rel) }));
const versions = [...new Set(manifests.map((m) => m.json.version))];
const names = [...new Set(manifests.map((m) => m.json.name))];
if (versions.length !== 1) problems.push(`Plugin versions differ: ${manifests.map((m) => `${m.rel} ${m.json.version}`).join(', ')}`);
if (!/^\d+\.\d+\.\d+$/.test(versions[0])) problems.push(`Plugin version "${versions[0]}" is not MAJOR.MINOR.PATCH`);
if (names.length !== 1) problems.push(`Plugin names differ: ${manifests.map((m) => `${m.rel} ${m.json.name}`).join(', ')}`);
for (const rel of MARKETPLACES) {
    const entry = (readJson(rel).plugins || []).find((p) => p.name === names[0]);
    const source = entry && (typeof entry.source === 'string' ? entry.source : entry.source && entry.source.path);
    if (!entry) problems.push(`${rel} has no "${names[0]}" plugin entry`);
    else if (source !== `./${PLUGIN}`) problems.push(`${rel}: "${names[0]}" points at ${source}, not ./${PLUGIN}`);
    else if (entry.version) problems.push(`${rel}: "${names[0]}" sets a version; keep it in the plugin manifests only`);
}

if (!check && pluginChanged && problems.length === 0) {
    const [major, minor, patch] = versions[0].split('.').map(Number);
    const next = `${major}.${minor}.${patch + 1}`;
    for (const m of manifests) writeJson(m.rel, { ...m.json, version: next });
    console.log(`Plugin skills changed: agora-skills version ${versions[0]} -> ${next}.`);
}

// With --base: the plugin's skills changed since that ref, so its version must too.
if (check && base) {
    const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
    const before = git('show', `${base}:${MANIFESTS[0]}`);
    if (before.status === 0) {
        const diff = git('diff', '--quiet', base, '--', PLUGIN_SKILLS);
        if (diff.status === 1 && JSON.parse(before.stdout).version === versions[0]) {
            problems.push(`${PLUGIN_SKILLS} changed since ${base} but the plugin version is still ${versions[0]}. Run: node scripts/sync-skills.js`);
        } else if (diff.status > 1) {
            problems.push(`git diff against ${base} failed: ${diff.stderr.trim()}`);
        }
    }
}

if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem(s).${check ? ' Run: node scripts/sync-skills.js' : ''}`);
    process.exit(1);
}

console.log(check
    ? `${skills.length} skills match in ${MIRRORS.length} folders; plugin agora-skills ${versions[0]}.`
    : `Copied ${skills.length} skills to ${MIRRORS.join(', ')}.`);

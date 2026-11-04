#!/usr/bin/env node
/**
 * Copy the Agora skills to every folder an agent looks for them in, and into the
 * agora-skills plugin (plugins/agora-skills/skills) that Claude Code and Codex install.
 *
 * .claude/skills/agora-* is the source. Edit the skills there, then run this.
 *
 * When the plugin's skills differ from the base ref (origin/main by default), this also
 * raises the patch version in both plugin manifests, once, to one above the base's.
 * Installed plugins update only when that version rises, so every change to the skills
 * reaches users.
 *
 * Usage:
 *   node scripts/sync-skills.js                  # Overwrite the copies with the source
 *   node scripts/sync-skills.js --base <ref>     # Same, raising the version against <ref>
 *   node scripts/sync-skills.js --check          # Change nothing; exit 1 if a copy differs
 *   node scripts/sync-skills.js --check --base origin/main
 *                                                # Also fail if the plugin's skills changed
 *                                                # since that ref without a higher version
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
            problems.push(...differences.map((d) => `${d}. Run: node scripts/sync-skills.js`));
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

// The version installed plugins compare. It must rise whenever the plugin's skills change.
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
const parse = (v) => v.split('.').map(Number);
const greater = (a, b) => {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
};
const bumpPatch = (v) => { const [major, minor, patch] = parse(v); return `${major}.${minor}.${patch + 1}`; };

// What the base ref says, or why there is nothing to compare against.
function readBase(ref, { required }) {
    if (/^0+$/.test(ref)) return { skip: `no base commit (${ref}): first push of a branch` };
    const resolved = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    if (resolved.status !== 0) {
        if (required) { problems.push(`Base ref "${ref}" is not a commit in this clone (fetch it, or check the name)`); return { failed: true }; }
        return { skip: `base ref ${ref} not found` };
    }
    const sha = resolved.stdout.trim();
    const versionAt = (commit) => {
        const shown = git('show', `${commit}:${MANIFESTS[0]}`);
        if (shown.status !== 0) return null;
        try {
            return JSON.parse(shown.stdout).version;
        } catch {
            problems.push(`${MANIFESTS[0]} at ${commit.slice(0, 12)} is not valid JSON`);
            return undefined;
        }
    };
    const tipVersion = versionAt(sha);
    if (tipVersion === undefined) return { failed: true };
    if (tipVersion === null) return { skip: `the plugin is not in ${ref} yet` };

    // Changes are counted from where this branch left the base, so a branch that is only
    // behind the base is not "changed". The version must still beat the base's tip.
    const mb = git('merge-base', 'HEAD', sha);
    const fork = mb.status === 0 ? mb.stdout.trim() : sha;
    const forkVersion = fork === sha ? tipVersion : versionAt(fork);
    if (forkVersion === undefined) return { failed: true };
    const from = forkVersion === null ? sha : fork;
    const diff = git('diff', '--quiet', from, '--', PLUGIN_SKILLS);
    if (diff.status > 1) {
        problems.push(`git diff against ${ref} failed: ${diff.stderr.trim()}`);
        return { failed: true };
    }
    const untracked = git('ls-files', '--others', '--exclude-standard', '--', PLUGIN_SKILLS).stdout.trim() !== '';
    const version = forkVersion && greater(forkVersion, tipVersion) ? forkVersion : tipVersion;
    return { version, changed: diff.status === 1 || untracked };
}

const versionOk = problems.length === 0;
if (check && base) {
    const b = readBase(base, { required: true });
    if (b.failed) { /* already reported */ } else if (b.skip) console.log(`Plugin version check skipped: ${b.skip}.`);
    else if (b.changed && !greater(versions[0], b.version)) {
        problems.push(`${PLUGIN_SKILLS} changed since ${base} but the plugin version ${versions[0]} is not above ${base}'s ${b.version}. Run: node scripts/sync-skills.js --base ${base}`);
    }
} else if (!check && versionOk) {
    // Raise the version once per change against the base (default origin/main, when this
    // clone has it), so repeated runs on one branch don't keep bumping. Without a base,
    // raise it whenever this run changed the plugin's copy.
    const b = readBase(base || 'origin/main', { required: Boolean(base) });
    let next = null;
    if (b.failed) {
        // already reported
    } else if (!b.skip) {
        if (b.changed && !greater(versions[0], b.version)) next = bumpPatch(b.version);
    } else if (pluginChanged) {
        next = bumpPatch(versions[0]);
    }
    if (next) {
        for (const m of manifests) writeJson(m.rel, { ...m.json, version: next });
        console.log(`Plugin skills changed: agora-skills version ${versions[0]} -> ${next}.`);
    }
}

if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem(s).`);
    process.exit(1);
}

console.log(check
    ? `${skills.length} skills match in ${MIRRORS.length} folders; plugin agora-skills ${versions[0]}.`
    : `Copied ${skills.length} skills to ${MIRRORS.join(', ')}.`);

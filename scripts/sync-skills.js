#!/usr/bin/env node
/**
 * Copy the Agora skills to every folder an agent looks for them in.
 *
 * .claude/skills/agora-* is the source. Edit the skills there, then run this.
 *
 * Usage:
 *   node scripts/sync-skills.js            # Overwrite the copies with the source
 *   node scripts/sync-skills.js --check    # Change nothing; exit 1 if a copy differs
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = '.claude/skills';
const MIRRORS = ['.agents/skills', '.codex/skills', '.gemini/skills', '.opencode/skills'];
const check = process.argv.includes('--check');

function listFiles(dir, base = dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
    });
}

const sourceDir = path.join(ROOT, SOURCE);
const skills = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('agora-'))
    .map((entry) => entry.name);

const problems = [];

for (const mirror of MIRRORS) {
    const mirrorDir = path.join(ROOT, mirror);

    // Skills that were removed or renamed in the source
    const stale = fs.existsSync(mirrorDir)
        ? fs.readdirSync(mirrorDir).filter((name) => name.startsWith('agora-') && !skills.includes(name))
        : [];
    for (const name of stale) {
        if (check) problems.push(`${mirror}/${name} is not in ${SOURCE}`);
        else fs.rmSync(path.join(mirrorDir, name), { recursive: true });
    }

    for (const skill of skills) {
        const from = path.join(sourceDir, skill);
        const to = path.join(mirrorDir, skill);

        if (!check) {
            fs.rmSync(to, { recursive: true, force: true });
            fs.cpSync(from, to, { recursive: true });
            continue;
        }

        const wanted = listFiles(from);
        const found = listFiles(to);
        for (const file of wanted) {
            const label = `${mirror}/${skill}/${file.split(path.sep).join('/')}`;
            if (!found.includes(file)) problems.push(`${label} is missing`);
            else if (!fs.readFileSync(path.join(from, file)).equals(fs.readFileSync(path.join(to, file)))) {
                problems.push(`${label} differs from ${SOURCE}`);
            }
        }
        for (const file of found.filter((f) => !wanted.includes(f))) {
            problems.push(`${mirror}/${skill}/${file.split(path.sep).join('/')} is not in ${SOURCE}`);
        }
    }
}

if (check && problems.length > 0) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} difference(s). Run: node scripts/sync-skills.js`);
    process.exit(1);
}

console.log(check
    ? `${skills.length} skills match in ${MIRRORS.length} folders.`
    : `Copied ${skills.length} skills to ${MIRRORS.join(', ')}.`);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * scripts/sync-skills.js keeps the skill copies and the agora-skills plugin in step with
 * .claude/skills, and the plugin version above the base's whenever the plugin's skills
 * change (installed plugins update only on a higher version). Each test runs the real
 * script in a throwaway git repo built from this repo's skill and plugin files.
 */
const projectRoot = join(__dirname, '..', '..');
const MANIFESTS = ['plugins/agora-skills/.claude-plugin/plugin.json', 'plugins/agora-skills/.codex-plugin/plugin.json'];
const COPIES = ['.claude/skills', '.agents/skills', '.codex/skills', '.gemini/skills', '.opencode/skills', 'plugins/agora-skills/skills'];

let repo: string;

const run = (...args: string[]) => spawnSync('node', ['scripts/sync-skills.js', ...args], { cwd: repo, encoding: 'utf8' });
const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
};
const version = (rel = MANIFESTS[0]) => JSON.parse(readFileSync(join(repo, rel), 'utf8')).version;
const setVersion = (v: string) => {
    for (const rel of MANIFESTS) {
        const json = JSON.parse(readFileSync(join(repo, rel), 'utf8'));
        writeFileSync(join(repo, rel), `${JSON.stringify({ ...json, version: v }, null, 2)}\n`);
    }
};
// Edit a skill in every copy at once, as a hand-made or cherry-picked change would.
const editEverywhere = (text: string) => {
    for (const dir of COPIES) appendFileSync(join(repo, dir, 'agora-plan', 'SKILL.md'), text);
};

beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'sync-skills-'));
    for (const rel of ['scripts/sync-skills.js', '.claude-plugin', '.agents/plugins', 'plugins/agora-skills', ...COPIES]) {
        cpSync(join(projectRoot, rel), join(repo, rel), { recursive: true });
    }
    git('init', '-q');
    setVersion('1.0.0');
    git('add', '-A');
    git('commit', '-qm', 'base');
});

afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
});

describe('sync-skills.js', () => {
    it('passes on a clean tree against its own base', () => {
        const r = run('--check', '--base', 'HEAD');
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
    });

    it('fails --check when a copy differs, and a plain sync fixes it and raises the version once', () => {
        appendFileSync(join(repo, '.claude/skills/agora-plan/SKILL.md'), '\nchanged\n');
        expect(run('--check').status).toBe(1);

        expect(run('--base', 'HEAD').status).toBe(0);
        expect(version()).toBe('1.0.1');
        expect(version(MANIFESTS[1])).toBe('1.0.1');
        // A second run on the same branch does not bump again.
        expect(run('--base', 'HEAD').status).toBe(0);
        expect(version()).toBe('1.0.1');
        expect(run('--check', '--base', 'HEAD').status).toBe(0);
    });

    it('fails when the skills changed but the version did not, and the suggested command fixes it', () => {
        editEverywhere('\nhand edit\n');
        const r = run('--check', '--base', 'HEAD');
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/not above HEAD's 1\.0\.0\. Run: node scripts\/sync-skills\.js --base HEAD/);

        expect(run('--base', 'HEAD').status).toBe(0);
        expect(version()).toBe('1.0.1');
        expect(run('--check', '--base', 'HEAD').status).toBe(0);
    });

    it('fails when the skills changed and the version went down', () => {
        setVersion('1.0.1');
        git('commit', '-qam', 'release 1.0.1');
        editEverywhere('\nanother edit\n');
        setVersion('1.0.0');
        const r = run('--check', '--base', 'HEAD');
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/1\.0\.0 is not above HEAD's 1\.0\.1/);
    });

    it('fails on a base ref that does not exist instead of skipping the check', () => {
        const r = run('--check', '--base', 'no-such-ref');
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Base ref "no-such-ref" is not a commit/);
    });

    it('skips the version check for an all-zero base (first push of a branch)', () => {
        editEverywhere('\nedit\n');
        const r = run('--check', '--base', '0000000000000000000000000000000000000000');
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/skipped: no base commit/);
    });

    it('skips the version check when the base commit has no plugin yet', () => {
        rmSync(join(repo, 'plugins'), { recursive: true });
        git('add', '-A');
        git('commit', '-qm', 'before the plugin');
        const before = git('rev-parse', 'HEAD');
        git('checkout', '-q', 'HEAD~1', '--', 'plugins');
        const r = run('--check', '--base', before);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/skipped: the plugin is not in/);
    });

    it('fails when the two manifests disagree on the version', () => {
        const rel = MANIFESTS[1];
        const json = JSON.parse(readFileSync(join(repo, rel), 'utf8'));
        writeFileSync(join(repo, rel), JSON.stringify({ ...json, version: '2.0.0' }));
        const r = run('--check');
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Plugin versions differ/);
    });

    // main moves to 1.0.1 with a skill edit while a branch cut at 1.0.0 is still open.
    const branchBehindMain = () => {
        git('branch', 'feature');
        editEverywhere('\nmain edit\n');
        setVersion('1.0.1');
        git('commit', '-qam', 'main: release 1.0.1');
        git('branch', 'main-tip');
        git('checkout', '-q', 'feature');
    };

    it('does not bump a branch that is only behind the base', () => {
        branchBehindMain();
        expect(run('--base', 'main-tip').status).toBe(0);
        expect(version()).toBe('1.0.0');
        expect(run('--check', '--base', 'main-tip').status).toBe(0);
    });

    it('bumps a branch with its own skill edits above the base tip, not just above its branch point', () => {
        branchBehindMain();
        appendFileSync(join(repo, '.claude/skills/agora-fix/SKILL.md'), '\nbranch edit\n');
        expect(run('--base', 'main-tip').status).toBe(0);
        expect(version()).toBe('1.0.2');
        expect(run('--check', '--base', 'main-tip').status).toBe(0);
    });

    it('counts a new, not yet committed skill as a change', () => {
        cpSync(join(repo, '.claude/skills/agora-fix'), join(repo, '.claude/skills/agora-new'), { recursive: true });
        expect(run('--base', 'HEAD').status).toBe(0);
        expect(version()).toBe('1.0.1');
    });

    it('reports a base manifest that is not valid JSON instead of crashing', () => {
        writeFileSync(join(repo, MANIFESTS[0]), '{ not json');
        git('commit', '-qam', 'broken manifest');
        git('checkout', '-q', 'HEAD~1', '--', MANIFESTS[0]);
        const r = run('--check', '--base', 'HEAD');
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/is not valid JSON/);
        expect(r.stderr).not.toMatch(/SyntaxError/);
    });
});

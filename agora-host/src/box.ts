import { existsSync, readFileSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { z } from 'zod';
import { configSchema } from './config.js';
import { HostConfigError } from './terms.js';

/**
 * agora-host inside an agent box (docs/agent-boxes.md §8). Box mode needs both the
 * environment flag the box entrypoint sets and the marker file the box image ships, so a
 * variable alone can't turn on yeet mode on a machine.
 */
export const boxMode = {
    /** The image's marker file. Tests point this at a temporary file; nothing else changes it. */
    marker: '/etc/agora-box',
};
export function inBox(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.AGORA_HOST_IN_BOX === '1' && existsSync(boxMode.marker);
}

/**
 * The proxy variables a boxed CLI needs to reach allowed domains through the edge (§4.2).
 * Lowercase copies carry the same values: curl reads only lowercase http_proxy, git and
 * pip read either.
 */
const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'] as const;
export function proxyVars(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of PROXY_VARS) {
        const value = source[name];
        if (value === undefined || !/^[^\r\n\0]{1,1000}$/.test(value)) continue;
        env[name] = value; env[name.toLowerCase()] = value;
    }
    return env;
}

/**
 * Codex's non-essential traffic, off in a box (docs/agent-boxes.md §4.2.1): usage metrics to
 * ab.chatgpt.com, feedback reports to Sentry, and the update check. Codex works without them;
 * the edge refuses those hosts anyway, and each refusal would cost a request. Root-level `-c`
 * overrides, accepted by `codex exec`, `codex app-server` and `codex login` alike (Codex
 * type-checks them, so a renamed key fails loudly).
 */
export const CODEX_BOX_QUIET = ['-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'check_for_update_on_startup=false'] as const;

/** Claude Code's equivalent, as environment variables (code.claude.com/docs/en/network-config). */
export const CLAUDE_BOX_QUIET = {
    // Telemetry, error reports, auto-updates, /feedback, release notes and feature flags
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    // The official plugin marketplace is cloned from github.com, which a box reaches only
    // through the git broker: every start would make a card
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
} as const;

/** The pinned CLIs in the box image (box/Dockerfile links them here). */
export const BOX_CLI = { claude: '/opt/agora/bin/claude', codex: '/opt/agora/bin/codex' } as const;
export const BOX_MCP = '/opt/agora/agora-mcp/dist/index.js';
export const BOX_HOME = '/home/agent';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const repo = z.string().max(141).refine(s => {
    const [owner, name, ...rest] = s.split('/');
    return rest.length === 0 && OWNER.test(owner ?? '') && REPO.test(name ?? '') && name !== '.' && name !== '..' && !name!.endsWith('.git');
}, 'repo');
const boxProfile = z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
    adapter: z.enum(['claude', 'codex']),
    auth: z.enum(['subscription', 'api_key']),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable().default(null),
    workdirAlias: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).default('work'),
    repos: z.array(repo).max(20).default([]),
}).passthrough();
export type BoxProfile = z.infer<typeof boxProfile>;

/** The box's profile from AGORA_BOX_PROFILE. Errors name the problem, never a value. */
export function readBoxProfile(env: NodeJS.ProcessEnv): BoxProfile {
    let raw: unknown;
    try { raw = JSON.parse(env.AGORA_BOX_PROFILE ?? ''); } catch { throw new HostConfigError('AGORA_BOX_PROFILE is not JSON'); }
    const parsed = boxProfile.safeParse(raw);
    if (!parsed.success) throw new HostConfigError(`AGORA_BOX_PROFILE is invalid (${[...new Set(parsed.error.issues.map(i => i.path.join('.') || i.code))].join(', ')})`);
    const p = parsed.data;
    if (p.auth === 'api_key' && !p.apiKeyEnv) throw new HostConfigError('AGORA_BOX_PROFILE: auth "api_key" needs apiKeyEnv');
    if (p.auth !== 'api_key' && p.apiKeyEnv) throw new HostConfigError('AGORA_BOX_PROFILE: apiKeyEnv is only used with auth "api_key"');
    return p;
}

export interface BoxPaths { home: string; exists?(path: string): boolean; readFile?(path: string): string | null }

/** The repository folder for `owner/repo`: ~/work/<owner>/<repo>, so two owners' repos never share one. */
export const repoDir = (home: string, ownerRepo: string) => posix.join(home, 'work', ...ownerRepo.split('/'));
/** The fallback workdir, outside ~/work so it can't be any owner/repo's folder. */
export const scratchDir = (home: string) => posix.join(home, 'scratch');

/** The clone's origin is `owner/repo` through the edge (its .git/config says so). */
export function originMatches(gitConfig: string | null, instanceUrl: string, ownerRepo: string): boolean {
    if (!gitConfig) return false;
    const want = `${instanceUrl.trim().replace(/\/+$/, '')}/git/github.com/${ownerRepo}.git`;
    // git merges repeated [remote "origin"] sections, so every one of them counts; exactly one
    // url, the expected one, and no pushurl that would send pushes elsewhere
    const sections = [...gitConfig.matchAll(/^\s*\[remote "origin"\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/gm)].map(m => m[1]).join('\n');
    const urls = [...sections.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)].map(m => m[1]);
    const pushUrls = [...sections.matchAll(/^\s*pushurl\s*=/gm)];
    return urls.length === 1 && urls[0] === want && pushUrls.length === 0;
}

/**
 * agora-host's config for this box, from the environment boxd sets (docs/agent-boxes.md
 * §8.1). The workdir is the first attached repo when its clone exists and its origin is that
 * repo, else ~/scratch (the entrypoint makes it): a failed clone never stops the box, and a
 * kept home never passes one repo's clone off as another's.
 */
export function boxConfig(env: NodeJS.ProcessEnv, paths: BoxPaths = { home: BOX_HOME }) {
    const missing = ['AGORA_INSTANCE_URL', 'AGORA_HOST_TOKEN', 'AGORA_BOT_ID', 'AGORA_BOT_TOKEN', 'AGORA_BOX_PROFILE'].filter(n => !env[n]?.trim());
    if (missing.length) throw new HostConfigError(`Box environment is missing ${missing.join(', ')}`);
    if (!isAbsolute(paths.home)) throw new HostConfigError('Box home must be an absolute path');
    if (!ULID.test(env.AGORA_BOT_ID!)) throw new HostConfigError('AGORA_BOT_ID is not an ID');
    const profile = readBoxProfile(env);
    const exists = paths.exists ?? existsSync;
    const read = paths.readFile ?? ((p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } });
    const first = profile.repos[0];
    const firstDir = first ? repoDir(paths.home, first) : null;
    const workdir = first && firstDir && exists(posix.join(firstDir, '.git'))
        && originMatches(read(posix.join(firstDir, '.git', 'config')), env.AGORA_INSTANCE_URL!, first)
        ? firstDir : scratchDir(paths.home);
    const config = {
        instance: env.AGORA_INSTANCE_URL!.trim().replace(/\/?$/, '/'),
        hostToken: env.AGORA_HOST_TOKEN!.trim(),
        mcp: { executable: process.execPath, entrypoint: BOX_MCP },
        profiles: {
            [profile.name]: {
                adapter: profile.adapter, executable: BOX_CLI[profile.adapter], workdir, workdirAlias: profile.workdirAlias,
                stateDir: posix.join(paths.home, '.agora', 'state', profile.name), auth: profile.auth,
                ...(profile.auth === 'api_key' ? { apiKeyEnv: profile.apiKeyEnv! } : {}),
                // HTTPS_PROXY/HTTP_PROXY/NO_PROXY reach the CLI (§4.2); honoured only in box mode
                proxyEnv: true,
            },
        },
        botTokens: { [env.AGORA_BOT_ID!]: env.AGORA_BOT_TOKEN!.trim() },
    };
    const checked = configSchema.safeParse(config);
    // Custom issue messages are fixed text; paths name fields, never values
    if (!checked.success) throw new HostConfigError(`Box config is invalid (${[...new Set(checked.error.issues.map(i => i.path.join('.') || i.code))].join(', ')})`);
    return config;
}

/**
 * agora-host box-config --repos | --out <file> [--home <dir>]
 * --repos: check the environment and print the attached repos, one `owner/repo` per line.
 * --out: write the host config (mode 0600) for agora-host --config.
 */
export async function boxConfigCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
    const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const home = flag('--home') ?? BOX_HOME;
    try {
        if (args.includes('--repos')) {
            boxConfig(env, { home, exists: () => false });
            for (const r of readBoxProfile(env).repos) process.stdout.write(`${r}\n`);
            return 0;
        }
        const out = flag('--out');
        if (!out || !isAbsolute(out)) { console.error('Usage: agora-host box-config --repos | --out <absolute-file> [--home <dir>]'); return 2; }
        const config = boxConfig(env, { home });
        await writeFile(out, JSON.stringify(config, null, 2), { mode: 0o600 });
        await chmod(out, 0o600);
        return 0;
    } catch (err) {
        console.error(err instanceof HostConfigError ? err.message : 'box_config_failed');
        return 2;
    }
}

import { mkdir, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config, LocalProfile } from './config.js';
import type { Claim, Result } from './types.js';
import { wakePrompt } from './prompt.js';

export interface Launch {
    executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string;
    adapter: 'codex' | 'claude'; cleanup(): Promise<void>;
}
export const resultSchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
const osKeys = new Set(['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC']);
export function childEnv(profile: LocalProfile, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(source)) if (osKeys.has(key.toUpperCase()) && value !== undefined) env[key] = value;
    env[profile.adapter === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = profile.stateDir;
    return env;
}
export async function verifyProfile(profile: LocalProfile): Promise<string> {
    const { stdout } = await promisify(execFile)(profile.executable, ['--version'], {
        env: childEnv(profile), cwd: profile.workdir, windowsHide: true, timeout: 10000, maxBuffer: 4096,
    });
    const version = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    const tested = version && (profile.adapter === 'codex' ? version[1] === '0' && version[2] === '163' : version[1] === '2' && version[2] === '1');
    if (!version || (!tested && !profile.allowUntestedVersion)) throw new Error('unsupported_cli_version');
    return version[0];
}

export async function prepare(config: Config, claim: Claim): Promise<Launch> {
    const local = config.profiles[claim.profile.name];
    if (!local || local.adapter !== claim.profile.adapter || local.workdirAlias !== claim.profile.workdirAlias) throw new Error('unmapped_profile');
    const token = config.botTokens[claim.profile.botId];
    if (!token) throw new Error('missing_bot_token');
    const efforts = local.adapter === 'codex' ? ['minimal', 'low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high', 'xhigh', 'max'];
    const { model, effort } = claim.profile;
    if (effort !== null && !efforts.includes(effort)) throw new Error('unsupported_effort');
    if (claim.session.nativeSessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claim.session.nativeSessionId)) throw new Error('invalid_native_session_id');
    await mkdir(local.stateDir, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(local.stateDir, 'run-'));
    const paths = ['mcp.json', 'mcp.toml', 'schema.json'].map(p => join(dir, p));
    const cleanup = async () => {
        // Only remove these known files and the empty directory we created; no recursive deletion.
        await Promise.all(paths.map(p => unlink(p).catch(() => {})));
        await rmdir(dir).catch(() => {});
    };
    try {
        const env = { ...childEnv(local), AGORA_INSTANCE: config.instance, AGORA_BOT_TOKEN: token, AGORA_DEFAULT_CHANNEL: claim.session.channelId };
        const server = { command: config.mcp.executable, args: [config.mcp.entrypoint] };
        await writeFile(paths[0], JSON.stringify({ mcpServers: { agora: server } }), { mode: 0o600 });
        await writeFile(paths[2], JSON.stringify(resultSchema), { mode: 0o600 });
        let args: string[];
        if (local.adapter === 'codex') {
            // A top-level CLI override replaces the MCP map: inherited servers/tokens are not passed through.
            const tools = local.approvedTools.map(t => `${t}={approval_mode="never"}`).join(',');
            const mcp = `{agora={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},env_vars=["AGORA_INSTANCE","AGORA_BOT_TOKEN","AGORA_DEFAULT_CHANNEL"],required=true,tools={${tools}}}}`;
            await writeFile(paths[1], `mcp_servers=${mcp}\n`, { mode: 0o600 });
            args = ['exec', '--ignore-user-config', '-s', local.sandbox,
                '-c', 'approval_policy="never"', '-c', `mcp_servers=${mcp}`,
                ...(model !== null ? ['-m', model] : []),
                ...(effort !== null ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
                ...(claim.session.nativeSessionId ? ['resume', claim.session.nativeSessionId] : []),
                '--json', '--output-schema', paths[2], '-'];
        } else {
            args = ['-p', '--output-format', 'json', '--permission-mode', 'manual', '--permission-prompts', 'none',
                '--strict-mcp-config', '--mcp-config', paths[0],
                ...(model !== null ? ['--model', model] : []),
                ...(effort !== null ? ['--effort', effort] : []),
                '--json-schema', JSON.stringify(resultSchema),
                ...(local.approvedTools.length ? ['--allowedTools', local.approvedTools.map(t => `mcp__agora__${t}`).join(',')] : []),
                ...(local.caps.maxBudgetUsd !== undefined ? ['--max-budget-usd', String(local.caps.maxBudgetUsd)] : []),
                ...(claim.session.nativeSessionId ? ['--resume', claim.session.nativeSessionId] : [])];
        }
        return { executable: local.executable, args, env, cwd: local.workdir, adapter: local.adapter, stdin: wakePrompt(claim), cleanup };
    } catch (err) { await cleanup(); throw err; }
}

const numeric = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function sumUsage(usage: unknown, keys: string[]): number | null {
    if (!usage || typeof usage !== 'object') return null;
    const u = usage as Record<string, unknown>;
    if (!numeric(u.input_tokens) || !numeric(u.output_tokens)) return null;
    const values = keys.map(k => u[k] ?? 0);
    if (!values.every(numeric)) return null;
    const total = values.reduce((a, b) => a + b, 0);
    return Number.isSafeInteger(total) ? total : null;
}
function summary(value: unknown): string | null {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    return value && typeof value === 'object' && typeof (value as { summary?: unknown }).summary === 'string'
        ? (value as { summary: string }).summary.slice(0, 16000) : null;
}
export function parseOutput(adapter: 'codex' | 'claude', stdout: string, exitCode: number | null): Result {
    let nativeSessionId: string | null = null; let tokensUsed: number | null = null; let final: string | null = null; let success = false;
    try {
        if (adapter === 'claude') {
            const r = JSON.parse(stdout);
            nativeSessionId = typeof r.session_id === 'string' ? r.session_id : null;
            tokensUsed = sumUsage(r.usage, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']);
            final = summary(r.structured_output ?? r.result);
            success = r.type === 'result' && r.subtype === 'success' && r.is_error === false && final !== null;
        } else {
            for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
                const e = JSON.parse(line);
                if (e.type === 'thread.started' && typeof e.thread_id === 'string') nativeSessionId = e.thread_id;
                if (e.type === 'item.completed' && e.item?.type === 'agent_message') final = summary(e.item.text);
                if (e.type === 'turn.completed') {
                    const used = sumUsage(e.usage, ['input_tokens', 'output_tokens']);
                    tokensUsed = used === null ? null : (tokensUsed ?? 0) + used; success = true;
                }
                if (e.type === 'turn.failed') success = false;
            }
            success &&= final !== null;
        }
    } catch { success = false; }
    success &&= exitCode === 0;
    return { success, nativeSessionId, tokensUsed, summary: final, ...(success ? {} : { error: 'cli_failed_or_invalid_output' }) };
}

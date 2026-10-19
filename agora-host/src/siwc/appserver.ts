import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Launch } from '../adapters.js';
import type { RunningChild } from '../process.js';
import type { RateLimit, Result } from '../types.js';
import { AGENT_NAME } from './oauth.js';

/**
 * Codex app-server on a ChatGPT plan (docs/codex-chatgpt-plan.md), as OpenAI documents it:
 * https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
 *
 * - `codex app-server --listen stdio://` with the `openai_chatgpt_plan` Responses provider
 *   (`env_key="ACCESS_TOKEN"`, `requires_openai_auth=false`, `supports_websockets=false`). The
 *   OAuth access token goes into the child's environment as ACCESS_TOKEN, never its argv. Codex
 *   sends it as the Bearer token to /v1/responses; no Codex login is used.
 * - JSON-RPC over stdio: `initialize` (clientInfo name matching the agent_name_hint) →
 *   `initialized` → `thread/start` or `thread/resume` → `turn/start`, then read notifications
 *   until `turn/completed`; only status `completed` is success.
 * - Codex doesn't refresh the token. On a 401 the host refreshes it, restarts app-server with
 *   the new ACCESS_TOKEN, sends `initialize` again and `thread/resume`s the saved thread, once.
 */

export const PROVIDER_ARGS = [
    '-c', 'model_provider="openai_chatgpt_plan"',
    '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
    '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
    '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
    '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"',
    '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
    '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false',
];

export const HOST_VERSION = '0.1.0';
const CONTINUE_PROMPT = 'Your previous turn was interrupted because the ChatGPT access token had to be renewed. Continue the task where you stopped, without repeating steps that already succeeded.';

export interface AppServerPlan {
    threadId: string | null;
    prompt: string;
    outputSchema: object | null;
    model: string | null;
    effort: string | null;
    sandbox: 'read-only' | 'workspace-write';
    /** Force a token refresh after a 401 and return the new access token. */
    refresh(): Promise<string>;
    /** Abort a stuck RPC (ms); a turn itself is bounded by the run timeout. */
    rpcTimeoutMs?: number;
}

const numeric = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function summary(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (value.trim() === '[pass]') return '[pass]';
    try {
        const v = JSON.parse(value);
        if (v && typeof v === 'object' && typeof v.summary === 'string') return v.summary.slice(0, 16000);
    } catch { /* not JSON */ }
    return null;
}

/** What a failed turn's error means for a ChatGPT-plan run (errors-and-recovery). */
export function classifyTurnError(error: any): { kind: 'unauthorized' | 'not_eligible' | 'scope' | 'usage_limit' | 'other'; resetAt?: string | null } {
    const info = error?.codexErrorInfo;
    const text = `${typeof error?.message === 'string' ? error.message : ''} ${typeof error?.additionalDetails === 'string' ? error.additionalDetails : ''}`;
    const status = info && typeof info === 'object' ? Object.values(info as Record<string, any>)[0]?.httpStatusCode : undefined;
    if (/subscription_sharing_user_not_eligible/.test(text)) return { kind: 'not_eligible' };
    if (/chatpass_v2_scope_not_authorized|chatpass_v2_invalid_authorization_context/.test(text)) return { kind: 'scope' };
    if (info === 'usageLimitExceeded' || /subscription_sharing_usage_limit_exceeded/.test(text) || status === 429) return { kind: 'usage_limit', resetAt: null };
    if (info === 'unauthorized' || status === 401 || /subscription_sharing_invalid_user/.test(text)) return { kind: 'unauthorized' };
    if (status === 403) return { kind: 'not_eligible' };
    return { kind: 'other' };
}

interface Rpc {
    child: ChildProcessWithoutNullStreams;
    request(method: string, params: unknown): Promise<any>;
    notify(method: string, params: unknown): void;
    onNotification(fn: (method: string, params: any) => void): void;
    closed: Promise<number | null>;
}

function startRpc(launch: Launch, env: NodeJS.ProcessEnv, timeoutMs: number): Rpc {
    const child = spawn(launch.executable, launch.args, {
        cwd: launch.cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let nextId = 1;
    const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
    const listeners: Array<(m: string, p: any) => void> = [];
    let buffer = '';
    let size = 0;
    const write = (msg: unknown) => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(msg)}\n`); };
    const closed = new Promise<number | null>(resolve => {
        child.on('close', code => {
            for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('app_server_exited')); }
            pending.clear(); resolve(code);
        });
        child.on('error', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('spawn_failed')); } pending.clear(); resolve(null); });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) { child.kill(); return; }
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg: any;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id !== undefined && msg.method === undefined) {
                const p = pending.get(msg.id);
                if (!p) continue;
                pending.delete(msg.id); clearTimeout(p.timer);
                if (msg.error) p.reject(Object.assign(new Error('rpc_error'), { rpc: msg.error })); else p.resolve(msg.result);
            } else if (msg.id !== undefined && typeof msg.method === 'string') {
                // A server request (approval, user input): the host has no one to ask, so it declines
                const decline = /requestApproval$/.test(msg.method) ? { result: { decision: 'decline' } }
                    : { error: { code: -32601, message: 'Not supported by agora-host' } };
                write({ id: msg.id, ...decline });
            } else if (typeof msg.method === 'string') {
                for (const fn of listeners) fn(msg.method, msg.params);
            }
        }
    });
    // Drain stderr, never forward it: it may echo request details
    child.stderr.resume();
    child.stdin.on('error', () => {});
    return {
        child, closed,
        request(method, params) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(id); reject(new Error('rpc_timeout')); }, timeoutMs);
                pending.set(id, { resolve, reject, timer });
                write({ id, method, params });
            });
        },
        notify(method, params) { write({ method, params }); },
        onNotification(fn) { listeners.push(fn); },
    };
}

async function killTree(child: ChildProcessWithoutNullStreams, closed: Promise<unknown>): Promise<void> {
    if (child.exitCode !== null || !child.pid) return;
    try {
        if (process.platform === 'win32') {
            await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
                ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
        } else process.kill(-child.pid, 'SIGKILL');
    } catch {
        if (child.exitCode === null) { child.kill('SIGKILL'); throw new Error('process_tree_kill_failed'); }
    }
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('process_tree_close_timeout')), 5000); })]); }
    finally { clearTimeout(timer!); }
}

/** Run one wake through app-server. The launch's env carries ACCESS_TOKEN; its args never do. */
export function startAppServer(launch: Launch & { appServer: AppServerPlan }): RunningChild {
    const plan = launch.appServer;
    let current: Rpc | undefined;
    let stopped = false;
    let tokens = 0;
    const changed = new Set<string>();
    let threadId = plan.threadId;
    let final: string | null = null;

    const runTurn = async (env: NodeJS.ProcessEnv, prompt: string, resume: boolean): Promise<{ status: string; error: any }> => {
        const rpc = startRpc(launch, env, plan.rpcTimeoutMs ?? 120000);
        current = rpc;
        let turnId: string | null = null;
        let done!: (v: { status: string; error: any }) => void;
        const completed = new Promise<{ status: string; error: any }>(r => { done = r; });
        const early: Array<{ status: string; error: any; id: string }> = [];
        rpc.onNotification((method, params) => {
            if (method === 'item/completed') {
                const item = params?.item;
                if (item?.type === 'fileChange' && item.status !== 'failed' && item.status !== 'declined') {
                    for (const c of item.changes ?? [])
                        if (typeof c?.path === 'string' && c.path.length > 0 && c.path.length <= 4096 && changed.size < 1000) changed.add(c.path);
                }
                if (item?.type === 'agentMessage' && typeof item.text === 'string') final = item.text;
            } else if (method === 'thread/tokenUsage/updated') {
                // `last` is the latest model request's usage; summing them gives this run's tokens
                const last = params?.tokenUsage?.last;
                if (last && numeric(last.inputTokens) && numeric(last.outputTokens)) tokens += last.inputTokens + last.outputTokens;
            } else if (method === 'turn/completed') {
                const t = params?.turn;
                const outcome = { status: String(t?.status ?? 'failed'), error: t?.error ?? null, id: String(t?.id ?? '') };
                if (turnId === null) early.push(outcome); else if (outcome.id === turnId) done(outcome);
            }
        });
        const exited = rpc.closed.then(() => ({ status: 'exited', error: null }));
        try {
            await rpc.request('initialize', { clientInfo: { name: AGENT_NAME, title: AGENT_NAME, version: HOST_VERSION }, capabilities: null });
            rpc.notify('initialized', {});
            const common = { cwd: launch.cwd, approvalPolicy: 'never', sandbox: plan.sandbox, ...(plan.model ? { model: plan.model } : {}) };
            const thread = resume && threadId
                ? await rpc.request('thread/resume', { threadId, excludeTurns: true, ...common })
                : await rpc.request('thread/start', { ...common, serviceName: 'agora' });
            const id = thread?.thread?.id;
            if (typeof id !== 'string' || !id) throw new Error('app_server_bad_thread');
            threadId = id;
            const turn = await rpc.request('turn/start', {
                threadId, input: [{ type: 'text', text: prompt }],
                ...(plan.effort ? { effort: plan.effort } : {}), ...(plan.outputSchema ? { outputSchema: plan.outputSchema } : {}),
            });
            turnId = String(turn?.turn?.id ?? '');
            const already = early.find(e => e.id === turnId);
            if (already) done(already);
            return await Promise.race([completed, exited]);
        } catch (err: any) {
            // A failed request (e.g. thread/resume) or an exit: treat as a failed turn
            return { status: 'failed', error: err?.rpc ?? null };
        }
    };

    const result = (async (): Promise<Result> => {
        let env = { ...launch.env };
        let outcome = await runTurn(env, plan.prompt, !!threadId);
        let kind = outcome.status === 'completed' ? null : classifyTurnError(outcome.error);
        if (!stopped && kind?.kind === 'unauthorized') {
            // Codex doesn't refresh: renew, restart app-server with the new token, resume the thread
            if (current) await killTree(current.child, current.closed).catch(() => {});
            try {
                const token = await plan.refresh();
                env = { ...env, ACCESS_TOKEN: token };
                if (!stopped) {
                    outcome = await runTurn(env, CONTINUE_PROMPT, true);
                    kind = outcome.status === 'completed' ? null : classifyTurnError(outcome.error);
                }
            } catch (err: any) {
                const code = typeof err?.code === 'string' && /^siwc_[a-z_]+$/.test(err.code) ? err.code : 'siwc_reauth_required';
                if (current) await killTree(current.child, current.closed).catch(() => {});
                return { success: false, nativeSessionId: threadId, tokensUsed: tokens, summary: null, changedPaths: [...changed], error: code };
            }
        }
        if (current) await killTree(current.child, current.closed).catch(() => {});
        const parsed = summary(final);
        const success = !stopped && outcome.status === 'completed' && (parsed !== null || !!launch.lurk);
        let error: string | undefined; let rateLimit: RateLimit | undefined;
        if (!success) {
            switch (kind?.kind) {
                case 'not_eligible': error = 'siwc_not_eligible'; break;
                case 'scope': error = 'siwc_scope_missing'; break;
                case 'unauthorized': error = 'siwc_reauth_required'; break;
                case 'usage_limit': error = 'siwc_usage_limit'; rateLimit = { resetAt: kind.resetAt ?? null }; break;
                default: error = 'cli_failed_or_invalid_output';
            }
        }
        return {
            success, nativeSessionId: threadId, tokensUsed: tokens, summary: parsed === '[pass]' ? null : parsed, changedPaths: [...changed],
            ...(error ? { error } : {}), ...(rateLimit ? { rateLimit } : {}),
        };
    })();

    return {
        result,
        async kill() { stopped = true; if (current) await killTree(current.child, current.closed); },
        tokensUsed: () => tokens,
    };
}

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { Config, LocalProfile } from './config.js';
import { childEnv } from './adapters.js';
import { inBox } from './box.js';
import { boxAdapter, type BoxAdapterRuntime } from './box-adapters.js';
import { errorCode, fatalAuth, HttpError } from './client.js';
import { killTree } from './process.js';
import type { BoxLoginReport, BoxLoginRequest, HostApi } from './types.js';

/**
 * Log a CLI in inside its box (docs/agent-boxes.md §8.2). The owner presses Log in; this
 * host claims the request, runs the CLI's own login with the profile's state directory and
 * relays what the owner needs: Codex's device URL and code, or Claude's sign-in URL and then
 * the code the owner pastes back. The URL, the codes and the CLI's output are never logged.
 */

/**
 * The login command of a box adapter (box-adapters.ts `login`), after its quiet arguments, so
 * the CLI's non-essential traffic is off for the login too. null: the adapter has no login.
 */
export function loginArgs(adapter: string): string[] | null {
    const spec = boxAdapter(adapter);
    return spec?.login ? [...spec.quiet.args, ...spec.login.args] : null;
}
const MAX_OUTPUT = 64 * 1024;

export interface BoxLoginOptions {
    signal: AbortSignal;
    log(code: string): void;
    pause(ms: number): Promise<void>;
    stopping(): boolean;
    pollMs?: number;
    /** How often a Claude login asks Agora for the pasted code. */
    codePollMs?: number;
    /** The whole login, after which the CLI is stopped (10 minutes, as long as Agora keeps the URL). */
    timeoutMs?: number;
    /** How long the CLI has to print its URL (and code). */
    promptTimeoutMs?: number;
}

/** Terminal escapes out, OSC 8 hyperlink targets kept as text. */
export function plainText(raw: string): string {
    return raw.replace(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, ' $1 ')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b./g, '');
}

/**
 * The sign-in prompt in a CLI's output so far: a complete URL on the CLI's own sign-in host
 * and, for Codex, the one-time code (`ABCD-EFGHI`). A token counts only once whitespace
 * follows it, so a URL or code split across output chunks is never relayed half-printed.
 */
export function parsePrompt(adapter: string, raw: string): { url: string; code: string | null } | null {
    const login = boxAdapter(adapter)?.login;
    if (!login) return null;
    const text = plainText(raw);
    let url: string | null = null;
    for (const m of text.matchAll(/https:\/\/[^\s"'<>]+(?=\s)/g)) {
        const candidate = m[0].replace(/[.,;:)\]]+$/, '');
        let host: string;
        try { host = new URL(candidate).hostname.toLowerCase(); } catch { continue; }
        if (candidate.length > 2000 || !login.hosts.some(h => host === h || host.endsWith(`.${h}`))) continue;
        url = candidate; break;
    }
    if (!url) return null;
    // A pasted code comes from the owner later; a device login shows its one-time code now
    if (login.kind === 'paste') return { url, code: null };
    const code = /(?:^|\s)([A-Z0-9]{4}-[A-Z0-9]{4,6})(?=\s)/.exec(text.replace(/https:\/\/\S+/g, ' '));
    return code ? { url, code: code[1] } : null;
}

/** A pasted code goes to the CLI's input as one line: printable characters only. */
const PASTED_CODE = /^[\x21-\x7e]{1,512}$/;
const closed = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 409);

/** Handle one login request; exported for tests. */
export async function handleBoxLogin(config: Config, api: HostApi, req: BoxLoginRequest, o: BoxLoginOptions): Promise<void> {
    const report = (body: BoxLoginReport, signal: AbortSignal = o.signal) => api.reportBoxLogin!(req.id, body, signal);
    // A refusal before anything started; a closed login needs no answer
    const refuse = async (error: string) => { try { await report({ status: 'failed', error }); } catch (err) { if (!closed(err)) throw err; } };
    const local: LocalProfile | undefined = config.profiles[req.profile];
    if (!local || local.adapter !== req.adapter) { o.log('box_login_profile_unavailable'); await refuse('profile_unavailable'); return; }
    // An API-key profile has nothing to log in; ACP agents aren't the official CLI (terms.ts); an
    // adapter with no login in the box registry (opencode: an API key only) has none to relay
    const spec: BoxAdapterRuntime | null = boxAdapter(local.adapter);
    const args = loginArgs(local.adapter);
    if (local.auth !== 'subscription' || local.protocol !== 'cli' || !spec?.login || !args) {
        o.log('box_login_not_supported'); await refuse('login_not_supported'); return;
    }
    const adapter = local.adapter;
    const paste = spec.login.kind === 'paste';
    await mkdir(local.stateDir, { recursive: true, mode: 0o700 });
    o.log('box_login_started');
    let child: ChildProcess;
    try {
        // childEnv: the OS allowlist, the state directory (CODEX_HOME / CLAUDE_CONFIG_DIR) and
        // the proxy variables; never the host or bot token
        child = spawn(local.executable, args, { cwd: local.stateDir, env: childEnv(local), shell: false,
            windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) { o.log(`box_login_failed login_spawn_failed ${errorCode(err)}`); await refuse('login_spawn_failed'); return; }
    let output = ''; let isClosed = false; let spawnFailed = false;
    let notifyClose!: () => void;
    const closedEvent = new Promise<void>(resolve => { notifyClose = resolve; });
    const exit = new Promise<number | null>(resolve => {
        child.once('error', () => { spawnFailed = true; isClosed = true; notifyClose(); resolve(null); });
        child.once('close', code => { isClosed = true; notifyClose(); resolve(code); });
    });
    let wake: () => void = () => {};
    const collect = (chunk: string) => { if (output.length < MAX_OUTPUT) output += chunk.slice(0, MAX_OUTPUT - output.length); wake(); };
    child.stdout!.setEncoding('utf8'); child.stdout!.on('data', collect);
    child.stderr!.setEncoding('utf8'); child.stderr!.on('data', collect);
    child.stdin!.on('error', () => {});
    // A device login reads nothing; a paste login's input stays open for the pasted code
    if (!paste) child.stdin!.end();
    const kill = async () => { if (!isClosed && child.pid) await killTree(child, () => isClosed, closedEvent).catch(() => { o.log('process_tree_kill_failed'); }); };
    const started = Date.now();
    const timeoutMs = o.timeoutMs ?? 10 * 60 * 1000, promptMs = o.promptTimeoutMs ?? 60 * 1000;
    const deadline = (ms: number) => Math.max(0, started + ms - Date.now());
    // Resolves on output, exit, abort or the given time, whichever is first
    const next = (ms: number) => new Promise<void>(resolve => {
        const timer = setTimeout(done, ms);
        function done() { clearTimeout(timer); o.signal.removeEventListener('abort', done); wake = () => {}; resolve(); }
        wake = done; o.signal.addEventListener('abort', done, { once: true });
        void exit.then(done);
    });
    let detail = '';
    const finish = async (body: BoxLoginReport) => {
        await kill();
        // The host may be stopping: the last report gets its own short deadline
        try { await report(body, AbortSignal.timeout(5000)); } catch (err) { if (!closed(err)) o.log(`box_login_report_failed ${errorCode(err)}`); }
        // The reason is the host's own fixed code (and the CLI's exit status), never its output
        o.log(body.status === 'succeeded' ? 'box_login_succeeded' : `box_login_failed ${body.error ?? 'unknown'}${detail ? ` ${detail}` : ''}`);
    };
    try {
        // 1. Wait for the prompt
        let prompt = parsePrompt(adapter, output);
        while (!prompt && !isClosed && !o.signal.aborted && deadline(promptMs) > 0) {
            await next(deadline(promptMs)); prompt = parsePrompt(adapter, output);
        }
        if (o.signal.aborted) { await finish({ status: 'failed', error: 'host_stopped' }); return; }
        if (!prompt) {
            if (isClosed) { const code = await exit; await finish(code === 0 && !spawnFailed ? { status: 'succeeded' } : { status: 'failed', error: spawnFailed ? 'login_spawn_failed' : 'login_failed' }); }
            else await finish({ status: 'failed', error: 'login_prompt_not_found' });
            return;
        }
        await report(!paste ? { status: 'awaiting_user', verificationUrl: prompt.url, userCode: prompt.code! }
            : { status: 'awaiting_code', verificationUrl: prompt.url });
        // 2. A device login (Codex) finishes when the owner approves; a paste login (Claude) needs the code first
        const codeEvery = o.codePollMs ?? 2000;
        while (!isClosed && !o.signal.aborted && deadline(timeoutMs) > 0) {
            if (paste) {
                const code = await api.boxLoginCode!(req.id, o.signal);
                if (code !== null) {
                    if (PASTED_CODE.test(code)) child.stdin!.write(`${code}\n`);
                    else { await finish({ status: 'failed', error: 'invalid_code' }); return; }
                }
            }
            await next(Math.min(paste ? codeEvery : timeoutMs, deadline(timeoutMs)));
        }
        if (o.signal.aborted) { await finish({ status: 'failed', error: 'host_stopped' }); return; }
        if (!isClosed) { await finish({ status: 'failed', error: 'login_timeout' }); return; }
        const code = await exit;
        if (code !== 0) detail = `exit_${typeof code === 'number' ? code : 'signal'}`;
        await finish(code === 0 ? { status: 'succeeded' } : { status: 'failed', error: 'login_failed' });
    } catch (err) {
        await kill();
        // The owner cancelled, or the login expired: nothing more to say about it
        if (closed(err)) { o.log('box_login_closed'); return; }
        if (fatalAuth(err)) throw err;
        if (o.signal.aborted) { await finish({ status: 'failed', error: 'host_stopped' }); return; }
        detail = errorCode(err);
        await finish({ status: 'failed', error: 'login_relay_failed' });
    } finally {
        output = '';
    }
}

/** Poll for Log in requests on a loop of its own, like plan requests (siwc/requests.ts). Box mode only. */
export async function boxLoginLoop(config: Config, api: HostApi, o: BoxLoginOptions): Promise<void> {
    if (!inBox() || !api.claimBoxLogin || !api.reportBoxLogin || !api.boxLoginCode) return;
    while (!o.stopping()) {
        try {
            const req = await api.claimBoxLogin(o.signal);
            if (!req) { await o.pause(o.pollMs ?? 3000); continue; }
            await handleBoxLogin(config, api, req, o);
        } catch (err) {
            if (o.stopping()) return;
            if (fatalAuth(err)) { o.log(`host_auth_rejected ${errorCode(err)}`); return; }
            // A server without box logins: stop polling, runs keep working
            if (err instanceof HttpError && err.status === 404) { o.log('box_login_unsupported'); return; }
            o.log(`box_login_request_failed ${errorCode(err)}`);
            await o.pause(3000);
        }
    }
}

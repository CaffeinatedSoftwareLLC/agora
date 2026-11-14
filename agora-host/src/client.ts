import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { claimSchema, type BoxLoginReport, type BoxLoginRequest, type Claim, type Completion, type Failure, type Heartbeat, type HostApi, type PlanRequest, type PlanStatus, type Progress, type ProfileReport } from './types.js';
import type { ReviewCommand } from './review.js';
import type { PreviewCommand, PreviewOutcome } from './preview.js';
import { REPO, type GithubCommand, type GithubResult } from './github.js';
import { BOX_ADAPTER_NAMES } from './box-adapters.js';
import { COMMAND_NAMES, type CommandResult, type SessionCommand } from './session-commands.js';
import type { StreamEvent } from './stream.js';

export class HttpError extends Error {
    /** The server's own error code (`{ "error": "box_token_outside_box" }`), when it is one. */
    constructor(public readonly status: number, public readonly code: string | null = null) { super(`host_http_${status}`); }
}
/** A server error code is a short snake_case word; anything else (a message, a URL) is dropped. */
const SERVER_CODE = /^[a-z][a-z0-9_]{0,59}$/;
async function httpError(response: Response): Promise<HttpError> {
    let code: string | null = null;
    try {
        // At most 2 KB of an error body, then the rest is dropped: a proxy's error page is no
        // reason to buffer megabytes or wait for a slow body
        let text = '';
        const reader = response.body?.getReader();
        if (reader) {
            const decoder = new TextDecoder();
            while (text.length < 2048) {
                const { done, value } = await reader.read();
                if (done) break;
                text += decoder.decode(value, { stream: true });
            }
            await reader.cancel().catch(() => {});
        }
        const parsed = JSON.parse(text.slice(0, 2048)) as { error?: unknown };
        if (typeof parsed?.error === 'string' && SERVER_CODE.test(parsed.error)) code = parsed.error;
    } catch { /* no JSON body */ }
    return new HttpError(response.status, code);
}
/**
 * A short, fixed-vocabulary code for why a call failed, for the host's logs: the HTTP status and
 * the server's code, a timeout, or the network error's name. Never a URL, a message or a body.
 */
export function errorCode(err: unknown): string {
    if (err instanceof HttpError) return `http_${err.status}${err.code ? `_${err.code}` : ''}`;
    const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
    if (e && e.name === 'TimeoutError') return 'timeout';
    if (e && e.name === 'AbortError') return 'aborted';
    // fetch puts the socket's errno on its cause; a code on the error itself is something else
    const net = typeof e?.cause?.code === 'string' ? e.cause.code : null;
    if (net && /^[A-Z][A-Z0-9_]{1,29}$/.test(net)) return `network_${net.toLowerCase()}`;
    if (err instanceof SyntaxError || (e && e.name === 'ZodError')) return 'bad_response';
    return 'error';
}
export const fatalAuth = (err: unknown) => err instanceof HttpError && (err.status === 401 || err.status === 403);
export const fenced = (err: unknown) => err instanceof HttpError && (err.status === 409 || err.status === 404);
const heartbeatSchema = z.discriminatedUnion('cancel', [
    z.object({ cancel: z.literal(false), leaseUntil: z.string().datetime() }),
    z.object({ cancel: z.literal(true), reason: z.string() }),
]);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const stop = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
});

export class Client implements HostApi {
    constructor(private origin: string, private token: string, private fetcher: typeof fetch = fetch,
        private now: () => number = () => performance.now(), private retryDelayMs = 250) {}

    private async request(method: string, path: string, body: unknown, signal?: AbortSignal, timeoutMs = 10000): Promise<unknown> {
        const response = await this.fetcher(new URL(`/agent-hosts/@me/${path}`, this.origin), {
            method, headers: { Authorization: `AgentHost ${this.token}`, 'Content-Type': 'application/json' },
            redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw await httpError(response);
        if (response.status === 204) return null;
        // Content is capped while streaming, rather than after an unbounded allocation.
        let data = ''; const decoder = new TextDecoder();
        if (!response.body) throw new Error('host_empty_response');
        for await (const part of response.body) {
            data += decoder.decode(part, { stream: true });
            if (data.length > 1024 * 1024) throw new Error('host_response_too_large');
        }
        return JSON.parse(data + decoder.decode());
    }
    async claim(signal?: AbortSignal) {
        const sentAt = this.now();
        // Never automatically retry a claim: a lost response may already own a lease.
        const data = await this.request('GET', 'runs/next?wait=25', undefined, signal, 30000);
        return data === null ? null : { claim: claimSchema.parse(data), sentAt };
    }
    async workspaceStates(sessionIds: string[]): Promise<string[]> {
        return z.array(z.string()).parse(await this.request('POST', 'workspaces/reconcile', { sessionIds }));
    }
    async claimWorkspaceCommand(signal?: AbortSignal): Promise<ReviewCommand | null> {
        const data = await this.request('GET', 'workspace-commands/next', undefined, signal);
        if (data === null) return null;
        return z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), claimToken: z.string().min(10),
            sessionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), profile: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
            workdirAlias: z.string(), action: z.enum(['diff','discard','commit','merge','pr','restore','fork','pr_status']),
            payload: z.object({ path: z.string().max(4096).optional(), offset: z.number().int().min(0).max(131072).optional(),
                revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
                message: z.string().max(2000).optional(), forkSessionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
                checkpoint: z.object({ sha:z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),ref:z.string().max(128) }).optional() }),
        }).parse(data);
    }
    async workspaceCommandResult(cmd: ReviewCommand, success: boolean, result: object, signal?: AbortSignal): Promise<void> {
        // Retrying the report is safe; never retry the repository operation.
        for (let attempt=0;;attempt++) {
            try { await this.request('POST',`workspace-commands/${cmd.id}/result`,{claimToken:cmd.claimToken,success,result},signal); return; }
            catch (e) { if (attempt>=2 || signal?.aborted || e instanceof HttpError && e.status<500) throw e; await sleep(this.retryDelayMs,signal); }
        }
    }
    async claimGithubCommand(signal?: AbortSignal): Promise<GithubCommand | null> {
        const data = await this.request('GET', 'github-commands/next?v=2', undefined, signal);
        if (data === null) return null;
        return z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), claimToken: z.string().min(10),
            action: z.enum(['issue_list', 'issue_comment', 'issue_scan', 'link_info']), repo: z.string().regex(REPO),
            payload: z.object({ limit: z.number().int().min(1).max(200).optional(), number: z.number().int().min(1).optional(),
                body: z.string().max(1000).optional() }).passthrough(),
        }).parse(data);
    }
    async githubCommandResult(cmd: GithubCommand, success: boolean, result: GithubResult, signal?: AbortSignal): Promise<void> {
        // Retrying the report is safe; never retry the GitHub call (a comment would post twice).
        for (let attempt = 0; ; attempt++) {
            try { await this.request('POST', `github-commands/${cmd.id}/result`, { claimToken: cmd.claimToken, success, result }, signal); return; }
            catch (e) { if (attempt >= 2 || signal?.aborted || e instanceof HttpError && e.status < 500) throw e; await sleep(this.retryDelayMs, signal); }
        }
    }
    /**
     * A command sent to an agent from Agora (`v=1` tells the server this host knows the item). Only
     * hosts that ask are offered one, so an older host never sees a type it can't read.
     */
    async claimSessionCommand(signal?: AbortSignal): Promise<SessionCommand | null> {
        const data = await this.request('GET', 'session-commands/next?v=1', undefined, signal);
        if (data === null) return null;
        return z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), claimToken: z.string().min(10),
            sessionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), profile: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
            adapter: z.string().min(1).max(40), workdirAlias: z.string().min(1),
            nativeSessionId: z.string().min(1).max(128).nullable(), command: z.enum(COMMAND_NAMES), arg: z.string().max(100).nullable(),
        }).parse(data);
    }
    async sessionCommandResult(cmd: SessionCommand, success: boolean, result: CommandResult, signal?: AbortSignal): Promise<void> {
        // Retrying the report is safe; the command itself is never run twice
        for (let attempt = 0; ; attempt++) {
            try { await this.request('POST', `session-commands/${cmd.id}/result`, { claimToken: cmd.claimToken, success, result }, signal); return; }
            catch (e) { if (attempt >= 2 || signal?.aborted || e instanceof HttpError && e.status < 500) throw e; await sleep(this.retryDelayMs, signal); }
        }
    }
    async claimPreview(signal?: AbortSignal): Promise<PreviewCommand | null> {
        const data = await this.request('GET', 'browser-previews/next', undefined, signal);
        if (data === null) return null;
        return z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), claimToken: z.string().min(10),
            sessionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), profile: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
            workdirAlias: z.string(), url: z.string().url().max(2048),
            options: z.object({ width: z.number().int().min(320).max(1920), height: z.number().int().min(240).max(1600), fullPage: z.boolean() }),
        }).parse(data);
    }
    /** Fields first, then the PNG: the server reads the multipart body in order. */
    async previewResult(cmd: PreviewCommand, outcome: PreviewOutcome, signal?: AbortSignal): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            const form = new FormData();
            form.append('claimToken', cmd.claimToken);
            form.append('success', String(outcome.success));
            if (outcome.success) {
                form.append('title', outcome.capture.title);
                form.append('console', JSON.stringify(outcome.capture.console));
                form.append('screenshot', new Blob([new Uint8Array(outcome.capture.png)], { type: 'image/png' }), 'preview.png');
            } else {
                form.append('error', outcome.error);
                form.append('console', JSON.stringify(outcome.console ?? []));
            }
            try {
                const response = await this.fetcher(new URL(`/agent-hosts/@me/browser-previews/${cmd.id}/result`, this.origin), {
                    method: 'POST', headers: { Authorization: `AgentHost ${this.token}` }, body: form, redirect: 'error',
                    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
                });
                await response.body?.cancel();
                if (!response.ok) throw new HttpError(response.status);
                return;
            } catch (e) { if (attempt >= 2 || signal?.aborted || e instanceof HttpError && e.status < 500) throw e; await sleep(this.retryDelayMs, signal); }
        }
    }
    async workspaceWarning(sessionId: string, paths: string[]): Promise<void> {
        await this.request('POST', 'workspaces/warning', { sessionId, paths });
    }
    async imageMessages(claim: Claim, signal?: AbortSignal) {
        return z.object({ maxBytes: z.number().int().positive(), messages: z.array(z.object({ id: z.string(), content: z.string() })) })
            .parse(await this.request('POST', `runs/${claim.run.id}/images/discover`, { claimToken: claim.run.claimToken }, signal));
    }
    async uploadImage(claim: Claim, image: { messageId: string; reference: string; filename: string; buffer: Buffer }, signal?: AbortSignal): Promise<void> {
        const form = new FormData();
        form.append('claimToken', claim.run.claimToken);
        form.append('messageId', image.messageId);
        form.append('reference', image.reference);
        form.append('file', new Blob([new Uint8Array(image.buffer)]), image.filename);
        const response = await this.fetcher(new URL(`/agent-hosts/@me/runs/${claim.run.id}/images`, this.origin), {
            method: 'POST', headers: { Authorization: `AgentHost ${this.token}` }, body: form, redirect: 'error',
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new HttpError(response.status);
    }
    async heartbeat(claim: Claim, signal?: AbortSignal, tokensUsed?: number | null, progress?: Progress | null): Promise<Heartbeat> {
        // progress: what an ACP run is doing; older servers ignore it
        return heartbeatSchema.parse(await this.request('POST', `runs/${claim.run.id}/heartbeat`,
            { claimToken: claim.run.claimToken, tokensUsed, ...(progress ? { progress } : {}) }, signal));
    }
    /** A short request, never retried: a lost batch of live output is just dropped (stream.ts). */
    async stream(claim: Claim, events: StreamEvent[], signal?: AbortSignal): Promise<boolean> {
        const r = z.object({ ok: z.literal(true), enabled: z.boolean() }).parse(await this.request('POST', `runs/${claim.run.id}/stream`,
            { claimToken: claim.run.claimToken, events }, signal, 5000));
        return r.enabled;
    }
    private async report(claim: Claim, action: 'complete' | 'fail', body: Completion | Failure, signal?: AbortSignal) {
        for (let attempt = 0; ; attempt++) {
            try {
                const result = await this.request('POST', `runs/${claim.run.id}/${action}`, body, signal);
                z.object({ ok: z.literal(true) }).parse(result); return;
            } catch (err) {
                if (signal?.aborted || attempt >= 2 || (err instanceof HttpError && err.status < 500)) throw err;
                await sleep(this.retryDelayMs * 2 ** attempt, signal);
            }
        }
    }
    /** A card for one approval request a running Codex turn holds (siwc/approvals.ts). */
    async openToolRequest(claim: Claim, body: { tool: string; requestKey: string; waitSeconds: number; detail: string | null; cwd: string | null }, signal?: AbortSignal) {
        return z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).nullable(), status: z.string().max(20) })
            .parse(await this.request('POST', `runs/${claim.run.id}/tool-requests`, { claimToken: claim.run.claimToken, ...body }, signal));
    }
    async toolRequest(claim: Claim, requestId: string, close?: 'timeout' | 'resolved' | 'stopped', signal?: AbortSignal) {
        return z.object({ status: z.string().max(20) }).parse(await this.request('POST', `runs/${claim.run.id}/tool-requests/${encodeURIComponent(requestId)}`,
            { claimToken: claim.run.claimToken, ...(close ? { close } : {}) }, signal));
    }
    /** How each profile's CLI signs in (terms.ts); only variable names, never keys. */
    async reportProfiles(profiles: ProfileReport[]): Promise<void> {
        await this.request('POST', 'profiles', { profiles });
    }
    /** A Settings → Agents request to connect or disconnect a ChatGPT plan on this host. */
    async claimPlanRequest(signal?: AbortSignal): Promise<PlanRequest | null> {
        const data = await this.request('GET', 'plan-requests/next', undefined, signal);
        if (data === null) return null;
        return z.object({ profile: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/), action: z.enum(['connect', 'disconnect']),
            requestedBy: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).nullable() }).parse(data);
    }
    /** The sign-in state of one profile. Never a token: a status, a fixed error code, the account's email. */
    async reportPlan(profile: string, body: { status: PlanStatus; error?: string | null; accountLabel?: string | null }, signal?: AbortSignal) {
        return z.object({ planOwnerId: z.string().nullable() }).parse(await this.request('POST', `plans/${encodeURIComponent(profile)}`, body, signal));
    }
    /** Agent boxes: claim the oldest Log in request for this box (docs/agent-boxes.md §8.2). */
    async claimBoxLogin(signal?: AbortSignal): Promise<BoxLoginRequest | null> {
        const data = await this.request('GET', 'box-login', undefined, signal);
        if (data === null) return null;
        return z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), adapter: z.enum(BOX_ADAPTER_NAMES),
            profile: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/) }).parse(data);
    }
    /** A login's state. The URL and code are the owner's to see; the host never logs them. */
    async reportBoxLogin(id: string, body: BoxLoginReport, signal?: AbortSignal): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try { await this.request('POST', `box-login/${encodeURIComponent(id)}`, body, signal); return; }
            catch (e) { if (attempt >= 2 || signal?.aborted || e instanceof HttpError && e.status < 500) throw e; await sleep(this.retryDelayMs * 2 ** attempt, signal); }
        }
    }
    async boxLoginCode(id: string, signal?: AbortSignal): Promise<string | null> {
        const data = await this.request('GET', `box-login/${encodeURIComponent(id)}/code`, undefined, signal);
        return data === null ? null : z.object({ code: z.string().min(1).max(512) }).parse(data).code;
    }
    complete(claim: Claim, body: Completion, signal?: AbortSignal) { return this.report(claim, 'complete', body, signal); }
    fail(claim: Claim, body: Failure, signal?: AbortSignal) { return this.report(claim, 'fail', body, signal); }
}

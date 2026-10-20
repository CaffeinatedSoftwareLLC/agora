import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { claimSchema, type Claim, type Completion, type Failure, type Heartbeat, type HostApi, type PlanRequest, type PlanStatus, type Progress, type ProfileReport } from './types.js';
import type { ReviewCommand } from './review.js';
import type { PreviewCommand, PreviewOutcome } from './preview.js';

export class HttpError extends Error {
    constructor(public readonly status: number) { super(`host_http_${status}`); }
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
        if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
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
            workdirAlias: z.string(), action: z.enum(['diff','discard','commit','merge','pr','restore','fork']),
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
    async openToolRequest(claim: Claim, body: { tool: string; requestKey: string; waitSeconds: number; detail: string | null }, signal?: AbortSignal) {
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
    complete(claim: Claim, body: Completion, signal?: AbortSignal) { return this.report(claim, 'complete', body, signal); }
    fail(claim: Claim, body: Failure, signal?: AbortSignal) { return this.report(claim, 'fail', body, signal); }
}

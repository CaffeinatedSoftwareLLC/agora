import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { claimSchema, type Claim, type Completion, type Failure, type Heartbeat, type HostApi } from './types.js';

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
    async heartbeat(claim: Claim, signal?: AbortSignal): Promise<Heartbeat> {
        return heartbeatSchema.parse(await this.request('POST', `runs/${claim.run.id}/heartbeat`, { claimToken: claim.run.claimToken }, signal));
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
    complete(claim: Claim, body: Completion, signal?: AbortSignal) { return this.report(claim, 'complete', body, signal); }
    fail(claim: Claim, body: Failure, signal?: AbortSignal) { return this.report(claim, 'fail', body, signal); }
}

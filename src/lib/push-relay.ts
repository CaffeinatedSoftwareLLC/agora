/**
 * Calls to a push relay (docs/planning/mobile-apps.md section 8). The handle is a bearer
 * credential for one device: it goes only in the Authorization header, never in a log line.
 * Redirects are not followed, so the handle can't be carried to another host.
 */

export interface RelayResponse { status: number; retryAfterSeconds: number | null }
export type RelayFetch = (url: string, init: RequestInit) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

const TIMEOUT_MS = 10_000;
const defaultFetch: RelayFetch = (url, init) => fetch(url, init);
let relayFetch: RelayFetch = defaultFetch;

/** Tests replace the network; pass nothing to restore it. */
export function setRelayFetch(f?: RelayFetch): void {
    relayFetch = f ?? defaultFetch;
}

export interface PushBody { instance: string; type: string; title: string; body: string; url: string }

async function call(url: string, method: string, handle: string, body?: unknown): Promise<RelayResponse> {
    const res = await relayFetch(url, {
        method,
        headers: { Authorization: `Bearer ${handle}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const retryAfter = Number(res.headers.get('retry-after'));
    return { status: res.status, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
}

/** POST <relay>/v1/push: 202 accepted, 401/403/410 drop the device, 429/5xx retry. */
export function relayPush(relay: string, handle: string, body: PushBody): Promise<RelayResponse> {
    return call(`${relay}/v1/push`, 'POST', handle, body);
}

/** DELETE <relay>/v1/handles: the device was removed on this instance. */
export function relayForget(relay: string, handle: string): Promise<RelayResponse> {
    return call(`${relay}/v1/handles`, 'DELETE', handle);
}

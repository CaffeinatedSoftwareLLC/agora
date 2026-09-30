/**
 * agora:std — the only way sandboxed code reaches the outside world.
 *
 * Every call goes to the capability gateway (AGORA_CAP_URL) with this run's token.
 * The gateway enforces which capabilities the run declared, per-run call caps,
 * route budgets, and file limits (docs/planning/sandbox-isolation-spec.md §7, §11).
 *
 *   import { search, postFile } from "agora:std";
 *   const res = await search("latest deno release");
 *   await postFile("report.html", html, { mime: "text/html" });
 *
 * The same functions are available on the global `agora` object.
 */

export class AgoraError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) {
        super(message);
        this.name = 'AgoraError';
    }
}

const CAP_URL = (Deno.env.get('AGORA_CAP_URL') ?? '').replace(/\/+$/, '');
const TOKEN = Deno.env.get('AGORA_RUN_TOKEN') ?? '';

async function request(path: string, init: RequestInit): Promise<unknown> {
    if (!CAP_URL || !TOKEN) throw new AgoraError('Capability gateway is not configured for this run', 0, 'not_configured');
    let res: Response;
    try {
        res = await fetch(`${CAP_URL}${path}`, {
            ...init,
            headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${TOKEN}` },
        });
    } catch (err) {
        throw new AgoraError(`Capability gateway unreachable: ${err instanceof Error ? err.message : err}`, 0, 'unreachable');
    }
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
    if (!res.ok) {
        throw new AgoraError(body?.error ?? `Gateway returned ${res.status}`, res.status, body?.code ?? 'gateway_error');
    }
    return body;
}

/** Call any capability the run declared (`chat`, `search`, `image`, `tts`, `decide`, ...). */
export function call<T = unknown>(capability: string, input: unknown): Promise<T> {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(capability)) {
        return Promise.reject(new AgoraError(`Invalid capability name "${capability}"`, 0, 'invalid_capability'));
    }
    return request(`/v1/capabilities/${capability}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input ?? {}),
    }) as Promise<T>;
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

/** Text generation through the server's chat route. */
export function chat(prompt: string | ChatMessage[], opts: { system?: string; maxTokens?: number } = {}): Promise<{ text: string }> {
    const messages = typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
    return call('chat', { messages, ...opts });
}

/** Grounded web search with citations. */
export function search(query: string, opts: Record<string, unknown> = {}): Promise<{ answer: string; citations: { title?: string; url: string }[] }> {
    return call('search', { query, ...opts });
}

/** Image generation; returns base64 image data and its MIME type. */
export function generateImage(prompt: string, opts: Record<string, unknown> = {}): Promise<{ data: string; mime: string }> {
    return call('image', { prompt, ...opts });
}

/** Text-to-speech; returns base64 audio data and its MIME type. */
export function tts(text: string, opts: Record<string, unknown> = {}): Promise<{ data: string; mime: string }> {
    return call('tts', { text, ...opts });
}

/** Typed decision (e.g. a choice between options) through the server's decide route. */
export function decide(input: Record<string, unknown>): Promise<unknown> {
    return call('decide', input);
}

const MIME_BY_EXT: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', pdf: 'application/pdf', zip: 'application/zip',
};

/**
 * Post a file into the thread this run came from. `data` may be text, bytes, or a
 * base64 string with `{ base64: true }`. Validated by the gateway (size, type).
 */
export function postFile(
    name: string,
    data: string | Uint8Array,
    opts: { mime?: string; message?: string; base64?: boolean } = {},
): Promise<{ id: string; url: string }> {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const bytes = typeof data === 'string'
        ? (opts.base64 ? Uint8Array.from(atob(data), c => c.charCodeAt(0)) : new TextEncoder().encode(data))
        : data;
    const headers: Record<string, string> = {
        'Content-Type': opts.mime ?? MIME_BY_EXT[ext] ?? 'application/octet-stream',
        'X-Agora-Filename': encodeURIComponent(name),
    };
    if (opts.message) headers['X-Agora-Message'] = encodeURIComponent(opts.message);
    return request('/v1/files', { method: 'POST', headers, body: bytes }) as Promise<{ id: string; url: string }>;
}

/** Post a text message into the run's thread (e.g. a summary). */
export function postMessage(content: string): Promise<{ id: string }> {
    return request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
    }) as Promise<{ id: string }>;
}

export const agora = { call, chat, search, generateImage, tts, decide, postFile, postMessage, AgoraError };

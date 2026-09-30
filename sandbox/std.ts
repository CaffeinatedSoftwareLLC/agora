/**
 * agora:std — the only way sandboxed code reaches the outside world.
 *
 * Every call goes to the capability gateway (AGORA_CAP_URL) with this run's token.
 * The gateway enforces which capabilities the run declared, per-run call caps,
 * route budgets, and file limits (docs/planning/sandbox-isolation-spec.md §7, §11).
 *
 *   import { search, postFile } from "agora:std";
 *   const res = await search("latest deno release");
 *   await postFile("notes.md", res.answer);
 *   await testReport(junitXml, { title: "CI #42" });   // results card in the thread
 *
 * The same functions are available on the global `agora` object.
 */

import { computedSummary, parseTestResults, reportMarkdown, summaryPrompt, type TestResults } from './report.ts';

export { parseTestResults, type TestResults } from './report.ts';

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

export interface SearchResponse {
    answer: string;
    citations: { url: string; title?: string; snippet?: string }[];
    /**
     * Set when the provider's terms require its own display (Google grounding): the
     * gateway already posted the answer with Google's Search Suggestions into the
     * thread, as this message. Don't repost or rewrite Google-grounded answers.
     */
    displayedIn?: string;
}

/** Web search through the server's search route (Gemini grounding or Tavily). */
export function search(query: string, opts: { maxResults?: number } = {}): Promise<SearchResponse> {
    return call('search', { query, ...opts });
}

/** Image generation; returns base64 image data and its MIME type (post it with `postFile(name, data, { base64: true })`). */
export function generateImage(
    prompt: string,
    opts: { aspectRatio?: string; imageSize?: '512' | '1K' | '2K' | '4K' } = {},
): Promise<{ data: string; mime: string; text?: string }> {
    return call('image', { prompt, ...opts });
}

/**
 * Text-to-speech; returns base64 WAV audio. One `voice`, or up to two `speakers`
 * for dialogue: every turn in `text` starts with a declared speaker's label
 * ("Joe: …" / "Jane: …"), unlabelled lines continue the current turn, and an
 * undeclared label (e.g. "Bob: …") is rejected.
 */
export function tts(
    text: string,
    opts: { voice?: string; speakers?: { speaker: string; voice: string }[] } = {},
): Promise<{ data: string; mime: string }> {
    return call('tts', { text, ...opts });
}

/**
 * Video generation (Veo). Takes from ~10 s to several minutes. The gateway posts the
 * MP4 into the run's thread (with `message`, if given) and returns its IDs; the
 * video counts as one of the run's files. 1080p and 4k require 8 seconds.
 */
export function generateVideo(
    prompt: string,
    opts: {
        aspectRatio?: '16:9' | '9:16';
        durationSeconds?: 4 | 6 | 8;
        resolution?: '720p' | '1080p' | '4k';
        negativePrompt?: string;
        message?: string;
        filename?: string;
    } = {},
): Promise<{ fileId: string; url: string; messageId: string; mime: string; size: number }> {
    return call('video', { prompt, ...opts });
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

export interface ReportCard extends TestResults {
    title: string;
    summary?: string;
    /** Whether the summary was written by the chat model or computed from the counts. */
    summarySource?: 'model' | 'computed';
    /** A text file attached to the card (validated against the instance's file rules). */
    attachment?: { name: string; content: string };
}

/**
 * Post a results card into the run's thread. The card is drawn by Agora's UI from
 * this data (at most 50 suites and 20 failures are shown).
 */
export function postReport(card: ReportCard): Promise<{ id: string; fileId?: string }> {
    return request('/v1/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
    }) as Promise<{ id: string; fileId?: string }>;
}

const MAX_ATTACHMENT_CHARS = 1_000_000;

/**
 * Turn test results into a results card with a Markdown report attached.
 * `input` is JUnit XML, Vitest/Jest JSON (object or string), or `{ totals, suites, failures }`.
 * If the run declared `chat`, the model writes the summary; otherwise it's computed.
 */
export async function testReport(
    input: unknown,
    opts: { title?: string; summarize?: boolean; attach?: boolean } = {},
): Promise<{ id: string; fileId?: string }> {
    const results = parseTestResults(input);
    const title = (opts.title ?? 'Test report').slice(0, 200);

    let summary = computedSummary(results);
    let summarySource: 'model' | 'computed' = 'computed';
    if (opts.summarize !== false) {
        try {
            const res = await chat(summaryPrompt(results, title), { maxTokens: 400 });
            if (res.text.trim()) {
                summary = res.text.trim().slice(0, 4000);
                summarySource = 'model';
            }
        } catch (err) {
            // chat not declared, not routed, or over budget: keep the computed summary
            if (!(err instanceof AgoraError)) throw err;
        }
    }

    const card: ReportCard = {
        title, summary, summarySource,
        totals: results.totals,
        suites: results.suites.slice(0, 50),
        failures: results.failures.slice(0, 20),
    };
    if (opts.attach !== false) {
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test-report';
        let content = reportMarkdown(results, title, summary);
        if (content.length > MAX_ATTACHMENT_CHARS) content = `${content.slice(0, MAX_ATTACHMENT_CHARS)}\n\n[report truncated]\n`;
        try {
            return await postReport({ ...card, attachment: { name: `${slug}.md`, content } });
        } catch (err) {
            // The instance's file rules can reject the attachment; the card still goes out
            if (!(err instanceof AgoraError) || err.code !== 'file_rejected') throw err;
            console.warn(`Report attachment rejected (${err.message}); posting the card without it`);
        }
    }
    return postReport(card);
}

export const agora = { call, chat, search, generateImage, tts, generateVideo, decide, postFile, postMessage, postReport, testReport, parseTestResults, AgoraError };

/**
 * Iterate the JSON payloads of a Server-Sent Events response (`data: {...}` lines).
 * Skips `[DONE]` sentinels and unparseable lines.
 */
export async function* sseJson(res: Response): AsyncGenerator<any> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
                yield JSON.parse(data);
            } catch { /* skip unparseable lines */ }
        }
    }
}

/** Resolve a request URL against an adapter's base URL, tolerating trailing slashes. */
export function joinUrl(base: string, path: string): string {
    return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * Human-readable provider error: "<Provider> API <status>: <message>". Pulls
 * `error.message` out of JSON error bodies (Anthropic, OpenAI, Gemini all use it)
 * and truncates anything else.
 */
export async function apiError(provider: string, res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
        const body = JSON.parse(text);
        const candidate = body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : undefined);
        if (typeof candidate === 'string' && candidate) message = candidate;
    } catch { /* not JSON */ }
    message = message.replace(/\s+/g, ' ').trim();
    if (message.length > 300) message = `${message.slice(0, 300)}…`;
    return `${provider} API ${res.status}${message ? `: ${message}` : ''}`;
}

/** Network failure → readable message (Node's fetch reports "fetch failed" with the cause attached). */
export function networkError(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
}

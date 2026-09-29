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

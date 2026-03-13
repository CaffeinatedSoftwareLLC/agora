import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to test the actual provider code, so we mock global fetch
const originalFetch = globalThis.fetch;

function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream({
        pull(controller) {
            if (index < chunks.length) {
                controller.enqueue(encoder.encode(chunks[index]));
                index++;
            } else {
                controller.close();
            }
        },
    });
}

function mockFetchResponse(status: number, body?: ReadableStream | string): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(typeof body === 'string' ? body : ''),
        body: typeof body === 'string' ? null : (body ?? null),
        headers: new Headers({ 'content-type': 'application/json' }),
    } as any);
}

// Import after we can control fetch
let streamCompletion: typeof import('../../src/ai/providers').streamCompletion;

beforeEach(async () => {
    // Fresh import each test to avoid stale module state
    const mod = await import('../../src/ai/providers');
    streamCompletion = mod.streamCompletion;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

const baseConfig = {
    provider: 'claude' as const,
    model: 'claude-sonnet-4-20250514',
    apiKey: 'sk-test',
};

describe('Claude provider streaming', () => {
    it('non-200 response calls onError', async () => {
        mockFetchResponse(429, 'Rate limited');

        const onToken = vi.fn();
        const onDone = vi.fn();
        const onError = vi.fn();

        await streamCompletion(baseConfig, [{ role: 'user', content: 'hi' }], {
            onToken,
            onDone,
            onError,
        });

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0].message).toContain('429');
        expect(onToken).not.toHaveBeenCalled();
        expect(onDone).not.toHaveBeenCalled();
    });

    it('network error (fetch throws) propagates as rejected promise', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

        const onToken = vi.fn();
        const onDone = vi.fn();
        const onError = vi.fn();

        // When fetch itself throws, the provider doesn't catch it —
        // the error propagates to the caller (assistant-handler catches it)
        await expect(
            streamCompletion(baseConfig, [{ role: 'user', content: 'hi' }], {
                onToken,
                onDone,
                onError,
            })
        ).rejects.toThrow('ECONNREFUSED');

        expect(onToken).not.toHaveBeenCalled();
        expect(onDone).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });

    it('valid SSE stream calls onToken for content deltas and onDone at end', async () => {
        const stream = createSSEStream([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":15}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":" world"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n\n',
        ]);

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            body: stream,
            headers: new Headers(),
        });

        const onToken = vi.fn();
        const onDone = vi.fn();
        const onError = vi.fn();

        await streamCompletion(baseConfig, [{ role: 'user', content: 'hi' }], {
            onToken,
            onDone,
            onError,
        });

        expect(onToken).toHaveBeenCalledWith('Hello');
        expect(onToken).toHaveBeenCalledWith(' world');
        expect(onDone).toHaveBeenCalledWith({ inputTokens: 15, outputTokens: 8 });
        expect(onError).not.toHaveBeenCalled();
    });

    it('malformed SSE data is silently skipped', async () => {
        const stream = createSSEStream([
            'data: {not valid json\n\n',
            'data: {"type":"content_block_delta","delta":{"text":"OK"}}\n\n',
            'data: \n\n',
        ]);

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            body: stream,
            headers: new Headers(),
        });

        const onToken = vi.fn();
        const onDone = vi.fn();
        const onError = vi.fn();

        await streamCompletion(baseConfig, [{ role: 'user', content: 'hi' }], {
            onToken,
            onDone,
            onError,
        });

        // Only the valid delta should produce a token
        expect(onToken).toHaveBeenCalledTimes(1);
        expect(onToken).toHaveBeenCalledWith('OK');
        expect(onDone).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
    });

    it('empty response stream calls onDone with zero tokens', async () => {
        const stream = createSSEStream([]);

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            body: stream,
            headers: new Headers(),
        });

        const onToken = vi.fn();
        const onDone = vi.fn();
        const onError = vi.fn();

        await streamCompletion(baseConfig, [{ role: 'user', content: 'hi' }], {
            onToken,
            onDone,
            onError,
        });

        expect(onToken).not.toHaveBeenCalled();
        expect(onDone).toHaveBeenCalledWith({ inputTokens: 0, outputTokens: 0 });
        expect(onError).not.toHaveBeenCalled();
    });
});

describe('OpenAI provider streaming', () => {
    const openaiConfig = {
        provider: 'openai' as const,
        model: 'gpt-4o',
        apiKey: 'sk-test',
    };

    it('non-200 response calls onError', async () => {
        mockFetchResponse(401, 'Invalid API key');

        const onToken = vi.fn();
        const onDone = vi.fn();
        const onError = vi.fn();

        await streamCompletion(openaiConfig, [{ role: 'user', content: 'hi' }], {
            onToken,
            onDone,
            onError,
        });

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0].message).toContain('401');
        expect(onToken).not.toHaveBeenCalled();
    });

    it('valid SSE stream calls onToken and onDone', async () => {
        const stream = createSSEStream([
            'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n',
            'data: [DONE]\n\n',
        ]);

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            body: stream,
            headers: new Headers(),
        });

        const onToken = vi.fn();
        const onDone = vi.fn();
        const onError = vi.fn();

        await streamCompletion(openaiConfig, [{ role: 'user', content: 'hi' }], {
            onToken,
            onDone,
            onError,
        });

        expect(onToken).toHaveBeenCalledWith('Hi');
        expect(onToken).toHaveBeenCalledWith(' there');
        expect(onDone).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 4 });
        expect(onError).not.toHaveBeenCalled();
    });

    it('system prompt is prepended to messages', async () => {
        const stream = createSSEStream([
            'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
            'data: [DONE]\n\n',
        ]);

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            body: stream,
            headers: new Headers(),
        });

        await streamCompletion(
            { ...openaiConfig, systemPrompt: 'You are helpful' },
            [{ role: 'user', content: 'hi' }],
            { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
        );

        const fetchCall = (globalThis.fetch as any).mock.calls[0];
        const body = JSON.parse(fetchCall[1].body);
        expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
        expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
    });
});

export interface AIProviderConfig {
    provider: 'claude' | 'openai';
    model: string;
    apiKey: string;
    systemPrompt?: string;
}

export interface StreamCallbacks {
    onToken(token: string): void;
    onDone(usage: { inputTokens: number; outputTokens: number }): Promise<void>;
    onError(err: Error): Promise<void>;
}

export interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;
}

async function streamClaude(
    config: AIProviderConfig,
    messages: ConversationMessage[],
    callbacks: StreamCallbacks,
): Promise<void> {
    const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: 4096,
        stream: true,
        messages,
    };
    if (config.systemPrompt) {
        body.system = config.systemPrompt;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        await callbacks.onError(new Error(`Claude API ${res.status}: ${text}`));
        return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
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
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                        callbacks.onToken(parsed.delta.text);
                    } else if (parsed.type === 'message_start' && parsed.message?.usage) {
                        inputTokens = parsed.message.usage.input_tokens || 0;
                    } else if (parsed.type === 'message_delta' && parsed.usage) {
                        outputTokens = parsed.usage.output_tokens || 0;
                    }
                } catch { /* skip unparseable lines */ }
            }
        }
        await callbacks.onDone({ inputTokens, outputTokens });
    } catch (err) {
        await callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
}

async function streamOpenAI(
    config: AIProviderConfig,
    messages: ConversationMessage[],
    callbacks: StreamCallbacks,
): Promise<void> {
    const apiMessages: { role: string; content: string }[] = [];
    if (config.systemPrompt) {
        apiMessages.push({ role: 'system', content: config.systemPrompt });
    }
    for (const m of messages) {
        apiMessages.push({ role: m.role, content: m.content });
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: 4096,
            stream: true,
            stream_options: { include_usage: true },
            messages: apiMessages,
        }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        await callbacks.onError(new Error(`OpenAI API ${res.status}: ${text}`));
        return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
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
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        callbacks.onToken(delta);
                    }
                    if (parsed.usage) {
                        inputTokens = parsed.usage.prompt_tokens || 0;
                        outputTokens = parsed.usage.completion_tokens || 0;
                    }
                } catch { /* skip unparseable lines */ }
            }
        }
        await callbacks.onDone({ inputTokens, outputTokens });
    } catch (err) {
        await callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
}

export async function streamCompletion(
    config: AIProviderConfig,
    messages: ConversationMessage[],
    callbacks: StreamCallbacks,
): Promise<void> {
    if (config.provider === 'claude') {
        return streamClaude(config, messages, callbacks);
    }
    return streamOpenAI(config, messages, callbacks);
}

export async function testConnection(config: AIProviderConfig): Promise<{ ok: boolean; error?: string }> {
    try {
        if (config.provider === 'claude') {
            const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: config.model,
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'ping' }],
                }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { ok: false, error: `Claude API ${res.status}: ${text}` };
            }
            return { ok: true };
        }

        // OpenAI
        const apiMessages: { role: string; content: string }[] = [{ role: 'user', content: 'ping' }];
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                model: config.model,
                max_tokens: 1,
                messages: apiMessages,
            }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: `OpenAI API ${res.status}: ${text}` };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

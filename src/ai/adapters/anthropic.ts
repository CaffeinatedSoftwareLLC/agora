import type { Adapter, ChatRequest, ProviderCredentials, StreamCallbacks } from './types';
import { joinUrl, sseJson } from './sse';

const DEFAULT_BASE = 'https://api.anthropic.com';

function headers(creds: ProviderCredentials): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'x-api-key': creds.apiKey ?? '',
        'anthropic-version': '2023-06-01',
    };
}

export const anthropicAdapter: Adapter = {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    capabilities: ['chat'],
    requiresApiKey: true,
    supportsBaseUrl: false,
    defaultBaseUrl: DEFAULT_BASE,
    defaultModels: { chat: 'claude-sonnet-5-5' },

    async streamChat(creds: ProviderCredentials, req: ChatRequest, callbacks: StreamCallbacks) {
        const body: Record<string, unknown> = {
            model: req.model,
            max_tokens: req.maxTokens ?? 4096,
            stream: true,
            messages: req.messages,
        };
        if (req.systemPrompt) body.system = req.systemPrompt;

        const res = await fetch(joinUrl(creds.baseUrl || DEFAULT_BASE, '/v1/messages'), {
            method: 'POST',
            headers: headers(creds),
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            await callbacks.onError(new Error(`Claude API ${res.status}: ${text}`));
            return;
        }

        let inputTokens = 0;
        let outputTokens = 0;
        try {
            for await (const parsed of sseJson(res)) {
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                    callbacks.onToken(parsed.delta.text);
                } else if (parsed.type === 'message_start' && parsed.message?.usage) {
                    inputTokens = parsed.message.usage.input_tokens || 0;
                } else if (parsed.type === 'message_delta' && parsed.usage) {
                    outputTokens = parsed.usage.output_tokens || 0;
                }
            }
            await callbacks.onDone({ inputTokens, outputTokens });
        } catch (err) {
            await callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        }
    },

    async testConnection(creds: ProviderCredentials, model: string) {
        try {
            const res = await fetch(joinUrl(creds.baseUrl || DEFAULT_BASE, '/v1/messages'), {
                method: 'POST',
                headers: headers(creds),
                body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { ok: false, error: `Claude API ${res.status}: ${text}` };
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    },
};

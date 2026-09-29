import type { Adapter, ChatRequest, ProviderCredentials, StreamCallbacks } from './types';
import { apiError, joinUrl, networkError, sseJson } from './sse';

const DEFAULT_BASE = 'https://api.openai.com/v1';

function headers(creds: ProviderCredentials): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        // Local OpenAI-compatible servers (e.g. Ollama) accept requests without a key
        ...(creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {}),
    };
}

/**
 * OpenAI Chat Completions — also any OpenAI-compatible server via `baseUrl`
 * (Ollama `http://host:11434/v1`, OpenRouter, Groq, vLLM, ...).
 */
export const openaiAdapter: Adapter = {
    id: 'openai',
    label: 'OpenAI / OpenAI-compatible',
    capabilities: ['chat'],
    requiresApiKey: false,
    supportsBaseUrl: true,
    defaultBaseUrl: DEFAULT_BASE,
    // No default: model names depend on the server behind base_url (e.g. Ollama tags)
    defaultModels: {},

    async streamChat(creds: ProviderCredentials, req: ChatRequest, callbacks: StreamCallbacks) {
        const apiMessages: { role: string; content: string }[] = [];
        if (req.systemPrompt) apiMessages.push({ role: 'system', content: req.systemPrompt });
        for (const m of req.messages) apiMessages.push({ role: m.role, content: m.content });

        const res = await fetch(joinUrl(creds.baseUrl || DEFAULT_BASE, '/chat/completions'), {
            method: 'POST',
            headers: headers(creds),
            body: JSON.stringify({
                model: req.model,
                max_tokens: req.maxTokens ?? 4096,
                stream: true,
                stream_options: { include_usage: true },
                messages: apiMessages,
            }),
        });

        if (!res.ok) {
            await callbacks.onError(new Error(await apiError('OpenAI', res)));
            return;
        }

        let inputTokens = 0;
        let outputTokens = 0;
        try {
            for await (const parsed of sseJson(res)) {
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) callbacks.onToken(delta);
                if (parsed.usage) {
                    inputTokens = parsed.usage.prompt_tokens || 0;
                    outputTokens = parsed.usage.completion_tokens || 0;
                }
            }
            await callbacks.onDone({ inputTokens, outputTokens });
        } catch (err) {
            await callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        }
    },

    async testConnection(creds: ProviderCredentials, model: string) {
        try {
            const res = await fetch(joinUrl(creds.baseUrl || DEFAULT_BASE, '/chat/completions'), {
                method: 'POST',
                headers: headers(creds),
                body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
            });
            if (!res.ok) {
                return { ok: false, error: await apiError('OpenAI', res) };
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, error: networkError(err) };
        }
    },
};

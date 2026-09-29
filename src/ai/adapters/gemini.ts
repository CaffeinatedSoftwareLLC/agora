import type { Adapter, ChatRequest, ProviderCredentials, StreamCallbacks } from './types';
import { joinUrl, sseJson } from './sse';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function headers(creds: ProviderCredentials): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'x-goog-api-key': creds.apiKey ?? '',
    };
}

function modelPath(model: string): string {
    // Accept both "gemini-3.8-flash" and "models/gemini-3.8-flash"
    const id = model.startsWith('models/') ? model.slice('models/'.length) : model;
    return `/models/${encodeURIComponent(id)}`;
}

function buildBody(req: ChatRequest, maxTokens: number): Record<string, unknown> {
    const body: Record<string, unknown> = {
        // Gemini names the assistant role "model"
        contents: req.messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: maxTokens },
    };
    if (req.systemPrompt) {
        body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
    }
    return body;
}

/**
 * Google Gemini via generateContent / streamGenerateContent (v1beta).
 * Search grounding, image, and TTS capabilities are added in Phase 3.
 */
export const geminiAdapter: Adapter = {
    id: 'gemini',
    label: 'Google Gemini',
    capabilities: ['chat'],
    requiresApiKey: true,
    supportsBaseUrl: false,
    defaultBaseUrl: DEFAULT_BASE,
    defaultModels: { chat: 'gemini-3.8-flash' },

    async streamChat(creds: ProviderCredentials, req: ChatRequest, callbacks: StreamCallbacks) {
        const url = joinUrl(creds.baseUrl || DEFAULT_BASE, `${modelPath(req.model)}:streamGenerateContent?alt=sse`);
        const res = await fetch(url, {
            method: 'POST',
            headers: headers(creds),
            body: JSON.stringify(buildBody(req, req.maxTokens ?? 4096)),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            await callbacks.onError(new Error(`Gemini API ${res.status}: ${text}`));
            return;
        }

        let inputTokens = 0;
        let outputTokens = 0;
        try {
            for await (const chunk of sseJson(res)) {
                const parts = chunk.candidates?.[0]?.content?.parts ?? [];
                for (const part of parts) {
                    // Skip thought summaries if a thinking model returns them
                    if (typeof part.text === 'string' && part.text && !part.thought) {
                        callbacks.onToken(part.text);
                    }
                }
                // usageMetadata is cumulative; the last chunk carries the totals
                if (chunk.usageMetadata) {
                    inputTokens = chunk.usageMetadata.promptTokenCount || 0;
                    outputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
                }
            }
            await callbacks.onDone({ inputTokens, outputTokens });
        } catch (err) {
            await callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        }
    },

    async testConnection(creds: ProviderCredentials, model: string) {
        try {
            const url = joinUrl(creds.baseUrl || DEFAULT_BASE, `${modelPath(model)}:generateContent`);
            const res = await fetch(url, {
                method: 'POST',
                headers: headers(creds),
                body: JSON.stringify(buildBody({ model, messages: [{ role: 'user', content: 'ping' }] }, 1)),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return { ok: false, error: `Gemini API ${res.status}: ${text}` };
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    },
};

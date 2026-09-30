import type {
    Adapter, ChatRequest, ImageRequest, MediaResult, ProviderCredentials, SearchRequest, SearchResult,
    SpeechRequest, StreamCallbacks, Usage,
} from './types';
import { apiError, joinUrl, networkError, sseJson } from './sse';
import { pcmRate, pcmToWav } from './audio';

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

/** One non-streaming generateContent call; throws a readable error on HTTP failure. */
async function generate(creds: ProviderCredentials, model: string, body: Record<string, unknown>): Promise<any> {
    const url = joinUrl(creds.baseUrl || DEFAULT_BASE, `${modelPath(model)}:generateContent`);
    let res: Response;
    try {
        res = await fetch(url, { method: 'POST', headers: headers(creds), body: JSON.stringify(body) });
    } catch (err) {
        throw new Error(networkError(err));
    }
    if (!res.ok) throw new Error(await apiError('Gemini', res));
    return res.json();
}

function userText(text: string) {
    return [{ role: 'user', parts: [{ text }] }];
}

function usageOf(json: any): Usage {
    const u = json?.usageMetadata ?? {};
    // Search grounding bills the tool's prompt tokens as input
    return {
        inputTokens: (u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0),
        outputTokens: u.candidatesTokenCount || 0,
    };
}

function candidateParts(json: any): any[] {
    const candidate = json?.candidates?.[0];
    if (!candidate) {
        const blocked = json?.promptFeedback?.blockReason;
        throw new Error(blocked ? `Gemini blocked the prompt (${blocked})` : 'Gemini returned no candidates');
    }
    return candidate.content?.parts ?? [];
}

function textOf(parts: any[]): string {
    return parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
}

/** First inline media part whose MIME type starts with `prefix`. */
function inlineMedia(json: any, prefix: string): { data: Buffer; mime: string; text: string } {
    const parts = candidateParts(json);
    const part = parts.find(p => (p.inlineData?.mimeType ?? '').startsWith(prefix));
    if (!part) {
        const reason = json.candidates[0].finishReason;
        throw new Error(`Gemini returned no ${prefix.replace('/', '')}${reason && reason !== 'STOP' ? ` (${reason})` : ''}`);
    }
    return { data: Buffer.from(part.inlineData.data, 'base64'), mime: part.inlineData.mimeType, text: textOf(parts) };
}

/**
 * Google Gemini via generateContent / streamGenerateContent (v1beta). Field names
 * verified against the API reference on 2026-09-30 (GenerationConfig.speechConfig /
 * imageConfig / responseModalities, Tool.googleSearch, Candidate.groundingMetadata).
 */
export const geminiAdapter: Adapter = {
    id: 'gemini',
    label: 'Google Gemini',
    capabilities: ['chat', 'search', 'image', 'tts'],
    requiresApiKey: true,
    supportsBaseUrl: false,
    defaultBaseUrl: DEFAULT_BASE,
    defaultModels: { chat: 'gemini-3.8-flash', search: 'gemini-3.8-flash', image: 'gemini-3.1-flash-image', tts: 'gemini-3.8-flash-tts' },

    /** Grounding with Google Search. Results carry Google's display terms (see SearchResult.display). */
    async search(creds: ProviderCredentials, req: SearchRequest): Promise<SearchResult> {
        const json = await generate(creds, req.model, { contents: userText(req.query), tools: [{ googleSearch: {} }] });
        const answer = textOf(candidateParts(json));
        const meta = json.candidates[0].groundingMetadata ?? {};
        const seen = new Set<string>();
        const citations = (meta.groundingChunks ?? [])
            .map((c: any) => c.web)
            .filter((w: any) => w?.uri && !seen.has(w.uri) && seen.add(w.uri))
            .slice(0, req.maxResults ?? 10)
            .map((w: any) => ({ url: w.uri, ...(w.title ? { title: w.title } : {}) }));
        const html = meta.searchEntryPoint?.renderedContent;
        return {
            answer,
            citations,
            ...(html ? { display: { kind: 'google_search_suggestions' as const, html, queries: meta.webSearchQueries ?? [] } } : {}),
            usage: usageOf(json),
        };
    },

    async generateImage(creds: ProviderCredentials, req: ImageRequest): Promise<MediaResult> {
        const imageConfig: Record<string, string> = {};
        if (req.aspectRatio) imageConfig.aspectRatio = req.aspectRatio;
        if (req.imageSize) imageConfig.imageSize = req.imageSize;
        const json = await generate(creds, req.model, {
            contents: userText(req.prompt),
            generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
            },
        });
        const media = inlineMedia(json, 'image/');
        return { data: media.data, mime: media.mime, ...(media.text ? { text: media.text } : {}), usage: usageOf(json) };
    },

    async tts(creds: ProviderCredentials, req: SpeechRequest): Promise<MediaResult> {
        const voice = (name: string) => ({ prebuiltVoiceConfig: { voiceName: name } });
        const speechConfig = req.speakers?.length
            ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: req.speakers.map(s => ({ speaker: s.speaker, voiceConfig: voice(s.voice) })) } }
            : { voiceConfig: voice(req.voice ?? 'Kore') };
        const json = await generate(creds, req.model, {
            contents: userText(req.text),
            generationConfig: { responseModalities: ['AUDIO'], speechConfig },
        });
        const media = inlineMedia(json, 'audio/');
        const rate = pcmRate(media.mime);
        return rate
            ? { data: pcmToWav(media.data, rate), mime: 'audio/wav', usage: usageOf(json) }
            : { data: media.data, mime: media.mime.split(';')[0], usage: usageOf(json) };
    },

    async streamChat(creds: ProviderCredentials, req: ChatRequest, callbacks: StreamCallbacks) {
        const url = joinUrl(creds.baseUrl || DEFAULT_BASE, `${modelPath(req.model)}:streamGenerateContent?alt=sse`);
        const res = await fetch(url, {
            method: 'POST',
            headers: headers(creds),
            body: JSON.stringify(buildBody(req, req.maxTokens ?? 4096)),
        });

        if (!res.ok) {
            await callbacks.onError(new Error(await apiError('Gemini', res)));
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
                return { ok: false, error: await apiError('Gemini', res) };
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, error: networkError(err) };
        }
    },
};

import type { Adapter, Capability, ChatRequest, MediaResult, ProviderCredentials, SpeechRequest, StreamCallbacks, ToolCall, ToolChatMessage, ToolChatRequest, ToolChatResult, TranscriptionRequest, TranscriptionResult } from './types';
import { ProviderHttpError } from './types';
import { apiError, joinUrl, networkError, redirectError, refuseRedirect, sseJson, testConnectionWithTimeout } from './sse';
import { testOpenAISpeechConnection } from './openai-speech-test';

const DEFAULT_BASE = 'https://api.openai.com/v1';

function officialOpenAI(base: string): boolean {
    return new URL(base).hostname.toLowerCase().replace(/\.$/, '') === 'api.openai.com';
}

/** OpenAI's current field; compatible endpoints retain the widely supported legacy field. */
function tokenLimit(base: string, limit: number): Record<string, number> {
    return { [officialOpenAI(base) ? 'max_completion_tokens' : 'max_tokens']: limit };
}

/** OpenAI's voices; Kokoro-FastAPI maps these names to its own voices too. */
const DEFAULT_VOICE = 'alloy';

/** File extension per recorded clip type: the Audio API and whisper servers go by the file name. */
const AUDIO_EXTENSIONS: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
};
/** Used when the caller passes no signal: a stalled provider must not hold a request forever. */
const DEFAULT_AUDIO_TIMEOUT_MS = 60_000;

function audioSignal(signal?: AbortSignal): AbortSignal {
    return signal ?? AbortSignal.timeout(DEFAULT_AUDIO_TIMEOUT_MS);
}

export const TRANSCRIBABLE_MIME_TYPES = Object.keys(AUDIO_EXTENSIONS);

function headers(creds: ProviderCredentials): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        // Local OpenAI-compatible servers (e.g. Ollama) accept requests without a key
        ...(creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {}),
    };
}

/** Chat Completions messages for a function-calling turn. */
export function toOpenAIToolMessages(systemPrompt: string | undefined, messages: ToolChatMessage[]): object[] {
    const out: object[] = [];
    if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
    for (const m of messages) {
        if (m.role === 'tool') {
            out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
        } else if (m.role === 'assistant' && m.toolCalls?.length) {
            out.push({
                role: 'assistant',
                content: m.content,
                tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
            });
        } else {
            out.push({ role: m.role, content: m.content ?? '' });
        }
    }
    return out;
}

/**
 * Read a Chat Completions response (non-streamed) into text, tool calls and usage.
 * Compatible servers differ: some return `arguments` as an object instead of a JSON
 * string, some omit call IDs, and older ones use the single `function_call` field.
 */
export function parseToolChatResponse(json: any): ToolChatResult {
    const choice = json?.choices?.[0];
    if (!choice || typeof choice !== 'object') throw new Error('The provider returned no choices');
    const message = choice.message ?? {};
    const raw: any[] = Array.isArray(message.tool_calls) ? message.tool_calls
        : message.function_call ? [{ type: 'function', function: message.function_call }] : [];
    const toolCalls: ToolCall[] = [];
    raw.forEach((call, i) => {
        const fn = call?.function;
        if (!fn || typeof fn.name !== 'string' || !fn.name) return;
        const args = typeof fn.arguments === 'string' ? fn.arguments
            : fn.arguments === undefined || fn.arguments === null ? '{}' : JSON.stringify(fn.arguments);
        toolCalls.push({ id: typeof call.id === 'string' && call.id ? call.id : `call_${i}`, name: fn.name, arguments: args });
    });
    const content = typeof message.content === 'string' ? message.content
        // Some servers return content parts
        : Array.isArray(message.content) ? message.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') || null
        : null;
    return {
        content,
        toolCalls,
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        usage: { inputTokens: json.usage?.prompt_tokens || 0, outputTokens: json.usage?.completion_tokens || 0 },
    };
}

/**
 * OpenAI Chat Completions — also any OpenAI-compatible server via `baseUrl`
 * (Ollama `http://host:11434/v1`, OpenRouter, Groq, vLLM, ...). Speech goes through
 * the Audio API shape, which local servers implement too: Kokoro-FastAPI for
 * `POST /audio/speech`, speaches (faster-whisper) for `POST /audio/transcriptions`.
 */
export const openaiAdapter: Adapter = {
    id: 'openai',
    label: 'OpenAI / OpenAI-compatible',
    capabilities: ['chat', 'tts', 'stt'],
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
            signal: req.signal,
            redirect: 'manual',
            method: 'POST',
            headers: headers(creds),
            body: JSON.stringify({
                model: req.model,
                ...tokenLimit(creds.baseUrl || DEFAULT_BASE, req.maxTokens ?? 4096),
                stream: true,
                stream_options: { include_usage: true },
                messages: apiMessages,
            }),
        });

        const redirected = redirectError(res, 'OpenAI');
        if (redirected) {
            await callbacks.onError(new Error(redirected));
            return;
        }
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

    async chatWithTools(creds: ProviderCredentials, req: ToolChatRequest): Promise<ToolChatResult> {
        const base = creds.baseUrl || DEFAULT_BASE;
        let res: Response;
        try {
            res = await fetch(joinUrl(base, '/chat/completions'), {
                signal: req.signal,
                redirect: 'manual',
                method: 'POST',
                headers: headers(creds),
                body: JSON.stringify({
                    model: req.model,
                    ...tokenLimit(base, req.maxTokens ?? 4096),
                    messages: toOpenAIToolMessages(req.systemPrompt, req.messages),
                    ...(req.tools.length > 0 ? {
                        tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
                        tool_choice: 'auto',
                    } : {}),
                }),
            });
        } catch (err) {
            throw new Error(networkError(err));
        }
        refuseRedirect(res, 'OpenAI');
        if (!res.ok) throw new ProviderHttpError(res.status, await apiError('OpenAI', res));
        let json: any;
        try {
            json = await res.json();
        } catch (err) {
            throw new Error(networkError(err));
        }
        return parseToolChatResponse(json);
    },

    /** WAV, so audio overviews can join lines voiced one at a time (src/ai/speech.ts). */
    async tts(creds: ProviderCredentials, req: SpeechRequest): Promise<MediaResult> {
        let res: Response;
        try {
            res = await fetch(joinUrl(creds.baseUrl || DEFAULT_BASE, '/audio/speech'), {
                signal: audioSignal(req.signal),
                redirect: 'manual',
                method: 'POST',
                headers: headers(creds),
                body: JSON.stringify({ model: req.model, input: req.text, voice: req.voice ?? DEFAULT_VOICE, response_format: 'wav' }),
            });
        } catch (err) {
            throw new Error(networkError(err));
        }
        refuseRedirect(res, 'OpenAI speech');
        if (!res.ok) throw new Error(await apiError('OpenAI speech', res));
        let data: Buffer;
        try {
            data = Buffer.from(await res.arrayBuffer());
        } catch (err) {
            throw new Error(networkError(err));
        }
        // A server that ignores response_format still says what it sent
        const mime = data.toString('ascii', 0, 4) === 'RIFF' ? 'audio/wav' : (res.headers.get('content-type') ?? 'audio/mpeg').split(';')[0].trim();
        // The Audio API reports no token usage for speech
        return { data, mime, usage: { inputTokens: 0, outputTokens: 0 } };
    },

    async transcribe(creds: ProviderCredentials, req: TranscriptionRequest): Promise<TranscriptionResult> {
        const ext = AUDIO_EXTENSIONS[req.mime];
        if (!ext) throw new Error(`Can't transcribe ${req.mime} audio`);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(req.audio)], { type: req.mime }), `speech.${ext}`);
        form.append('model', req.model);
        form.append('response_format', 'json');
        if (req.language) form.append('language', req.language);

        let res: Response;
        try {
            res = await fetch(joinUrl(creds.baseUrl || DEFAULT_BASE, '/audio/transcriptions'), {
                signal: audioSignal(req.signal),
                redirect: 'manual',
                method: 'POST',
                // fetch sets the multipart Content-Type (with its boundary) itself
                headers: creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {},
                body: form,
            });
        } catch (err) {
            throw new Error(networkError(err));
        }
        refuseRedirect(res, 'OpenAI transcription');
        if (!res.ok) throw new Error(await apiError('OpenAI transcription', res));
        let json: any;
        try {
            json = await res.json();
        } catch (err) {
            throw new Error(networkError(err));
        }
        if (typeof json?.text !== 'string') throw new Error('OpenAI transcription returned no text');
        // gpt-4o-transcribe reports tokens; whisper models report seconds, which aren't tokens
        const usage = json.usage?.type === 'tokens'
            ? { inputTokens: json.usage.input_tokens || 0, outputTokens: json.usage.output_tokens || 0 }
            : { inputTokens: 0, outputTokens: 0 };
        return { text: json.text.trim(), usage };
    },

    async testConnection(creds: ProviderCredentials, model: string, capability: Capability = 'chat') {
        if (capability === 'tts' || capability === 'stt') return testOpenAISpeechConnection(creds, model);
        return testConnectionWithTimeout(async signal => {
            const base = creds.baseUrl || DEFAULT_BASE;
            const official = officialOpenAI(base);
            // Model metadata checks the key/model without spending reasoning tokens on a ping.
            const res = await fetch(joinUrl(base, official ? `/models/${encodeURIComponent(model)}` : '/chat/completions'), {
                signal,
                redirect: 'manual',
                method: official ? 'GET' : 'POST',
                headers: headers(creds),
                ...(official ? {} : { body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) }),
            });
            refuseRedirect(res, 'OpenAI');
            if (!res.ok) {
                return { ok: false, error: await apiError('OpenAI', res) };
            }
            return { ok: true };
        });
    },
};

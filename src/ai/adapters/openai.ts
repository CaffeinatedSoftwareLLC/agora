import type { Adapter, Capability, ChatRequest, MediaResult, ProviderCredentials, SpeechRequest, StreamCallbacks, TranscriptionRequest, TranscriptionResult } from './types';
import { apiError, joinUrl, networkError, sseJson, testConnectionWithTimeout } from './sse';
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

/** The provider URL is checked once (url-guard); following a redirect would skip that check. */
function refuseRedirect(res: Response, what: string) {
    if (res.status >= 300 && res.status < 400) throw new Error(`${what} redirected (HTTP ${res.status}); redirects are not followed`);
}

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
                method: official ? 'GET' : 'POST',
                headers: headers(creds),
                ...(official ? {} : { body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) }),
            });
            if (!res.ok) {
                return { ok: false, error: await apiError('OpenAI', res) };
            }
            return { ok: true };
        });
    },
};

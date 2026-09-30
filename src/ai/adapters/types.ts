/**
 * Provider adapter contract. Adapters are code (one per API shape); configured
 * providers are rows in `ai_providers` that name an adapter and hold credentials.
 */

export const CAPABILITIES = ['chat', 'search', 'image', 'tts', 'video', 'decide'] as const;
export type Capability = typeof CAPABILITIES[number];

export interface ProviderCredentials {
    apiKey?: string;
    /** Adapter-specific API root (e.g. an OpenAI-compatible server). Falls back to the adapter default. */
    baseUrl?: string;
}

export interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface ChatRequest {
    model: string;
    messages: ConversationMessage[];
    systemPrompt?: string;
    maxTokens?: number;
}

export interface Usage {
    inputTokens: number;
    outputTokens: number;
}

export interface StreamCallbacks {
    onToken(token: string): void;
    onDone(usage: Usage): Promise<void>;
    onError(err: Error): Promise<void>;
}

export interface ConnectionResult {
    ok: boolean;
    error?: string;
}

export interface AdapterInfo {
    id: string;
    label: string;
    capabilities: Capability[];
    requiresApiKey: boolean;
    supportsBaseUrl: boolean;
    defaultBaseUrl: string;
    /** Suggested model per capability; admins can enter any model ID. */
    defaultModels: Partial<Record<Capability, string>>;
}

export interface SearchRequest {
    model: string;
    query: string;
    maxResults?: number;
}

export interface SearchCitation {
    url: string;
    title?: string;
    snippet?: string;
}

export interface SearchResult {
    answer: string;
    citations: SearchCitation[];
    /**
     * Set when the provider's terms dictate how results are shown. Gemini grounding:
     * the answer must be displayed unmodified alongside Google's Search Suggestions
     * (`html`), so the gateway posts it into the run's thread.
     */
    display?: { kind: 'google_search_suggestions'; html: string; queries: string[] };
    usage: Usage;
}

export interface ImageRequest {
    model: string;
    prompt: string;
    aspectRatio?: string;
    imageSize?: string;
}

export interface SpeechRequest {
    model: string;
    text: string;
    voice?: string;
    /** Multi-speaker: names must match the speaker labels used in `text`. */
    speakers?: { speaker: string; voice: string }[];
}

export interface VideoRequest {
    model: string;
    prompt: string;
    aspectRatio?: '16:9' | '9:16';
    durationSeconds?: 4 | 6 | 8;
    resolution?: '720p' | '1080p' | '4k';
    negativePrompt?: string;
    /** Give up waiting for the provider after this long (the video may still bill). */
    timeoutMs?: number;
    /** How often to poll a long-running operation (tests shorten it). */
    pollMs?: number;
}

export interface MediaResult {
    data: Buffer;
    mime: string;
    /** Any text the model returned alongside the media. */
    text?: string;
    usage: Usage;
}

/**
 * Each capability method is present exactly when the adapter lists that capability;
 * `resolveRoute` refuses routes an adapter can't serve, so callers may assert them.
 */
export interface Adapter extends AdapterInfo {
    streamChat?(creds: ProviderCredentials, req: ChatRequest, callbacks: StreamCallbacks): Promise<void>;
    search?(creds: ProviderCredentials, req: SearchRequest): Promise<SearchResult>;
    generateImage?(creds: ProviderCredentials, req: ImageRequest): Promise<MediaResult>;
    tts?(creds: ProviderCredentials, req: SpeechRequest): Promise<MediaResult>;
    generateVideo?(creds: ProviderCredentials, req: VideoRequest): Promise<MediaResult>;
    testConnection(creds: ProviderCredentials, model: string): Promise<ConnectionResult>;
}

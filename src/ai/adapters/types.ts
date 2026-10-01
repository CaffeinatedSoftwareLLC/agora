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
    /** When set for a capability, the only valid "model" values (e.g. Tavily's search depths). */
    modelChoices?: Partial<Record<Capability, readonly string[]>>;
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

/** Single-voice speech. */
export interface SpeechRequest {
    model: string;
    text: string;
    voice?: string;
}

export interface SpeechSpeaker {
    speaker: string;
    voice: string;
}

export interface SpeechLine {
    speaker: string;
    text: string;
}

/** Multi-speaker speech: one entry per turn; every line's `speaker` is in `speakers`. */
export interface DialogueRequest {
    model: string;
    lines: SpeechLine[];
    speakers: SpeechSpeaker[];
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

/** Text or structured text (nested objects and arrays of strings); decision models read both. */
export type DecideText = string | number | boolean | null | DecideText[] | { [key: string]: DecideText };

/**
 * A typed question for a decision model. Provider-neutral: any adapter that lists
 * `decide` answers these three shapes.
 * - `noul`: yes/no → the probability that the answer is yes
 * - `choice`: pick one of the named options
 * - `score`: rate against ordered levels (lowest first)
 */
export type DecideQuestion =
    | { type: 'noul'; instructions: DecideText; criteria?: { true?: DecideText; false?: DecideText } }
    | { type: 'choice'; instructions: DecideText; criteria: Record<string, DecideText> }
    | { type: 'score'; instructions: DecideText; criteria: DecideText[] };

export interface DecideRequest {
    model: string;
    /** The content being judged. Untrusted text belongs here, never in the questions. */
    state: DecideText;
    questions: Record<string, DecideQuestion>;
    /** Total time allowed, retries included. */
    timeoutMs?: number;
}

export type DecideAnswer =
    | { type: 'noul'; probability: number }
    | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
    /** `score` is the probability-weighted level index (0 = lowest level); `probabilities[i]` is level i. */
    | { type: 'score'; score: number; confidence: number; probabilities: number[] };

export interface DecideResult {
    /** The model that answered, as the provider reports it (not the alias that was asked for). */
    model: string;
    answers: Record<string, DecideAnswer>;
    usage: Usage;
}

/** Request size limits of a decision adapter, in tokens. */
export interface DecideLimits {
    /** State plus the longest single question. */
    stateTokens: number;
    /** The whole request. */
    requestTokens: number;
    maxChoiceOptions: number;
    minScoreLevels: number;
    maxScoreLevels: number;
}

export type DecideFailureKind = 'transient' | 'permanent' | 'timeout' | 'invalid_response';

/** A failed decision call. `message` is safe to store and show: no key material, truncated. */
export class DecideError extends Error {
    constructor(public kind: DecideFailureKind, message: string, public status?: number) {
        super(message);
        this.name = 'DecideError';
    }
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
    /**
     * Native multi-speaker speech in one call (optional, needs `tts`). Without it,
     * `synthesizeDialogue` voices each line with `tts` and joins the audio.
     */
    ttsDialogue?(creds: ProviderCredentials, req: DialogueRequest): Promise<MediaResult>;
    generateVideo?(creds: ProviderCredentials, req: VideoRequest): Promise<MediaResult>;
    /** Typed decisions. Throws `DecideError`; callers go through `src/ai/decide.ts`, never here directly. */
    decide?(creds: ProviderCredentials, req: DecideRequest): Promise<DecideResult>;
    /** Present exactly when the adapter lists `decide`. */
    decideLimits?: DecideLimits;
    testConnection(creds: ProviderCredentials, model: string): Promise<ConnectionResult>;
}

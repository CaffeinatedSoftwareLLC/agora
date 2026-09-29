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

export interface Adapter extends AdapterInfo {
    streamChat(creds: ProviderCredentials, req: ChatRequest, callbacks: StreamCallbacks): Promise<void>;
    testConnection(creds: ProviderCredentials, model: string): Promise<ConnectionResult>;
}

/**
 * Provider facade: resolves an adapter and forwards the call. Callers (assistant
 * handler, config routes) depend on this module rather than on adapters directly.
 */
import { getAdapter, LEGACY_PROVIDER_ADAPTER } from './adapters';
import type { ConnectionResult, ConversationMessage, StreamCallbacks } from './adapters';

export type { ConversationMessage, StreamCallbacks } from './adapters';

export interface AIProviderConfig {
    /** Adapter ID (`anthropic`, `openai`, `gemini`). Legacy `claude` is accepted. */
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    systemPrompt?: string;
    maxTokens?: number;
}

function resolve(provider: string) {
    const adapter = getAdapter(LEGACY_PROVIDER_ADAPTER[provider] ?? provider);
    if (!adapter) throw new Error(`Unknown AI provider adapter: ${provider}`);
    return adapter;
}

export async function streamCompletion(
    config: AIProviderConfig,
    messages: ConversationMessage[],
    callbacks: StreamCallbacks,
): Promise<void> {
    let adapter;
    try {
        adapter = resolve(config.provider);
    } catch (err) {
        await callbacks.onError(err as Error);
        return;
    }
    return adapter.streamChat(
        { apiKey: config.apiKey, baseUrl: config.baseUrl },
        { model: config.model, messages, systemPrompt: config.systemPrompt, maxTokens: config.maxTokens },
        callbacks,
    );
}

export async function testConnection(config: AIProviderConfig): Promise<ConnectionResult> {
    try {
        return await resolve(config.provider).testConnection({ apiKey: config.apiKey, baseUrl: config.baseUrl }, config.model);
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

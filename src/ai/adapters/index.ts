import type { Adapter, AdapterInfo, Capability } from './types';
import { anthropicAdapter } from './anthropic';
import { openaiAdapter } from './openai';
import { geminiAdapter } from './gemini';
import { tavilyAdapter } from './tavily';
import { typesafeAdapter } from './typesafe';
import { greenptAdapter } from './greenpt';
import { cloudflareAdapter } from './cloudflare';
import { guardAdapter } from './guard';

export * from './types';

// Guarded: no credential reaches an error, result or log (guard.ts)
const ADAPTERS: Adapter[] = [anthropicAdapter, openaiAdapter, geminiAdapter, tavilyAdapter, typesafeAdapter, greenptAdapter, cloudflareAdapter]
    .map(guardAdapter);
const BY_ID = new Map(ADAPTERS.map(a => [a.id, a]));

/** Legacy `ai_provider_config.provider` values → adapter IDs. */
export const LEGACY_PROVIDER_ADAPTER: Record<string, string> = {
    claude: 'anthropic',
    openai: 'openai',
};

export function getAdapter(id: string): Adapter | undefined {
    return BY_ID.get(id);
}

export function adapterIds(): string[] {
    return ADAPTERS.map(a => a.id);
}

export function adapterSupports(id: string, capability: Capability): boolean {
    return BY_ID.get(id)?.capabilities.includes(capability) ?? false;
}

/** Public metadata for clients (no functions). */
export function listAdapters(): AdapterInfo[] {
    return ADAPTERS.map(({ id, label, capabilities, requiresApiKey, supportsBaseUrl, requiresAccountId, defaultBaseUrl, defaultModels, modelChoices }) =>
        ({ id, label, capabilities, requiresApiKey, supportsBaseUrl, ...(requiresAccountId ? { requiresAccountId } : {}),
           defaultBaseUrl, defaultModels, ...(modelChoices ? { modelChoices } : {}) }));
}

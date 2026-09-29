import type { Adapter, AdapterInfo, Capability } from './types';
import { anthropicAdapter } from './anthropic';
import { openaiAdapter } from './openai';
import { geminiAdapter } from './gemini';

export * from './types';

const ADAPTERS: Adapter[] = [anthropicAdapter, openaiAdapter, geminiAdapter];
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
    return ADAPTERS.map(({ id, label, capabilities, requiresApiKey, supportsBaseUrl, defaultBaseUrl, defaultModels }) =>
        ({ id, label, capabilities, requiresApiKey, supportsBaseUrl, defaultBaseUrl, defaultModels }));
}

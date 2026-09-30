import type { Adapter, ProviderCredentials, SearchRequest, SearchResult } from './types';
import { apiError, joinUrl, networkError } from './sse';

const DEFAULT_BASE = 'https://api.tavily.com';

/** Tavily has no models; the route's "model" picks the search depth (credits: advanced 2, others 1). */
export const TAVILY_DEPTHS = ['basic', 'advanced', 'fast', 'ultra-fast'] as const;

async function tavilySearch(creds: ProviderCredentials, depth: string, query: string, maxResults: number): Promise<any> {
    if (!(TAVILY_DEPTHS as readonly string[]).includes(depth)) {
        throw new Error(`Tavily "model" must be a search depth: ${TAVILY_DEPTHS.join(', ')}`);
    }
    let res: Response;
    try {
        res = await fetch(joinUrl(creds.baseUrl || DEFAULT_BASE, '/search'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey ?? ''}` },
            body: JSON.stringify({ query, search_depth: depth, max_results: maxResults, include_answer: 'basic' }),
        });
    } catch (err) {
        throw new Error(networkError(err));
    }
    if (!res.ok) throw new Error(await apiError('Tavily', res));
    return res.json();
}

/**
 * Tavily web search (POST /search), built for agent use: results may be processed by
 * run code, unlike Gemini grounding. API shape verified 2026-09-30.
 */
export const tavilyAdapter: Adapter = {
    id: 'tavily',
    label: 'Tavily (web search)',
    capabilities: ['search'],
    requiresApiKey: true,
    supportsBaseUrl: false,
    defaultBaseUrl: DEFAULT_BASE,
    defaultModels: { search: 'basic' },
    modelChoices: { search: TAVILY_DEPTHS },

    async search(creds: ProviderCredentials, req: SearchRequest): Promise<SearchResult> {
        const json = await tavilySearch(creds, req.model, req.query, req.maxResults ?? 5);
        return {
            answer: typeof json.answer === 'string' ? json.answer : '',
            citations: (json.results ?? [])
                .filter((r: any) => typeof r.url === 'string')
                .map((r: any) => ({
                    url: r.url,
                    ...(r.title ? { title: r.title } : {}),
                    ...(r.content ? { snippet: String(r.content).slice(0, 1000) } : {}),
                })),
            usage: { inputTokens: 0, outputTokens: 0 },
        };
    },

    /** Costs one search credit (basic depth, one result). */
    async testConnection(creds: ProviderCredentials, model: string) {
        try {
            await tavilySearch(creds, TAVILY_DEPTHS.includes(model as any) ? model : 'basic', 'agora connection test', 1);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    },
};

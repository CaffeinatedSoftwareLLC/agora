import { z } from 'zod';
import type { LocalProfile } from './config.js';
import { opencodeProvider } from './terms.js';

/**
 * The spend cap for an opencode agent is its OpenRouter key's own credit limit: OpenRouter
 * refuses requests once it is used up (acp/session.ts reports that as credit_exhausted). At
 * start the host reads the limit from `GET /api/v1/key` for the start-up log. The key goes
 * only to openrouter.ai, in the Authorization header; nothing from the reply but the numbers
 * and the reset period is printed.
 */

export const KEY_URL = 'https://openrouter.ai/api/v1/key';
const money = z.number().finite().nullable();
const keySchema = z.object({ data: z.object({ limit: money, limit_remaining: money, limit_reset: z.string().max(20).regex(/^[a-z]+$/).nullable().catch(null).default(null) }) });

const usd = (n: number) => `$${n.toFixed(2)}`;

/** One start-up log line about the profile's OpenRouter credit limit, or null when it has no OpenRouter key. */
export async function creditLine(name: string, profile: LocalProfile, env: NodeJS.ProcessEnv = process.env,
                                 fetcher: typeof fetch = fetch, timeoutMs = 10000): Promise<string | null> {
    if (profile.adapter !== 'opencode' || profile.auth !== 'api_key' || opencodeProvider(profile.apiKeyEnv)?.provider !== 'openrouter') return null;
    const key = env[profile.apiKeyEnv!]?.trim();
    if (!key) return null;
    try {
        const res = await fetcher(KEY_URL, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        if (!res.ok) return `Profile ${name}: could not read the OpenRouter key's credit limit (HTTP ${res.status}).`;
        const { limit, limit_remaining: left, limit_reset: reset } = keySchema.parse(await res.json()).data;
        if (limit === null) return `Profile ${name}: the OpenRouter key has no credit limit. Set one at https://openrouter.ai/settings/keys to cap this agent's spend.`;
        return `Profile ${name}: OpenRouter key credit limit ${usd(limit)}, ${left === null ? 'remaining unknown' : `${usd(left)} left`}${reset ? `, resets ${reset}` : ''}.`;
    } catch {
        return `Profile ${name}: could not read the OpenRouter key's credit limit.`;
    }
}

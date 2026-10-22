import { DecideError, type Adapter, type DecideLimits, type DecideRequest, type DecideResult, type ProviderCredentials } from './types';
import { joinUrl } from './sse';
import { DECIDE_DEFAULT_TIMEOUT_MS, postDecision } from './decide-http';
import { CONNECTION_TEST, fromSystemOne } from './typesafe';

const DEFAULT_BASE = 'https://api.cloudflare.com/client/v4';
/** Rate limited (429) or out of capacity (503): worth another try inside the deadline. */
const RETRYABLE = new Set([429, 503]);

/**
 * Clef models by Workers AI ID, with the selector their request body names.
 * Context: Clef Flash 24,576 tokens, Clef 65,536. Questions count toward it; when
 * they fit, Workers AI cuts `state` to the space left instead of refusing. A judgement
 * about text the model never read is worthless (an injection near the end would go
 * unseen), so the limits keep state plus every question under the context, with room
 * for the prompt template.
 */
const MODELS: Record<string, { selector: string; limits: DecideLimits }> = {
    '@cf/cloudflare/clef-flash': {
        selector: 'clef-flash',
        limits: { stateTokens: 23_000, requestTokens: 23_000, maxChoiceOptions: 255, minScoreLevels: 2, maxScoreLevels: 10, maxQuestions: 64 },
    },
    '@cf/cloudflare/clef': {
        selector: 'clef',
        limits: { stateTokens: 62_000, requestTokens: 62_000, maxChoiceOptions: 255, minScoreLevels: 2, maxScoreLevels: 10, maxQuestions: 64 },
    },
};
const MODEL_IDS = Object.keys(MODELS);

/**
 * "message (code)" from Cloudflare's envelope, `{ success: false, errors: [{ code, message }] }`.
 * Anything else is returned as it came, for `decideErrorText` to truncate.
 */
export function cloudflareErrorMessage(text: string): string {
    try {
        const errors = JSON.parse(text)?.errors;
        if (Array.isArray(errors) && errors.length > 0) {
            return errors.slice(0, 3)
                .map((e: any) => [typeof e?.message === 'string' ? e.message : '', e?.code !== undefined ? `(${String(e.code).slice(0, 20)})` : '']
                    .filter(Boolean).join(' '))
                .join('; ');
        }
    } catch { /* not JSON */ }
    return text;
}

function endpoint(creds: ProviderCredentials, model: string): string {
    if (!creds.accountId) throw new DecideError('permanent', 'Cloudflare needs an account ID');
    if (!MODELS[model]) throw new DecideError('permanent', `Cloudflare decision model must be one of: ${MODEL_IDS.join(', ')}`);
    // The model ID is one of the fixed ones above; it goes into the path as Workers AI expects (`/ai/run/@cf/...`)
    return joinUrl(DEFAULT_BASE, `/accounts/${encodeURIComponent(creds.accountId)}/ai/run/${model}`);
}

async function run(creds: ProviderCredentials, model: string, body: object, timeoutMs: number): Promise<any> {
    const json = await postDecision({
        provider: 'Cloudflare',
        url: endpoint(creds, model),
        headers: { Authorization: `Bearer ${creds.apiKey ?? ''}` },
        body: { model: MODELS[model].selector, ...body },
        timeoutMs,
        retryable: RETRYABLE,
        errorMessage: cloudflareErrorMessage,
    });
    if (json?.success === false) {
        throw new DecideError('invalid_response', `Cloudflare reported a failure: ${cloudflareErrorMessage(JSON.stringify(json)).slice(0, 300)}`);
    }
    return json?.result;
}

/**
 * Cloudflare Clef and Clef Flash on Workers AI: decision models that answer System One
 * questions (the same `state` / `questions` body and answer shapes as TypeSafe) in one
 * forward pass. The REST API wraps the answer in Cloudflare's `{ result, success }`
 * envelope and addresses the account in the URL. Sources and limits:
 * docs/planning/decision-models-clef-metis.md.
 */
export const cloudflareAdapter: Adapter = {
    id: 'cloudflare',
    label: 'Cloudflare Clef (decisions)',
    capabilities: ['decide'],
    requiresApiKey: true,
    supportsBaseUrl: false,
    requiresAccountId: true,
    defaultBaseUrl: DEFAULT_BASE,
    // Clef (27B): the only Workers AI model that passed the live contract and matched Jev on injections (2026-10-22)
    defaultModels: { decide: '@cf/cloudflare/clef' },
    modelChoices: { decide: MODEL_IDS },
    // The smaller context, for any model without limits of its own
    decideLimits: MODELS['@cf/cloudflare/clef-flash'].limits,
    decideModelLimits: Object.fromEntries(MODEL_IDS.map(id => [id, MODELS[id].limits])),

    async decide(creds: ProviderCredentials, req: DecideRequest): Promise<DecideResult> {
        return fromSystemOne(await run(creds, req.model, { state: req.state, questions: req.questions }, req.timeoutMs ?? DECIDE_DEFAULT_TIMEOUT_MS));
    },

    async testConnection(creds: ProviderCredentials, model: string) {
        try {
            await run(creds, model, CONNECTION_TEST, 10_000);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    },
};

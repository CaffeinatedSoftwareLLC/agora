import type { Adapter, DecideLimits, DecideQuestion, DecideRequest, DecideResult, ProviderCredentials } from './types';
import { joinUrl } from './sse';
import { DECIDE_DEFAULT_TIMEOUT_MS, postDecision, secretsOf } from './decide-http';

export { DECIDE_DEFAULT_TIMEOUT_MS } from './decide-http';

/**
 * The message in a System One error body. TypeSafe sends `{ detail: { message } }`
 * or, for validation, `{ detail: [{ msg, loc }] }`; GreenPT sends `{ error, code }`.
 * Anything else is returned as it came, for `decideErrorText` to truncate.
 */
export function systemOneErrorMessage(text: string): string {
    try {
        const body = JSON.parse(text);
        const detail = body?.detail;
        if (Array.isArray(detail)) {
            return detail.slice(0, 3)
                .map((d: any) => `${Array.isArray(d?.loc) ? d.loc.join('.') : ''} ${d?.msg ?? ''}`.trim())
                .join('; ');
        }
        if (typeof detail?.message === 'string') return detail.message;
        if (typeof detail === 'string') return detail;
        const error = typeof body?.error === 'string' ? body.error : body?.error?.message;
        if (typeof error === 'string' && error) {
            const code = typeof body.code === 'string' || typeof body.code === 'number' ? String(body.code) : '';
            return code && !error.includes(code) ? `${error} (${code.slice(0, 60)})` : error;
        }
    } catch { /* not JSON */ }
    return text;
}

/** System One answer shapes → the provider-neutral ones. Loose on purpose: `validateDecideResult` is the check. */
function toAnswer(raw: any): unknown {
    if (!raw || typeof raw !== 'object') return raw;
    if (raw.type === 'noul') return { type: 'noul', probability: raw.noul };
    if (raw.type === 'score') {
        const p = raw.probabilities;
        const probabilities = p && typeof p === 'object' && !Array.isArray(p)
            ? Object.keys(p).sort((a, b) => Number(a) - Number(b)).map(k => p[k])
            : p;
        return { type: 'score', score: raw.score, confidence: raw.confidence, probabilities };
    }
    return { type: raw.type, choice: raw.choice, confidence: raw.confidence, probabilities: raw.probabilities };
}

/** A System One response body → a provider-neutral result, for `validateDecideResult` to check. */
export function fromSystemOne(json: any): DecideResult {
    const answers: Record<string, unknown> = {};
    if (json?.answers && typeof json.answers === 'object') {
        for (const [id, raw] of Object.entries(json.answers)) answers[id] = toAnswer(raw);
    }
    return {
        model: json?.model,
        answers,
        usage: { inputTokens: json?.usage?.input_tokens, outputTokens: json?.usage?.output_tokens },
    } as DecideResult;
}

/** The smallest useful request: one yes/no question (about 60 input tokens). */
export const CONNECTION_TEST = {
    state: 'Agora connection test.',
    questions: { ok: { type: 'noul', instructions: 'Is this a connection test?' } },
} as const;

interface SystemOneProvider {
    id: string;
    label: string;
    /** Provider name in error messages. */
    provider: string;
    baseUrl: string;
    model: string;
    limits: DecideLimits;
    /** Statuses worth another try inside the deadline (rate limited, overloaded). */
    retryable: ReadonlySet<number>;
    /** Rewrites questions the provider cannot take as they are (default: sent unchanged). */
    questions?: (questions: Record<string, DecideQuestion>) => Record<string, DecideQuestion>;
}

/**
 * An adapter for TypeSafe's "System One" API (`POST /v1/systemone`): typed questions
 * about a piece of text, answered with calibrated probabilities. It writes no text.
 * Other providers serve the same API (GreenPT Metis), so the adapter is built per provider.
 */
export function systemOneAdapter(p: SystemOneProvider): Adapter {
    const call = (creds: ProviderCredentials, body: unknown, timeoutMs: number) => postDecision({
        provider: p.provider,
        url: joinUrl(creds.baseUrl || p.baseUrl, '/v1/systemone'),
        headers: { Authorization: `Bearer ${creds.apiKey ?? ''}` },
        body,
        timeoutMs,
        retryable: p.retryable,
        secrets: secretsOf(creds),
        errorMessage: systemOneErrorMessage,
    });

    return {
        id: p.id,
        label: p.label,
        capabilities: ['decide'],
        requiresApiKey: true,
        supportsBaseUrl: false,
        defaultBaseUrl: p.baseUrl,
        defaultModels: { decide: p.model },
        decideLimits: p.limits,

        async decide(creds: ProviderCredentials, req: DecideRequest): Promise<DecideResult> {
            return fromSystemOne(await call(
                creds,
                { model: req.model, state: req.state, questions: p.questions ? p.questions(req.questions) : req.questions },
                req.timeoutMs ?? DECIDE_DEFAULT_TIMEOUT_MS,
            ));
        },

        async testConnection(creds: ProviderCredentials, model: string) {
            try {
                await call(creds, { model, ...CONNECTION_TEST }, 10_000);
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
    };
}

/**
 * TypeSafe Jev, answered in well under a second. API shape verified live 2026-10-01
 * (docs.typesafe.ai/api).
 */
export const typesafeAdapter = systemOneAdapter({
    id: 'typesafe',
    label: 'TypeSafe Jev (decisions)',
    provider: 'TypeSafe',
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-latest',
    // jev-1.13: 64k tokens per request, 32k for state plus the longest question
    limits: { stateTokens: 32_000, requestTokens: 64_000, maxChoiceOptions: 255, minScoreLevels: 2, maxScoreLevels: 10 },
    // Rate limited (429) or overloaded (529)
    retryable: new Set([429, 529]),
});

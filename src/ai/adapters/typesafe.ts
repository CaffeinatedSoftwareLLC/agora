import { DecideError, type Adapter, type DecideRequest, type DecideResult, type ProviderCredentials } from './types';
import { joinUrl, networkError } from './sse';

const DEFAULT_BASE = 'https://api.typesafe.ai';
/** Decisions sit in front of something a person is waiting for; retries share this one deadline. */
export const DECIDE_DEFAULT_TIMEOUT_MS = 3000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [150, 400, 900];
/** Rate limited (429) or overloaded (529): worth another try inside the deadline. */
const RETRYABLE = new Set([429, 529]);

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** `Retry-After` in milliseconds (seconds or an HTTP date), or null. */
function retryAfterMs(res: Response): number | null {
    const header = res.headers.get('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(header);
    return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * "TypeSafe API <status>: <message>". Their errors come as `{ detail: { message } }`
 * or, for validation, `{ detail: [{ msg, loc }] }`. Anything else is truncated; the
 * request (and so the key) is never echoed.
 */
async function typesafeError(res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
        const detail = JSON.parse(text)?.detail;
        if (Array.isArray(detail)) {
            message = detail.slice(0, 3)
                .map((d: any) => `${Array.isArray(d?.loc) ? d.loc.join('.') : ''} ${d?.msg ?? ''}`.trim())
                .join('; ');
        } else if (typeof detail?.message === 'string') {
            message = detail.message;
        } else if (typeof detail === 'string') {
            message = detail;
        }
    } catch { /* not JSON */ }
    message = message.replace(/\s+/g, ' ').trim();
    if (message.length > 300) message = `${message.slice(0, 300)}…`;
    return `TypeSafe API ${res.status}${message ? `: ${message}` : ''}`;
}

/** POST /v1/systemone with one total deadline covering every attempt. */
async function systemOne(creds: ProviderCredentials, body: unknown, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    const timedOut = () => new DecideError('timeout', `TypeSafe did not answer within ${timeoutMs} ms`);

    for (let attempt = 0; ; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timedOut();

        let res: Response;
        try {
            res = await fetch(joinUrl(creds.baseUrl || DEFAULT_BASE, '/v1/systemone'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey ?? ''}` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(remaining),
            });
        } catch (err) {
            const name = (err as Error)?.name;
            if (name === 'TimeoutError' || name === 'AbortError') throw timedOut();
            throw new DecideError('transient', networkError(err));
        }

        if (res.ok) {
            try {
                return await res.json();
            } catch {
                throw new DecideError('invalid_response', 'TypeSafe returned a body that is not JSON');
            }
        }

        const message = await typesafeError(res);
        if (!RETRYABLE.has(res.status)) {
            // 5xx may pass; 4xx (bad key, bad request) will not
            throw new DecideError(res.status >= 500 ? 'transient' : 'permanent', message, res.status);
        }
        const wait = retryAfterMs(res) ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        if (attempt >= MAX_RETRIES || Date.now() + wait >= deadline) throw new DecideError('transient', message, res.status);
        await sleep(wait);
    }
}

/** TypeSafe's answer shapes → the provider-neutral ones. Loose on purpose: `validateDecideResult` is the check. */
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

/**
 * TypeSafe Jev, a "System One" model: typed questions about a piece of text, answered
 * with calibrated probabilities in well under a second. It writes no text. API shape
 * verified live 2026-10-01 (docs.typesafe.ai/api).
 */
export const typesafeAdapter: Adapter = {
    id: 'typesafe',
    label: 'TypeSafe Jev (decisions)',
    capabilities: ['decide'],
    requiresApiKey: true,
    supportsBaseUrl: false,
    defaultBaseUrl: DEFAULT_BASE,
    defaultModels: { decide: 'jev-latest' },
    // jev-1.13: 64k tokens per request, 32k for state plus the longest question
    decideLimits: { stateTokens: 32_000, requestTokens: 64_000, maxChoiceOptions: 255, minScoreLevels: 2, maxScoreLevels: 10 },

    async decide(creds: ProviderCredentials, req: DecideRequest): Promise<DecideResult> {
        const json = await systemOne(
            creds,
            { model: req.model, state: req.state, questions: req.questions },
            req.timeoutMs ?? DECIDE_DEFAULT_TIMEOUT_MS,
        );
        const answers: Record<string, unknown> = {};
        if (json?.answers && typeof json.answers === 'object') {
            for (const [id, raw] of Object.entries(json.answers)) answers[id] = toAnswer(raw);
        }
        return {
            model: json?.model,
            answers,
            usage: { inputTokens: json?.usage?.input_tokens, outputTokens: json?.usage?.output_tokens },
        } as DecideResult;
    },

    /** One tiny yes/no question (about 60 input tokens). */
    async testConnection(creds: ProviderCredentials, model: string) {
        try {
            await systemOne(creds, {
                model,
                state: 'Agora connection test.',
                questions: { ok: { type: 'noul', instructions: 'Is this a connection test?' } },
            }, 10_000);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    },
};

import type { DecideQuestion } from './types';
import { systemOneAdapter } from './typesafe';

/**
 * Metis answers `500 internal_error` to any question whose `instructions` is an
 * object, although its docs allow one (seen live 2026-10-22; object criteria are
 * fine). Such instructions go as their JSON text, which reads the same to the model.
 */
export function metisQuestions(questions: Record<string, DecideQuestion>): Record<string, DecideQuestion> {
    return Object.fromEntries(Object.entries(questions).map(([id, q]) =>
        [id, q.instructions !== null && typeof q.instructions === 'object' ? { ...q, instructions: JSON.stringify(q.instructions) } as DecideQuestion : q]));
}

/**
 * GreenPT Metis: TypeSafe's System One API (`POST /v1/systemone`, the same request
 * and answer shapes) served by GreenPT from the EU. Behind it runs Cloudflare's Clef
 * Flash at full precision, with a larger context than Workers AI gives it. Only the
 * host, the model, the limits and the error body (`{ error, code }`) differ from Jev.
 * Source: docs.greenpt.ai/systemone (read 2026-10-22); see
 * docs/planning/decision-models-clef-metis.md.
 */
export const greenptAdapter = systemOneAdapter({
    id: 'greenpt',
    label: 'GreenPT Metis (decisions)',
    provider: 'GreenPT',
    baseUrl: 'https://api.eu.greenpt.ai',
    model: 'metis',
    // 32,768 tokens for the whole request (state, every question, a fixed instruction and
    // the prompt format), 32 questions, 2,048 options in all (a noul counts two)
    limits: {
        stateTokens: 30_000, requestTokens: 30_000, maxChoiceOptions: 255, minScoreLevels: 2, maxScoreLevels: 10,
        maxQuestions: 32, maxOptions: 2048,
    },
    // Rate limited (429; 600 requests per 5 minutes per account) or at capacity (503, Retry-After: 5)
    retryable: new Set([429, 503]),
    questions: metisQuestions,
});

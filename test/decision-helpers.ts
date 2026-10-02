import { vi } from 'vitest';
import type supertest from 'supertest';

/**
 * Helpers for tests that involve the decision model (`decide` capability).
 * The provider is always a stubbed `fetch`: nothing here reaches TypeSafe.
 */

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

type RawAnswer = number | { choice: string; confidence?: number; probabilities?: Record<string, number> } | { score: number; levels: number; confidence?: number };

/** A TypeSafe-shaped reply. A number is a noul; `{ choice }` a choice; `{ score, levels }` a score. */
export function jevReply(answers: Record<string, RawAnswer>, usage = { input_tokens: 100, output_tokens: 10 }) {
    const out: Record<string, unknown> = {};
    for (const [id, a] of Object.entries(answers)) {
        if (typeof a === 'number') out[id] = { type: 'noul', noul: a };
        else if ('choice' in a) out[id] = { type: 'choice', choice: a.choice, confidence: a.confidence ?? 0.95, probabilities: a.probabilities ?? { [a.choice]: 1 } };
        else out[id] = { type: 'score', score: a.score, confidence: a.confidence ?? 0.9, probabilities: Object.fromEntries(Array.from({ length: a.levels }, (_, i) => [i, i === Math.round(a.score) ? 1 : 0])) };
    }
    return { model: 'jev-1.13.0', answers: out, usage };
}

export interface JevCall {
    state: any;
    questions: Record<string, any>;
    model: string;
}

/**
 * Stub `fetch`. Calls to TypeSafe go to `answer` (which gets the parsed request and
 * returns a reply body or a Response); anything else goes to `other`, or fails the test.
 */
export function stubJev(
    answer: (call: JevCall) => unknown,
    other?: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
    const calls: JevCall[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === JEV_URL) {
            const call = JSON.parse(init!.body as string) as JevCall;
            calls.push(call);
            const reply = await answer(call);
            return reply instanceof Response ? reply : jsonResponse(reply);
        }
        if (other) return other(url, init);
        throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, calls };
}

/** Answer every question in a call: nouls with `noul`, choices with their first option, scores with 0. */
export function answerAll(call: JevCall, noul = 0.01) {
    const answers: Record<string, RawAnswer> = {};
    for (const [id, q] of Object.entries(call.questions)) {
        if (q.type === 'noul') answers[id] = noul;
        else if (q.type === 'choice') answers[id] = { choice: Object.keys(q.criteria)[0] };
        else answers[id] = { score: 0, levels: q.criteria.length };
    }
    return jevReply(answers);
}

/** Create a TypeSafe provider and an enabled `decide` route; optionally switch uses on. */
export async function configureDecisions(
    req: supertest.Agent,
    auth: object,
    serverId: string,
    opts: { route?: Record<string, unknown>; settings?: Record<string, unknown> } = {},
) {
    const provider = await req.post(`/servers/${serverId}/ai/providers`).set(auth).send({ adapter: 'typesafe', apiKey: 'ts-test-key' });
    if (provider.status !== 201) throw new Error(`configureDecisions provider: ${provider.status} ${JSON.stringify(provider.body)}`);
    const route = await req.put(`/servers/${serverId}/ai/routes/decide`).set(auth)
        .send({ providerId: provider.body.id, model: 'jev-latest', enabled: true, ...opts.route });
    if (route.status !== 200) throw new Error(`configureDecisions route: ${route.status} ${JSON.stringify(route.body)}`);
    if (opts.settings) {
        const settings = await req.patch(`/servers/${serverId}/ai/decisions`).set(auth).send(opts.settings);
        if (settings.status !== 200) throw new Error(`configureDecisions settings: ${settings.status} ${JSON.stringify(settings.body)}`);
    }
    return { providerId: provider.body.id as string };
}

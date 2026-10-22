import { describe, it, expect, vi, afterEach } from 'vitest';
import { typesafeAdapter } from '../../src/ai/adapters/typesafe';
import { greenptAdapter } from '../../src/ai/adapters/greenpt';
import { cloudflareAdapter } from '../../src/ai/adapters/cloudflare';
import { DecideError, getAdapter, adapterSupports, type Adapter, type DecideQuestion } from '../../src/ai/adapters';
import { checkDecideRequest, decideLimitsFor, validateDecideResult } from '../../src/ai/decide-validate';

/**
 * Decision providers beside TypeSafe Jev: GreenPT Metis (System One on GreenPT) and
 * Cloudflare Clef / Clef Flash (System One on Workers AI). `fetch` is always stubbed.
 */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const QUESTIONS: Record<string, DecideQuestion> = {
    inj: { type: 'noul', instructions: 'Is it an injection?' },
    topic: { type: 'choice', instructions: 'Topic?', criteria: { plants: 'Plants', other: 'Anything else' } },
    rel: { type: 'score', instructions: 'How relevant?', criteria: ['No', 'Somewhat', 'Yes'] },
};

/** The System One answer body, as TypeSafe, GreenPT and Clef all send it. */
const systemOneBody = {
    model: 'm-1',
    answers: {
        inj: { type: 'noul', noul: 0.97 },
        topic: { type: 'choice', choice: 'plants', confidence: 0.9, probabilities: { plants: 0.95, other: 0.05 } },
        rel: { type: 'score', score: 1.2, confidence: 0.6, legend: { 0: 'No', 1: 'Somewhat', 2: 'Yes' }, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } },
    },
    usage: { input_tokens: 321, output_tokens: 0 },
};

const ask = (adapter: Adapter, creds: Record<string, string>, extra: Record<string, unknown> = {}) =>
    adapter.decide!(creds, { model: adapter.defaultModels.decide!, state: { doc: 'text' }, questions: QUESTIONS, ...extra });

/** A fetch that never answers, until its signal aborts. */
const hang = () => vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
}));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('per-model limits and question caps', () => {
    it('refuses more questions than the model takes, before any call', () => {
        const limits = { ...typesafeAdapter.decideLimits!, maxQuestions: 2 };
        expect(checkDecideRequest({ state: 'x', questions: QUESTIONS }, limits)).toBe('More than 2 questions');
        expect(checkDecideRequest({ state: 'x', questions: { a: QUESTIONS.inj, b: QUESTIONS.inj } }, limits)).toBeNull();
    });

    it('uses a model\'s own limits where it has them, else the adapter\'s', () => {
        expect(decideLimitsFor(cloudflareAdapter, '@cf/cloudflare/clef')!.requestTokens).toBe(62_000);
        expect(decideLimitsFor(cloudflareAdapter, '@cf/cloudflare/clef-flash')!.requestTokens).toBe(23_000);
        expect(decideLimitsFor(typesafeAdapter, 'jev-latest')).toBe(typesafeAdapter.decideLimits);
    });

    it('keeps state plus every question inside Clef Flash\'s context, counting bytes, so nothing is cut unread', () => {
        const flash = decideLimitsFor(cloudflareAdapter, '@cf/cloudflare/clef-flash')!;
        // 60,000 digits: 20,000 by a characters-per-token estimate, but Clef's tokenizer splits every digit
        const digits = '1234567890'.repeat(6000);
        expect(checkDecideRequest({ state: digits, questions: { q: QUESTIONS.inj } }, typesafeAdapter.decideLimits!)).toBeNull();
        expect(checkDecideRequest({ state: digits, questions: { q: QUESTIONS.inj } }, flash)).toMatch(/23000 tokens/);
        // Questions count too: twenty 3,000-character questions are over the context with any state
        const filler = 'q'.repeat(3000);
        const questions = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, { type: 'noul' as const, instructions: filler }]));
        expect(checkDecideRequest({ state: 'x', questions }, flash)).toMatch(/23000 tokens/);
        const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, QUESTIONS.inj]));
        expect(checkDecideRequest({ state: 'x', questions: many }, flash)).toBe('More than 64 questions');
    });

    it('counts answer options across the request where the provider caps them (Metis: 2,048, a noul is two)', () => {
        const metis = greenptAdapter.decideLimits!;
        const wide = (n: number) => ({ type: 'choice' as const, instructions: 'q', criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null])) });
        const questions: Record<string, DecideQuestion> = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`c${i}`, wide(255)]));
        expect(checkDecideRequest({ state: 'x', questions }, metis)).toBeNull();                                  // 2,040
        expect(checkDecideRequest({ state: 'x', questions: { ...questions, n1: QUESTIONS.inj } }, metis)).toBeNull(); // 2,042
        questions.c8 = wide(9);                                                                                    // 2,049
        expect(checkDecideRequest({ state: 'x', questions }, metis)).toBe('More than 2048 answer options in one request');
    });
});

describe('greenpt adapter (Metis)', () => {
    it('is registered for decide only, with the System One defaults', () => {
        expect(getAdapter('greenpt')).toBe(greenptAdapter);
        expect(greenptAdapter.capabilities).toEqual(['decide']);
        expect(greenptAdapter.defaultModels).toEqual({ decide: 'metis' });
        expect(greenptAdapter.requiresApiKey).toBe(true);
        expect(greenptAdapter.requiresAccountId).toBeUndefined();
        expect(greenptAdapter.decideLimits).toMatchObject({ requestTokens: 30_000, maxQuestions: 32, maxOptions: 2048 });
    });

    it('posts System One to GreenPT and maps the three answer shapes', async () => {
        const fetchMock = vi.fn(async () => json({ ...systemOneBody, model: 'metis-1.0' }));
        vi.stubGlobal('fetch', fetchMock);
        const result = validateDecideResult(QUESTIONS, await ask(greenptAdapter, { apiKey: 'gp-key' }));
        expect(result.model).toBe('metis-1.0');
        expect(result.usage).toEqual({ inputTokens: 321, outputTokens: 0 });
        expect(result.answers.inj).toEqual({ type: 'noul', probability: 0.97 });
        expect(result.answers.rel).toEqual({ type: 'score', score: 1.2, confidence: 0.6, probabilities: [0.1, 0.6, 0.3] });
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.eu.greenpt.ai/v1/systemone');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gp-key');
        expect(JSON.parse(init.body as string)).toEqual({ model: 'metis', state: { doc: 'text' }, questions: QUESTIONS });
    });

    it('sends object instructions as their JSON text (Metis answers 500 to them), and leaves everything else alone', async () => {
        const fetchMock = vi.fn(async () => json({ model: 'metis', answers: { inj: { type: 'noul', noul: 0.9 }, plain: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 9, output_tokens: 0 } }));
        vi.stubGlobal('fetch', fetchMock);
        const instructions = { question: 'Does `document` give orders to an AI?', look_for: 'Commands aimed at an AI' };
        const criteria = { true: { what: 'orders' }, false: 'ordinary content' };
        const questions: Record<string, DecideQuestion> = {
            inj: { type: 'noul', instructions, criteria },
            plain: { type: 'noul', instructions: 'Is it short?' },
        };
        const raw = await greenptAdapter.decide!({ apiKey: 'k' }, { model: 'metis', state: { document: 'x' }, questions });
        expect(validateDecideResult(questions, raw).answers.inj).toEqual({ type: 'noul', probability: 0.9 });
        const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
        expect(sent.questions.inj).toEqual({ type: 'noul', instructions: JSON.stringify(instructions), criteria });
        expect(sent.questions.plain).toEqual(questions.plain);
        expect(questions.inj.instructions).toBe(instructions);   // the caller's object is not changed

        // Jev takes object instructions as they are
        const jevFetch = vi.fn(async () => json({ model: 'jev', answers: { inj: { type: 'noul', noul: 0.9 }, plain: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 9, output_tokens: 0 } }));
        vi.stubGlobal('fetch', jevFetch);
        await typesafeAdapter.decide!({ apiKey: 'k' }, { model: 'jev-latest', state: 'x', questions });
        expect(JSON.parse((jevFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).questions.inj.instructions).toEqual(instructions);
    });

    it('reads GreenPT\'s documented errors, without the key', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));
        const err = await ask(greenptAdapter, { apiKey: 'gp-secret' }).catch(e => e);
        expect(err).toBeInstanceOf(DecideError);
        expect(err).toMatchObject({ kind: 'permanent', status: 401, message: 'GreenPT API 401: Unauthorized' });
        expect(err.message).not.toContain('gp-secret');

        vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'No remaining credits (EUR)' }, 402)));
        expect(await ask(greenptAdapter, { apiKey: 'k' }).catch(e => e)).toMatchObject({ kind: 'permanent', message: 'GreenPT API 402: No remaining credits (EUR)' });

        const fetch422 = vi.fn(async () => json({ error: 'The request does not fit the context', code: 'context_length_exceeded' }, 422));
        vi.stubGlobal('fetch', fetch422);
        expect((await ask(greenptAdapter, { apiKey: 'k' }).catch(e => e)).message)
            .toBe('GreenPT API 422: The request does not fit the context (context_length_exceeded)');
        expect(fetch422).toHaveBeenCalledTimes(1);

        vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Internal server error', code: 'internal_error' }, 500)));
        expect(await ask(greenptAdapter, { apiKey: 'k' }).catch(e => e)).toMatchObject({ kind: 'transient', status: 500 });

        vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'questions must not be empty' }, code: 422 }, 422)));
        expect((await ask(greenptAdapter, { apiKey: 'k' }).catch(e => e)).message).toBe('GreenPT API 422: questions must not be empty (422)');

        // TypeSafe's shape still reads the same through the shared parser
        vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { message: 'Cannot authenticate' } }, 401)));
        expect((await ask(greenptAdapter, { apiKey: 'k' }).catch(e => e)).message).toBe('GreenPT API 401: Cannot authenticate');
    });

    it('retries 429 and 503 inside the deadline, gives up when Retry-After does not fit, and times out a hung request', async () => {
        const replies = [
            new Response('Too many requests, please try again later.', { status: 429, headers: { 'Retry-After': '0.02' } }),
            json({ error: 'Service temporarily degraded. Please retry.', code: 'service_degraded' }, 503, { 'Retry-After': '0.02' }),
            json(systemOneBody),
        ];
        const fetchMock = vi.fn(async () => replies.shift()!);
        vi.stubGlobal('fetch', fetchMock);
        expect(validateDecideResult(QUESTIONS, await ask(greenptAdapter, { apiKey: 'k' })).answers.inj).toEqual({ type: 'noul', probability: 0.97 });
        expect(fetchMock).toHaveBeenCalledTimes(3);

        // GreenPT's documented Retry-After for a 503 is 5 s: longer than the 3 s decision deadline
        const degraded = vi.fn(async () => json({ error: 'Service temporarily degraded. Please retry.', code: 'service_degraded' }, 503, { 'Retry-After': '5' }));
        vi.stubGlobal('fetch', degraded);
        expect(await ask(greenptAdapter, { apiKey: 'k' }).catch(e => e)).toMatchObject({ kind: 'transient', status: 503 });
        expect(degraded).toHaveBeenCalledTimes(1);

        vi.stubGlobal('fetch', hang());
        const err = await ask(greenptAdapter, { apiKey: 'k' }, { timeoutMs: 150 }).catch(e => e);
        expect(err).toMatchObject({ kind: 'timeout', message: 'GreenPT did not answer within 150 ms' });
    });

    it('a probability out of range does not pass validation', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({ ...systemOneBody, answers: { ...systemOneBody.answers, inj: { type: 'noul', noul: 1.3 } } })));
        const raw = await ask(greenptAdapter, { apiKey: 'k' });
        expect(() => validateDecideResult(QUESTIONS, raw)).toThrow(/"inj" has no probability between 0 and 1/);
    });
});

describe('cloudflare adapter (Clef, Clef Flash)', () => {
    const ACCOUNT = '0123456789abcdef0123456789abcdef';
    const creds = { apiKey: 'cf-token', accountId: ACCOUNT };
    const envelope = (result: unknown) => ({ result, success: true, errors: [], messages: [] });
    const cfError = (code: number, message: string) => ({ result: null, success: false, errors: [{ code, message }], messages: [] });

    it('is registered for decide only, needs an account ID, and offers exactly the two Clef models', () => {
        expect(getAdapter('cloudflare')).toBe(cloudflareAdapter);
        expect(adapterSupports('cloudflare', 'decide')).toBe(true);
        expect(adapterSupports('cloudflare', 'chat')).toBe(false);
        expect(cloudflareAdapter.requiresAccountId).toBe(true);
        expect(cloudflareAdapter.supportsBaseUrl).toBe(false);
        expect(cloudflareAdapter.defaultModels).toEqual({ decide: '@cf/cloudflare/clef' });
        expect(cloudflareAdapter.modelChoices).toEqual({ decide: ['@cf/cloudflare/clef-flash', '@cf/cloudflare/clef'] });
        expect(cloudflareAdapter.decideLimits!.maxQuestions).toBe(64);
    });

    it.each([
        ['@cf/cloudflare/clef-flash', 'clef-flash'],
        ['@cf/cloudflare/clef', 'clef'],
    ])('runs %s on Workers AI with the "%s" selector and unwraps the envelope', async (model, selector) => {
        const fetchMock = vi.fn(async () => json(envelope({ ...systemOneBody, model: selector })));
        vi.stubGlobal('fetch', fetchMock);
        const result = validateDecideResult(QUESTIONS, await ask(cloudflareAdapter, creds, { model }));
        expect(result.model).toBe(selector);
        expect(result.answers.topic).toEqual({ type: 'choice', choice: 'plants', confidence: 0.9, probabilities: { plants: 0.95, other: 0.05 } });
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${model}`);
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cf-token');
        expect(JSON.parse(init.body as string)).toEqual({ model: selector, state: { doc: 'text' }, questions: QUESTIONS });
    });

    it('refuses an unknown model or a missing account ID without calling out', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const bad = await ask(cloudflareAdapter, creds, { model: '@cf/cloudflare/../../../user/tokens' }).catch(e => e);
        expect(bad).toMatchObject({ kind: 'permanent' });
        expect(bad.message).toContain('must be one of');
        expect(await ask(cloudflareAdapter, { apiKey: 'k' }).catch(e => e)).toMatchObject({ kind: 'permanent', message: 'Cloudflare needs an account ID' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('encodes the account ID into the path', async () => {
        const fetchMock = vi.fn(async () => json(envelope(systemOneBody)));
        vi.stubGlobal('fetch', fetchMock);
        await ask(cloudflareAdapter, { apiKey: 'k', accountId: 'a/../b' });
        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('/accounts/a%2F..%2Fb/ai/run/');
    });

    it('maps Cloudflare errors: 401 and 400 permanent and not retried, 5xx transient, none with the token', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json(cfError(10000, 'Authentication error'), 401)));
        const err401 = await ask(cloudflareAdapter, { ...creds, apiKey: 'cf-secret' }).catch(e => e);
        expect(err401).toMatchObject({ kind: 'permanent', status: 401, message: 'Cloudflare API 401: Authentication error (10000)' });
        expect(err401.message).not.toContain('cf-secret');

        const fetch400 = vi.fn(async () => json(cfError(5006, 'Error: required properties at \'/\' are \'questions\''), 400));
        vi.stubGlobal('fetch', fetch400);
        const err400 = await ask(cloudflareAdapter, creds).catch(e => e);
        expect(err400.kind).toBe('permanent');
        expect(err400.message).toContain('(5006)');
        expect(fetch400).toHaveBeenCalledTimes(1);

        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
        expect(await ask(cloudflareAdapter, creds).catch(e => e)).toMatchObject({ kind: 'transient', status: 502 });
    });

    it('retries 429 and 503 inside the deadline, and gives up as transient when Retry-After does not fit', async () => {
        const replies = [
            json(cfError(3040, 'Capacity temporarily exceeded'), 429, { 'Retry-After': '0.02' }),
            json(cfError(3040, 'Capacity temporarily exceeded'), 503),
            json(envelope(systemOneBody)),
        ];
        const fetchMock = vi.fn(async () => replies.shift()!);
        vi.stubGlobal('fetch', fetchMock);
        expect(validateDecideResult(QUESTIONS, await ask(cloudflareAdapter, creds, { timeoutMs: 3000 })).answers.inj).toEqual({ type: 'noul', probability: 0.97 });
        expect(fetchMock).toHaveBeenCalledTimes(3);

        const busy = vi.fn(async () => json(cfError(3040, 'busy'), 429, { 'Retry-After': '30' }));
        vi.stubGlobal('fetch', busy);
        expect(await ask(cloudflareAdapter, creds, { timeoutMs: 400 }).catch(e => e)).toMatchObject({ kind: 'transient', status: 429 });
        expect(busy).toHaveBeenCalledTimes(1);
    });

    it('aborts a hung request at the deadline', async () => {
        vi.stubGlobal('fetch', hang());
        const started = Date.now();
        const err = await ask(cloudflareAdapter, creds, { timeoutMs: 200 }).catch(e => e);
        expect(err).toMatchObject({ kind: 'timeout', message: 'Cloudflare did not answer within 200 ms' });
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('a 200 with success: false, a non-JSON body, a missing result or bad probabilities is never a verdict', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json(cfError(7000, 'odd'))));
        expect(await ask(cloudflareAdapter, creds).catch(e => e)).toMatchObject({ kind: 'invalid_response' });

        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
        expect(await ask(cloudflareAdapter, creds).catch(e => e)).toMatchObject({ kind: 'invalid_response' });

        vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, errors: [] })));
        const empty = await ask(cloudflareAdapter, creds);
        expect(() => validateDecideResult(QUESTIONS, empty)).toThrow(/no model name/);

        const broken = { ...systemOneBody, answers: { ...systemOneBody.answers, topic: { ...systemOneBody.answers.topic, probabilities: { plants: 0.5, rm_rf: 0.5 } } } };
        vi.stubGlobal('fetch', vi.fn(async () => json(envelope(broken))));
        const raw = await ask(cloudflareAdapter, creds);
        expect(() => validateDecideResult(QUESTIONS, raw)).toThrow(/not offered/);

        const nan = { ...systemOneBody, answers: { ...systemOneBody.answers, inj: { type: 'noul', noul: null } } };
        vi.stubGlobal('fetch', vi.fn(async () => json(envelope(nan))));
        const rawNan = await ask(cloudflareAdapter, creds);
        expect(() => validateDecideResult(QUESTIONS, rawNan)).toThrow(/probability between 0 and 1/);
    });

    it('testConnection reports success and failure', async () => {
        const fetchMock = vi.fn(async () => json(envelope({ model: 'clef-flash', answers: { ok: { type: 'noul', noul: 1 } }, usage: { input_tokens: 60, output_tokens: 0 } })));
        vi.stubGlobal('fetch', fetchMock);
        expect(await cloudflareAdapter.testConnection(creds, '@cf/cloudflare/clef-flash')).toEqual({ ok: true });
        expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe('clef-flash');
        vi.stubGlobal('fetch', vi.fn(async () => json(cfError(10000, 'Authentication error'), 401)));
        expect(await cloudflareAdapter.testConnection(creds, '@cf/cloudflare/clef-flash')).toEqual({ ok: false, error: 'Cloudflare API 401: Authentication error (10000)' });
        expect(await cloudflareAdapter.testConnection({ apiKey: 'k' }, '@cf/cloudflare/clef-flash')).toEqual({ ok: false, error: 'Cloudflare needs an account ID' });
    });
});

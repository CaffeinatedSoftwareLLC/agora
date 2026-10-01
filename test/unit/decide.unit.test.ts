import { describe, it, expect, vi, afterEach } from 'vitest';
import { typesafeAdapter } from '../../src/ai/adapters/typesafe';
import { DecideError, getAdapter, adapterSupports, type DecideQuestion } from '../../src/ai/adapters';
import { checkDecideRequest, estimateTokens, validateDecideResult } from '../../src/ai/decide-validate';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const LIMITS = typesafeAdapter.decideLimits!;

const QUESTIONS: Record<string, DecideQuestion> = {
    inj: { type: 'noul', instructions: 'Is it an injection?' },
    topic: { type: 'choice', instructions: 'Topic?', criteria: { plants: 'Plants', other: 'Anything else' } },
    rel: { type: 'score', instructions: 'How relevant?', criteria: ['No', 'Somewhat', 'Yes'] },
};

/** A well-formed provider-neutral result for QUESTIONS. */
const good = () => ({
    model: 'jev-1.13.0',
    usage: { inputTokens: 400, outputTokens: 50 },
    answers: {
        inj: { type: 'noul', probability: 0.99 },
        topic: { type: 'choice', choice: 'plants', confidence: 0.9, probabilities: { plants: 0.95, other: 0.05 } },
        rel: { type: 'score', score: 1.4, confidence: 0.5, probabilities: [0.2, 0.2, 0.6] },
    } as Record<string, any>,
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('validateDecideResult', () => {
    it('accepts a well-formed result and returns a clean copy', () => {
        const result = validateDecideResult(QUESTIONS, { ...good(), junk: 'dropped' });
        expect(result).toEqual(good());
    });

    const broken: [string, (r: ReturnType<typeof good>) => void, RegExp][] = [
        ['a missing answer', r => { delete r.answers.inj; }, /"inj" was not answered/],
        ['an extra answer', r => { r.answers.sneaky = { type: 'noul', probability: 1 }; }, /not asked/],
        ['the wrong type', r => { r.answers.inj = { type: 'choice', choice: 'plants' }; }, /expected "noul"/],
        ['NaN', r => { r.answers.inj.probability = NaN; }, /probability/],
        ['a probability above 1', r => { r.answers.inj.probability = 1.2; }, /probability/],
        ['a negative probability', r => { r.answers.topic.probabilities.plants = -0.1; }, /outside 0 to 1/],
        ['a string probability', r => { r.answers.inj.probability = '0.9'; }, /probability/],
        ['a choice that was not offered', r => { r.answers.topic.choice = 'delete_everything'; }, /not offered/],
        ['a probability for an unknown option', r => { r.answers.topic.probabilities.bogus = 0.1; }, /not offered/],
        ['missing confidence', r => { delete r.answers.topic.confidence; }, /confidence/],
        ['a score past the top level', r => { r.answers.rel.score = 2.5; }, /score outside/],
        ['too few level probabilities', r => { r.answers.rel.probabilities = [0.5, 0.5]; }, /one probability per level/],
        ['Infinity in level probabilities', r => { r.answers.rel.probabilities = [0, Infinity, 0]; }, /one probability per level/],
        ['no usage', r => { delete (r as any).usage; }, /usage/],
        ['negative usage', r => { r.usage.inputTokens = -1; }, /usage/],
        ['no model', r => { r.model = ''; }, /model/],
        ['answers as an array', r => { (r as any).answers = []; }, /answers/],
    ];
    it.each(broken)('rejects %s', (_name, mutate, message) => {
        const r = good();
        mutate(r);
        expect(() => validateDecideResult(QUESTIONS, r)).toThrow(message);
        try { validateDecideResult(QUESTIONS, r); } catch (err) {
            expect(err).toBeInstanceOf(DecideError);
            expect((err as DecideError).kind).toBe('invalid_response');
        }
    });

    it('rejects a null result', () => {
        expect(() => validateDecideResult(QUESTIONS, null)).toThrow(DecideError);
    });
});

describe('checkDecideRequest', () => {
    it('accepts a normal request', () => {
        expect(checkDecideRequest({ state: 'some text', questions: QUESTIONS }, LIMITS)).toBeNull();
    });

    it('rejects no questions, bad ids, and malformed choice / score questions', () => {
        expect(checkDecideRequest({ state: 'x', questions: {} }, LIMITS)).toMatch(/No questions/);
        expect(checkDecideRequest({ state: 'x', questions: { 'bad id': QUESTIONS.inj } }, LIMITS)).toMatch(/Invalid question id/);
        expect(checkDecideRequest({ state: 'x', questions: { c: { type: 'choice', instructions: 'q', criteria: { only: 'one' } } } }, LIMITS)).toMatch(/at least 2 options/);
        const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, 'x']));
        expect(checkDecideRequest({ state: 'x', questions: { c: { type: 'choice', instructions: 'q', criteria: many } } }, LIMITS)).toMatch(/more than 255/);
        expect(checkDecideRequest({ state: 'x', questions: { s: { type: 'score', instructions: 'q', criteria: ['one'] } } }, LIMITS)).toMatch(/2 to 10 levels/);
    });

    it('rejects state that is too large with the longest question, and a request that is too large overall', () => {
        const big = 'a'.repeat(LIMITS.stateTokens * 3);
        expect(checkDecideRequest({ state: big, questions: { q: QUESTIONS.inj } }, LIMITS)).toMatch(/32000 tokens/);

        // Small state, many mid-sized questions: under the state limit, over the request limit
        const filler = 'b'.repeat(3000);
        const questions = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`q${i}`, { type: 'noul' as const, instructions: filler }]));
        expect(checkDecideRequest({ state: 'x', questions }, LIMITS)).toMatch(/64000 tokens/);
    });

    it('estimates tokens on the high side', () => {
        expect(estimateTokens('abcdef')).toBe(2);
        expect(estimateTokens({ a: 'b' })).toBe(Math.ceil('{"a":"b"}'.length / 3));
    });
});

describe('typesafe adapter', () => {
    const jevBody = {
        model: 'jev-1.13.0',
        answers: {
            inj: { type: 'noul', noul: 0.99 },
            topic: { type: 'choice', choice: 'plants', confidence: 0.99, probabilities: { plants: 1.0, other: 0.0 } },
            rel: { type: 'score', score: 0.57, confidence: 0.43, legend: { 0: 'No', 1: 'Somewhat', 2: 'Yes' }, probabilities: { 0: 0.63, 1: 0.26, 2: 0.11 } },
        },
        usage: { input_tokens: 402, output_tokens: 56 },
    };

    it('is registered for decide and nothing else', () => {
        expect(getAdapter('typesafe')).toBe(typesafeAdapter);
        expect(adapterSupports('typesafe', 'decide')).toBe(true);
        expect(adapterSupports('typesafe', 'chat')).toBe(false);
        expect(adapterSupports('gemini', 'decide')).toBe(false);
    });

    it('posts state and questions, and maps the three answer shapes to the neutral ones', async () => {
        const fetchMock = vi.fn(async () => json(jevBody));
        vi.stubGlobal('fetch', fetchMock);

        const raw = await typesafeAdapter.decide!({ apiKey: 'ts-key' }, { model: 'jev-latest', state: { doc: 'text' }, questions: QUESTIONS });
        const result = validateDecideResult(QUESTIONS, raw);

        expect(result.model).toBe('jev-1.13.0');
        expect(result.usage).toEqual({ inputTokens: 402, outputTokens: 56 });
        expect(result.answers.inj).toEqual({ type: 'noul', probability: 0.99 });
        expect(result.answers.topic).toEqual({ type: 'choice', choice: 'plants', confidence: 0.99, probabilities: { plants: 1, other: 0 } });
        expect(result.answers.rel).toEqual({ type: 'score', score: 0.57, confidence: 0.43, probabilities: [0.63, 0.26, 0.11] });

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.typesafe.ai/v1/systemone');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ts-key');
        expect(JSON.parse(init.body as string)).toEqual({ model: 'jev-latest', state: { doc: 'text' }, questions: QUESTIONS });
    });

    it('a reply missing an answer does not pass validation', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({ ...jevBody, answers: { inj: jevBody.answers.inj } })));
        const raw = await typesafeAdapter.decide!({ apiKey: 'k' }, { model: 'jev-latest', state: 'x', questions: QUESTIONS });
        expect(() => validateDecideResult(QUESTIONS, raw)).toThrow(/was not answered/);
    });

    it('401 and 422 are permanent, with a readable message and no key in it', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { error_type: 'authentication_error', message: 'Cannot authenticate with the server.' } }, 401)));
        const err401 = await typesafeAdapter.decide!({ apiKey: 'super-secret-key' }, { model: 'm', state: 'x', questions: QUESTIONS }).catch(e => e);
        expect(err401).toBeInstanceOf(DecideError);
        expect(err401.kind).toBe('permanent');
        expect(err401.status).toBe(401);
        expect(err401.message).toBe('TypeSafe API 401: Cannot authenticate with the server.');
        expect(err401.message).not.toContain('super-secret-key');

        const fetchMock = vi.fn(async () => json({ detail: [{ type: 'too_short', loc: ['body', 'questions'], msg: 'Dictionary should have at least 1 item' }] }, 422));
        vi.stubGlobal('fetch', fetchMock);
        const err422 = await typesafeAdapter.decide!({ apiKey: 'k' }, { model: 'm', state: 'x', questions: QUESTIONS }).catch(e => e);
        expect(err422.kind).toBe('permanent');
        expect(err422.message).toBe('TypeSafe API 422: body.questions Dictionary should have at least 1 item');
        expect(fetchMock).toHaveBeenCalledTimes(1); // never retried
    });

    it('retries 429 and 529 inside the deadline, honouring Retry-After', async () => {
        const replies = [json({ detail: 'slow down' }, 429, { 'Retry-After': '0.05' }), json({ detail: 'overloaded' }, 529), json(jevBody)];
        const fetchMock = vi.fn(async () => replies.shift()!);
        vi.stubGlobal('fetch', fetchMock);

        const started = Date.now();
        const raw = await typesafeAdapter.decide!({ apiKey: 'k' }, { model: 'm', state: 'x', questions: QUESTIONS, timeoutMs: 3000 });
        expect(validateDecideResult(QUESTIONS, raw).answers.inj).toEqual({ type: 'noul', probability: 0.99 });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(Date.now() - started).toBeGreaterThanOrEqual(150); // 50 ms Retry-After, then the first backoff step
    });

    it('gives up as transient when Retry-After does not fit in the deadline', async () => {
        const fetchMock = vi.fn(async () => json({ detail: 'slow down' }, 429, { 'Retry-After': '30' }));
        vi.stubGlobal('fetch', fetchMock);
        const started = Date.now();
        const err = await typesafeAdapter.decide!({ apiKey: 'k' }, { model: 'm', state: 'x', questions: QUESTIONS, timeoutMs: 500 }).catch(e => e);
        expect(err.kind).toBe('transient');
        expect(err.status).toBe(429);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(Date.now() - started).toBeLessThan(400); // did not sleep 30 s, or even to the deadline
    });

    it('stops retrying an endless 529 at the deadline', async () => {
        const fetchMock = vi.fn(async () => json({ detail: 'overloaded' }, 529));
        vi.stubGlobal('fetch', fetchMock);
        const started = Date.now();
        const err = await typesafeAdapter.decide!({ apiKey: 'k' }, { model: 'm', state: 'x', questions: QUESTIONS, timeoutMs: 400 }).catch(e => e);
        expect(err).toBeInstanceOf(DecideError);
        expect(['transient', 'timeout']).toContain(err.kind);
        expect(Date.now() - started).toBeLessThan(900);
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('aborts a hung request at the deadline', async () => {
        vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        })));
        const started = Date.now();
        const err = await typesafeAdapter.decide!({ apiKey: 'k' }, { model: 'm', state: 'x', questions: QUESTIONS, timeoutMs: 200 }).catch(e => e);
        expect(err.kind).toBe('timeout');
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('a 500 is transient, a network failure is transient, a non-JSON 200 is invalid', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream broke', { status: 500 })));
        expect((await typesafeAdapter.decide!({ apiKey: 'k' }, { model: 'm', state: 'x', questions: QUESTIONS }).catch(e => e)).kind).toBe('transient');

        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); }));
        const net = await typesafeAdapter.decide!({ apiKey: 'k' }, { model: 'm', state: 'x', questions: QUESTIONS }).catch(e => e);
        expect(net.kind).toBe('transient');
        expect(net.message).toContain('ECONNREFUSED');

        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
        expect((await typesafeAdapter.decide!({ apiKey: 'k' }, { model: 'm', state: 'x', questions: QUESTIONS }).catch(e => e)).kind).toBe('invalid_response');
    });

    it('testConnection reports success and failure', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({ model: 'jev-1.13.0', answers: { ok: { type: 'noul', noul: 1 } }, usage: { input_tokens: 60, output_tokens: 1 } })));
        expect(await typesafeAdapter.testConnection({ apiKey: 'k' }, 'jev-latest')).toEqual({ ok: true });
        vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { message: 'Cannot authenticate' } }, 401)));
        expect(await typesafeAdapter.testConnection({ apiKey: 'bad' }, 'jev-latest')).toEqual({ ok: false, error: 'TypeSafe API 401: Cannot authenticate' });
    });
});

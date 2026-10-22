import { DecideError, type Adapter, type DecideAnswer, type DecideLimits, type DecideQuestion, type DecideRequest, type DecideResult } from './adapters';

/**
 * Checks on both sides of a decision call. Requests are checked before any provider
 * call (so an oversized one costs nothing); answers are checked before any caller
 * acts on them, so a malformed or partial reply can never be read as a verdict.
 */

const QUESTION_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Token count of a value as sent. By default a rough, deliberately high estimate
 * (3 characters per token; English prose is nearer 4) for providers that refuse an
 * oversized request. For providers that cut state instead (`limits.countBytes`), the
 * UTF-8 bytes of its JSON: a hard upper bound, since no token is shorter than a byte.
 */
export function estimateTokens(value: unknown, limits?: Pick<DecideLimits, 'countBytes'>): number {
    const json = JSON.stringify(value ?? '');
    if (limits?.countBytes) return Buffer.byteLength(json, 'utf8');
    const text = typeof value === 'string' ? value : json;
    return Math.ceil(text.length / 3);
}

/** Never end a piece between the two halves of a surrogate pair (an emoji, say). */
const safeEnd = (text: string, end: number) => {
    const code = text.charCodeAt(end - 1);
    return end > 0 && end < text.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
};

/** The longest prefix of `text` whose estimate (as a JSON string) is at most `budget`. */
export function fitPrefix(text: string, budget: number, limits?: Pick<DecideLimits, 'countBytes'>): string {
    if (estimateTokens(text, limits) <= budget) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (estimateTokens(text.slice(0, mid), limits) <= budget) lo = mid;
        else hi = mid - 1;
    }
    return text.slice(0, safeEnd(text, lo));
}

/**
 * Split `text` into consecutive pieces that each fit `budget` and together are the
 * whole text, preferring to break at a paragraph, line or sentence in each piece's
 * last fifth. Null when not even one character fits.
 */
export function splitToFit(text: string, budget: number, limits?: Pick<DecideLimits, 'countBytes'>): string[] | null {
    const pieces: string[] = [];
    let rest = text;
    while (rest.length > 0) {
        let piece = fitPrefix(rest, budget, limits);
        if (piece.length === 0) return null;
        if (piece.length < rest.length) {
            const cut = Math.max(piece.lastIndexOf('\n\n'), piece.lastIndexOf('\n'), piece.lastIndexOf('. ') + 1);
            if (cut > piece.length * 0.8) piece = piece.slice(0, cut);
        }
        pieces.push(piece);
        rest = rest.slice(piece.length);
    }
    return pieces;
}

/** The limits that apply to one model of a decision adapter. */
export function decideLimitsFor(adapter: Pick<Adapter, 'decideLimits' | 'decideModelLimits'>, model: string): DecideLimits | undefined {
    return adapter.decideModelLimits?.[model] ?? adapter.decideLimits;
}

/** Null when the request is acceptable, otherwise why not. */
export function checkDecideRequest(req: Pick<DecideRequest, 'state' | 'questions'>, limits: DecideLimits): string | null {
    const ids = Object.keys(req.questions);
    if (ids.length === 0) return 'No questions';
    if (limits.maxQuestions !== undefined && ids.length > limits.maxQuestions) return `More than ${limits.maxQuestions} questions`;

    let longest = 0;
    const stateSize = estimateTokens(req.state, limits);
    let total = stateSize;
    let options = 0;
    for (const id of ids) {
        if (!QUESTION_ID.test(id)) return `Invalid question id "${id.slice(0, 64)}"`;
        const q = req.questions[id];
        if (q.type === 'choice') {
            const count = Object.keys(q.criteria).length;
            if (count < 2) return `Question "${id}" needs at least 2 options`;
            if (count > limits.maxChoiceOptions) return `Question "${id}" has more than ${limits.maxChoiceOptions} options`;
            options += count;
        } else if (q.type === 'score') {
            if (q.criteria.length < limits.minScoreLevels || q.criteria.length > limits.maxScoreLevels) {
                return `Question "${id}" needs ${limits.minScoreLevels} to ${limits.maxScoreLevels} levels`;
            }
            options += q.criteria.length;
        } else {
            options += 2;
        }
        const size = estimateTokens(q, limits);
        longest = Math.max(longest, size);
        total += size + estimateTokens(id, limits);
    }

    if (stateSize + longest > limits.stateTokens) {
        return `State and the longest question exceed ${limits.stateTokens} tokens`;
    }
    if (total > limits.requestTokens) return `Request exceeds ${limits.requestTokens} tokens`;
    if (limits.maxOptions !== undefined && options > limits.maxOptions) return `More than ${limits.maxOptions} answer options in one request`;
    return null;
}

const invalid = (why: string) => new DecideError('invalid_response', `Decision model returned an invalid answer: ${why}`);
const isProbability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function checkAnswer(id: string, q: DecideQuestion, a: any): DecideAnswer {
    if (!a || typeof a !== 'object') throw invalid(`"${id}" is not an object`);
    if (a.type !== q.type) throw invalid(`"${id}" is "${String(a.type).slice(0, 20)}", expected "${q.type}"`);

    if (q.type === 'noul') {
        if (!isProbability(a.probability)) throw invalid(`"${id}" has no probability between 0 and 1`);
        return { type: 'noul', probability: a.probability };
    }

    if (!isProbability(a.confidence)) throw invalid(`"${id}" has no confidence between 0 and 1`);

    if (q.type === 'choice') {
        const options = Object.keys(q.criteria);
        if (typeof a.choice !== 'string' || !options.includes(a.choice)) throw invalid(`"${id}" chose an option that was not offered`);
        if (!a.probabilities || typeof a.probabilities !== 'object' || Array.isArray(a.probabilities)) throw invalid(`"${id}" has no probabilities`);
        const probabilities: Record<string, number> = {};
        for (const [option, p] of Object.entries(a.probabilities)) {
            if (!options.includes(option)) throw invalid(`"${id}" has a probability for an option that was not offered`);
            if (!isProbability(p)) throw invalid(`"${id}" has a probability outside 0 to 1`);
            probabilities[option] = p;
        }
        return { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities };
    }

    const levels = q.criteria.length;
    if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > levels - 1) {
        throw invalid(`"${id}" has a score outside 0 to ${levels - 1}`);
    }
    if (!Array.isArray(a.probabilities) || a.probabilities.length !== levels || !a.probabilities.every(isProbability)) {
        throw invalid(`"${id}" does not have one probability per level`);
    }
    return { type: 'score', score: a.score, confidence: a.confidence, probabilities: [...a.probabilities] };
}

/**
 * Check an adapter's result against the questions that were asked: every question
 * answered, nothing extra, each answer of the asked type with finite probabilities
 * and a choice that was offered. Returns a clean copy; throws `DecideError`.
 */
export function validateDecideResult(questions: Record<string, DecideQuestion>, result: unknown): DecideResult {
    const r = result as any;
    if (!r || typeof r !== 'object') throw invalid('no result');
    if (typeof r.model !== 'string' || !r.model) throw invalid('no model name');
    if (!r.usage || !isCount(r.usage.inputTokens) || !isCount(r.usage.outputTokens)) throw invalid('no usage');
    if (!r.answers || typeof r.answers !== 'object' || Array.isArray(r.answers)) throw invalid('no answers');

    const asked = Object.keys(questions);
    const extra = Object.keys(r.answers).filter(id => !asked.includes(id));
    if (extra.length > 0) throw invalid(`${extra.length} answer(s) to questions that were not asked`);

    const answers: Record<string, DecideAnswer> = {};
    for (const id of asked) {
        if (!(id in r.answers)) throw invalid(`"${id}" was not answered`);
        answers[id] = checkAnswer(id, questions[id], r.answers[id]);
    }
    return { model: r.model.slice(0, 100), answers, usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } };
}

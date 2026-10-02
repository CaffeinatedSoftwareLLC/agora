import { DecideError, type DecideAnswer, type DecideLimits, type DecideQuestion, type DecideRequest, type DecideResult } from './adapters';

/**
 * Checks on both sides of a decision call. Requests are checked before any provider
 * call (so an oversized one costs nothing); answers are checked before any caller
 * acts on them, so a malformed or partial reply can never be read as a verdict.
 */

const QUESTION_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Rough token count. Deliberately high (3 characters per token; English prose is
 * nearer 4) so a request that passes here is not refused by the provider.
 */
export function estimateTokens(value: unknown): number {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return Math.ceil(text.length / 3);
}

/** Null when the request is acceptable, otherwise why not. */
export function checkDecideRequest(req: Pick<DecideRequest, 'state' | 'questions'>, limits: DecideLimits): string | null {
    const ids = Object.keys(req.questions);
    if (ids.length === 0) return 'No questions';

    let longest = 0;
    let total = estimateTokens(req.state);
    for (const id of ids) {
        if (!QUESTION_ID.test(id)) return `Invalid question id "${id.slice(0, 64)}"`;
        const q = req.questions[id];
        if (q.type === 'choice') {
            const options = Object.keys(q.criteria);
            if (options.length < 2) return `Question "${id}" needs at least 2 options`;
            if (options.length > limits.maxChoiceOptions) return `Question "${id}" has more than ${limits.maxChoiceOptions} options`;
        } else if (q.type === 'score') {
            if (q.criteria.length < limits.minScoreLevels || q.criteria.length > limits.maxScoreLevels) {
                return `Question "${id}" needs ${limits.minScoreLevels} to ${limits.maxScoreLevels} levels`;
            }
        }
        const size = estimateTokens(q);
        longest = Math.max(longest, size);
        total += size;
    }

    if (estimateTokens(req.state) + longest > limits.stateTokens) {
        return `State and the longest question exceed ${limits.stateTokens} tokens`;
    }
    if (total > limits.requestTokens) return `Request exceeds ${limits.requestTokens} tokens`;
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

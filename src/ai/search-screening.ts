import type { Adapter, DecideQuestion, SearchCitation, SearchResult } from './adapters';
import { decide, decisionReady, loadDecisionSettings, type DecisionSettings } from './decide';
import { estimateTokens } from './decide-validate';
import { injectionQuestion, QUESTION_VERSIONS } from './decision-questions';
import type { Queryable } from './routing';

/**
 * Search result screening (docs/planning/jev-wbs.md, B). Before search results reach
 * an agent or run code, a decision model is asked, per piece of text, whether it
 * carries instructions aimed at the AI reading it (prompt injection).
 *
 * This lowers risk. It is not a security boundary: text that passes is still
 * untrusted, and a model can be wrong. Anything a result may do stays limited by
 * what the reading agent is allowed to do.
 *
 * Modes:
 * - Off (default): results pass through untouched, marked `off`. No decision call.
 * - On: flagged text is withheld; suspect text is delivered, marked. If screening
 *   cannot run (no model, budget spent, provider failure), results are delivered
 *   marked `unavailable`. Search keeps working without a decision model.
 * - Strict: a search that cannot be fully screened is refused, and suspect text is
 *   withheld too.
 */

export type ScreenVerdict = 'clean' | 'suspect' | 'flagged' | 'unscreened';

/**
 * - `off`: screening is switched off.
 * - `screened`: every piece of text was checked.
 * - `partial`: some text could not be checked (too long, or a call failed).
 * - `unavailable`: nothing could be checked.
 * - `not_applicable`: the provider's terms forbid passing its results to another model.
 */
export type ScreeningStatus = 'off' | 'screened' | 'partial' | 'unavailable' | 'not_applicable';

export interface ScreenedCitation extends SearchCitation {
    /** Stable within one response: `c0`, `c1`, … in the provider's order. */
    id: string;
    verdict: ScreenVerdict;
}

export interface ScreeningInfo {
    status: ScreeningStatus;
    /** Verdict on the answer text. */
    answer?: ScreenVerdict;
    /** How many pieces of text were withheld. */
    withheld?: number;
    /** The model that answered, and the wording version of the question it was asked. */
    model?: string;
    questionVersion?: string;
    /** Why screening did not (fully) run. */
    reason?: string;
}

export interface ScreenedSearch {
    answer: string;
    citations: (SearchCitation | ScreenedCitation)[];
    screening: ScreeningInfo;
}

export type ScreenOutcome =
    | { ok: true; result: ScreenedSearch }
    /** Strict mode only: the search must not be delivered. */
    | { ok: false; error: string };

/** Longer text than this is not sent for screening; it is reported as unscreened. */
const MAX_ITEM_CHARS = 8000;
/** Room left for the questions when packing items into one request. */
const BATCH_STATE_TOKENS = 20_000;
const MAX_BATCHES = 4;

const NOT_APPLICABLE = 'This search provider\'s terms do not allow its results to be passed to another model';
const strictRefusal = (why: string) => `Search results could not be screened and strict screening is on: ${why}`;

/**
 * Before the search call: with strict screening on, refuse now if screening cannot
 * happen, so nothing is spent on a search whose results would be thrown away.
 * Anything else proceeds.
 */
export async function screeningPrecheck(db: Queryable, serverId: string, adapter: Pick<Adapter, 'restrictedSearchResults' | 'label'>): Promise<{ ok: true } | { ok: false; error: string }> {
    const settings = await loadDecisionSettings(db, serverId);
    if (!settings.uses.search_screening.enabled || !settings.screeningStrict) return { ok: true };
    if (adapter.restrictedSearchResults) return { ok: false, error: strictRefusal(`${adapter.label} results cannot be screened. Use another search provider, or turn strict screening off.`) };
    const ready = await decisionReady(db, serverId, 'search_screening');
    if (!ready.ok) return { ok: false, error: strictRefusal(ready.reason) };
    return { ok: true };
}

interface Item {
    id: string;
    text: string;
}

function verdictOf(probability: number, settings: DecisionSettings): ScreenVerdict {
    if (probability >= settings.screeningFlagThreshold) return 'flagged';
    if (probability >= settings.screeningSuspectThreshold) return 'suspect';
    return 'clean';
}

const WORST: Record<ScreenVerdict, number> = { clean: 0, unscreened: 1, suspect: 2, flagged: 3 };
const worst = (verdicts: ScreenVerdict[]): ScreenVerdict => verdicts.reduce((a, b) => (WORST[b] > WORST[a] ? b : a), 'clean');

/** Pack items into as few requests as fit the model's limits. */
function batches(items: Item[]): Item[][] {
    const out: Item[][] = [];
    let current: Item[] = [];
    let size = 0;
    for (const item of items) {
        const tokens = estimateTokens(item.text);
        if (current.length > 0 && size + tokens > BATCH_STATE_TOKENS) {
            out.push(current);
            current = [];
            size = 0;
        }
        current.push(item);
        size += tokens;
    }
    if (current.length > 0) out.push(current);
    return out;
}

/**
 * Screen one search result. `adapter` is the search provider that produced it.
 * Never throws for decision-model trouble; in strict mode it refuses instead.
 */
export async function screenSearchResult(db: Queryable, input: {
    serverId: string;
    adapter: Pick<Adapter, 'restrictedSearchResults' | 'label'>;
    result: Pick<SearchResult, 'answer' | 'citations' | 'display'>;
    channelId?: string | null;
    userId?: string | null;
    runId?: string | null;
}): Promise<ScreenOutcome> {
    const { result } = input;
    const settings = await loadDecisionSettings(db, input.serverId);
    const untouched = (screening: ScreeningInfo): ScreenOutcome =>
        ({ ok: true, result: { answer: result.answer, citations: result.citations, screening } });

    if (!settings.uses.search_screening.enabled) return untouched({ status: 'off' });
    const strict = settings.screeningStrict;

    if (input.adapter.restrictedSearchResults || result.display) {
        if (strict) return { ok: false, error: strictRefusal(`${input.adapter.label} results cannot be screened. Use another search provider, or turn strict screening off.`) };
        return untouched({ status: 'not_applicable', reason: NOT_APPLICABLE });
    }

    // Every piece of text an agent would read, each judged on its own
    const items: Item[] = [];
    const skipped = new Set<string>();
    const add = (id: string, text: string | undefined) => {
        if (!text || !text.trim()) return;
        if (text.length > MAX_ITEM_CHARS) skipped.add(id);
        else items.push({ id, text });
    };
    add('answer', result.answer);
    result.citations.forEach((c, i) => {
        add(`c${i}_title`, c.title);
        add(`c${i}_snippet`, c.snippet);
    });

    const verdicts = new Map<string, ScreenVerdict>();
    for (const id of skipped) verdicts.set(id, 'unscreened');
    let model: string | undefined;
    let failure: string | undefined;

    const groups = batches(items);
    if (groups.length > MAX_BATCHES) {
        failure = 'Too much text to screen';
        for (const group of groups.splice(MAX_BATCHES)) for (const item of group) verdicts.set(item.id, 'unscreened');
    }
    await Promise.all(groups.map(async (group) => {
        const questions: Record<string, DecideQuestion> = {};
        const state: Record<string, string> = {};
        for (const item of group) {
            state[item.id] = item.text;
            questions[item.id] = injectionQuestion(`items.${item.id}`);
        }
        const outcome = await decide(db, {
            serverId: input.serverId, use: 'search_screening', state: { items: state }, questions,
            channelId: input.channelId, userId: input.userId, runId: input.runId,
        });
        if (outcome.status !== 'ok') {
            failure = outcome.reason;
            for (const item of group) verdicts.set(item.id, 'unscreened');
            return;
        }
        model = outcome.model;
        for (const item of group) {
            const answer = outcome.answers[item.id];
            verdicts.set(item.id, answer.type === 'noul' ? verdictOf(answer.probability, settings) : 'unscreened');
        }
    }));

    const all = [...verdicts.values()];
    const unscreened = all.filter(v => v === 'unscreened').length;
    const status: ScreeningStatus = all.length === 0 || unscreened === 0 ? 'screened' : unscreened === all.length ? 'unavailable' : 'partial';
    if (status !== 'screened' && !failure) failure = 'Some text was too long to screen';

    if (strict && status !== 'screened') return { ok: false, error: strictRefusal(failure ?? 'screening did not complete') };

    // Withheld: flagged always; suspect too in strict mode
    const withhold = (v: ScreenVerdict) => v === 'flagged' || (strict && v === 'suspect');
    let withheld = 0;

    const answerVerdict = verdicts.get('answer') ?? 'clean';
    let answer = result.answer;
    if (withhold(answerVerdict)) {
        answer = '';
        withheld++;
    }

    const citations: ScreenedCitation[] = result.citations.map((c, i) => {
        const verdict = worst([verdicts.get(`c${i}_title`) ?? 'clean', verdicts.get(`c${i}_snippet`) ?? 'clean']);
        if (!withhold(verdict)) return { id: `c${i}`, ...c, verdict };
        // The link stays so a person can inspect the source; its text does not reach the agent
        withheld += (c.title ? 1 : 0) + (c.snippet ? 1 : 0);
        return { id: `c${i}`, url: c.url, verdict };
    });

    return {
        ok: true,
        result: {
            answer,
            citations,
            screening: {
                status,
                answer: answerVerdict,
                withheld,
                ...(model ? { model } : {}),
                questionVersion: QUESTION_VERSIONS.injection,
                ...(status !== 'screened' && failure ? { reason: failure } : {}),
            },
        },
    };
}

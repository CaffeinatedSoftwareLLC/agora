import { decide, type DecideFailure } from './decide';
import { intentQuestion, type AssistantIntent } from './decision-questions';
import { isAudioOverviewRequest, stripMentions } from './audio-overview';
import type { Queryable } from './routing';

/**
 * Which handler takes an explicit `@assistant` request (docs/planning/jev-wbs.md, A.1).
 *
 * With routing switched on and a decision model configured, the model classifies
 * the request. Otherwise, or if the model fails, the rules that predate it decide:
 * the audio overview keywords, else chat. The model only picks among handlers the
 * caller says are available; it never picks a provider or a model.
 */

/** The request is cut to this many characters before it is shown to the model. */
const MAX_REQUEST_CHARS = 2000;

export interface IntentDecision {
    intent: AssistantIntent;
    /** `model`: the decision model chose. `rules`: the keyword rules chose. */
    source: 'model' | 'rules';
    confidence?: number;
    /** Why the rules decided, when routing was attempted and did not produce a usable answer. */
    fallback?: DecideFailure | 'low_confidence' | 'single_handler';
}

/** The rules used before a decision model existed, and whenever one is not available. */
export function intentByRules(content: string): AssistantIntent {
    return isAudioOverviewRequest(content) ? 'audio_overview' : 'chat';
}

export async function classifyIntent(db: Queryable, req: {
    serverId: string;
    content: string;
    /** Handlers that can run right now. `chat` is always one of them. */
    available: readonly AssistantIntent[];
    channelId?: string;
    userId?: string;
}): Promise<IntentDecision> {
    const rules = (fallback?: IntentDecision['fallback']): IntentDecision =>
        ({ intent: intentByRules(req.content), source: 'rules', ...(fallback ? { fallback } : {}) });

    // Nothing to choose between: no call
    const offered = req.available.includes('chat') ? req.available : ['chat' as const, ...req.available];
    if (offered.length < 2) return rules('single_handler');

    const request = stripMentions(req.content).replace(/\s+/g, ' ').trim().slice(0, MAX_REQUEST_CHARS);
    const outcome = await decide(db, {
        serverId: req.serverId,
        use: 'routing',
        state: { request },
        questions: { intent: intentQuestion(offered) },
        channelId: req.channelId,
        userId: req.userId,
    });
    if (outcome.status !== 'ok') return rules(outcome.status === 'disabled' ? undefined : outcome.status);

    const answer = outcome.answers.intent;
    // validateDecideResult guarantees a choice that was offered
    if (answer.type !== 'choice') return rules('invalid_response');

    if (answer.confidence < outcome.settings.routingMinConfidence) {
        return { intent: 'chat', source: 'model', confidence: answer.confidence, fallback: 'low_confidence' };
    }
    return { intent: answer.choice as AssistantIntent, source: 'model', confidence: answer.confidence };
}

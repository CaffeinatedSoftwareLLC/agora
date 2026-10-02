import { DecideError, type DecideAnswer, type DecideQuestion, type DecideText, type Usage } from './adapters';
import { checkDecideRequest, validateDecideResult } from './decide-validate';
import { checkBudget, recordUsage, resolveRoute, type Queryable, type ResolvedRoute, type RouteRow } from './routing';

/**
 * The one place Agora asks a decision model anything (docs/planning/jev-wbs.md, J0.4).
 *
 * A decision model is optional. Every caller gets a typed outcome and must have a
 * fallback for anything but `ok`: with no `decide` route, or with the use switched
 * off, this returns before any provider call. An answer informs the caller's code;
 * it never grants access, loosens a limit, or picks a provider.
 */

export const DECISION_USES = ['routing', 'search_screening', 'file_tagging', 'file_ranking'] as const;
export type DecisionUse = typeof DECISION_USES[number];

export interface DecisionUseSettings {
    enabled: boolean;
    /** Percent of the route's daily budget this use may spend. 0 switches the use off. */
    sharePct: number;
    /** Hard cap on requests per day for this use (null = none). */
    dailyRequests: number | null;
}

export interface DecisionSettings {
    uses: Record<DecisionUse, DecisionUseSettings>;
    routingMinConfidence: number;
    screeningFlagThreshold: number;
    screeningSuspectThreshold: number;
    screeningStrict: boolean;
    tagThreshold: number;
}

/** Settings column prefix per use. */
export const USE_COLUMN: Record<DecisionUse, string> = {
    routing: 'routing',
    search_screening: 'screening',
    file_tagging: 'tagging',
    file_ranking: 'ranking',
};

/** What a server has before an admin touches anything: every use off. */
export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
    uses: {
        routing: { enabled: false, sharePct: 25, dailyRequests: null },
        search_screening: { enabled: false, sharePct: 25, dailyRequests: null },
        file_tagging: { enabled: false, sharePct: 25, dailyRequests: null },
        file_ranking: { enabled: false, sharePct: 25, dailyRequests: null },
    },
    routingMinConfidence: 0.6,
    screeningFlagThreshold: 0.7,
    screeningSuspectThreshold: 0.35,
    screeningStrict: false,
    tagThreshold: 0.5,
};

export function decisionSettingsFromRow(row: any): DecisionSettings {
    if (!row) return DEFAULT_DECISION_SETTINGS;
    const use = (prefix: string): DecisionUseSettings => ({
        enabled: row[`${prefix}_enabled`],
        sharePct: row[`${prefix}_share_pct`],
        dailyRequests: row[`${prefix}_daily_requests`] ?? null,
    });
    return {
        uses: {
            routing: use('routing'),
            search_screening: use('screening'),
            file_tagging: use('tagging'),
            file_ranking: use('ranking'),
        },
        routingMinConfidence: Number(row.routing_min_confidence),
        screeningFlagThreshold: Number(row.screening_flag_threshold),
        screeningSuspectThreshold: Number(row.screening_suspect_threshold),
        screeningStrict: row.screening_strict,
        tagThreshold: Number(row.tag_threshold),
    };
}

export async function loadDecisionSettings(db: Queryable, serverId: string): Promise<DecisionSettings> {
    const res = await db.query('SELECT * FROM ai_decision_settings WHERE server_id = $1', [serverId]);
    return decisionSettingsFromRow(res.rows[0]);
}

/**
 * Why a decision was not made.
 * - `disabled`: the use (or the route) is switched off. No call was made.
 * - `unconfigured`: there is no usable `decide` route. No call was made.
 * - `over_budget`: the route's daily budget, or this use's share of it, is spent. No call was made.
 * - `too_large`: the request exceeds the model's limits. No call was made.
 * - `provider_error`: the provider failed or timed out.
 * - `invalid_response`: the provider answered, but not with what was asked.
 */
export type DecideFailure = 'disabled' | 'unconfigured' | 'over_budget' | 'too_large' | 'provider_error' | 'invalid_response';

export type DecideOutcome =
    | { status: 'ok'; answers: Record<string, DecideAnswer>; model: string; usage: Usage; /** The server's thresholds, for the caller to apply. */ settings: DecisionSettings }
    | { status: DecideFailure; reason: string; /** Worth trying again later (rate limit, timeout, budget). */ retryable: boolean };

export type DecideReady =
    | { ok: true; settings: DecisionSettings; route: ResolvedRoute }
    | { ok: false; status: 'disabled' | 'unconfigured' | 'over_budget'; reason: string; settings: DecisionSettings };

const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/** A use's slice of a route limit: at least 1, so a small limit with a small share is not silently zero. */
const slice = (limit: number | null, pct: number) => (limit === null ? null : Math.max(1, Math.floor(limit * pct / 100)));

/**
 * This use's share of the route's daily budget, plus its own request cap. Counted
 * from recorded usage, like `checkBudget`: concurrent calls can overshoot by what
 * is in flight. It is a soft limit that keeps one use from starving another.
 */
async function checkUseBudget(db: Queryable, route: RouteRow, use: DecisionUse, settings: DecisionUseSettings): Promise<{ ok: true } | { ok: false; error: string }> {
    const shareRequests = slice(num(route.daily_request_limit), settings.sharePct);
    const requestLimit = [shareRequests, settings.dailyRequests].filter((v): v is number => v !== null);
    const reqLimit = requestLimit.length > 0 ? Math.min(...requestLimit) : null;
    const tokLimit = slice(num(route.daily_token_limit), settings.sharePct);
    const costLimit = slice(num(route.daily_cost_limit_micros), settings.sharePct);
    if (reqLimit === null && tokLimit === null && costLimit === null) return { ok: true };

    const res = await db.query(
        `SELECT COUNT(*)::bigint AS requests,
                COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
                COALESCE(SUM(cost_micros), 0)::bigint AS cost
         FROM ai_usage_events
         WHERE server_id = $1 AND capability = 'decide' AND decision_use = $2
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [route.server_id, use]
    );
    const today = res.rows[0];
    const label = use.replace('_', ' ');
    if (reqLimit !== null && Number(today.requests) >= reqLimit) return { ok: false, error: `Daily request limit reached for ${label} decisions (${reqLimit}/day)` };
    if (tokLimit !== null && Number(today.tokens) >= tokLimit) return { ok: false, error: `Daily token limit reached for ${label} decisions (${tokLimit}/day)` };
    if (costLimit !== null && Number(today.cost) >= costLimit) return { ok: false, error: `Daily cost limit reached for ${label} decisions` };
    return { ok: true };
}

/**
 * Whether a decision for this use could be made right now, without making one.
 * Callers with expensive preparation (decrypting a file, running a search) check
 * this first.
 */
export async function decisionReady(db: Queryable, serverId: string, use: DecisionUse): Promise<DecideReady> {
    const settings = await loadDecisionSettings(db, serverId);
    const useSettings = settings.uses[use];
    if (!useSettings.enabled || useSettings.sharePct === 0) {
        return { ok: false, status: 'disabled', reason: `${use.replace('_', ' ')} decisions are switched off`, settings };
    }

    const exists = await db.query(
        "SELECT enabled FROM ai_capability_routes WHERE server_id = $1 AND capability = 'decide'",
        [serverId]
    );
    if (exists.rows.length === 0) return { ok: false, status: 'unconfigured', reason: 'No decision model is configured', settings };
    if (!exists.rows[0].enabled) return { ok: false, status: 'disabled', reason: 'The decision model is switched off', settings };

    const resolved = await resolveRoute(db, serverId, 'decide');
    if (!resolved.ok) return { ok: false, status: 'unconfigured', reason: resolved.error, settings };
    if (!resolved.value.adapter.decide || !resolved.value.adapter.decideLimits) {
        return { ok: false, status: 'unconfigured', reason: `${resolved.value.adapter.label} cannot make decisions`, settings };
    }

    const total = await checkBudget(db, resolved.value.route);
    if (!total.ok) return { ok: false, status: 'over_budget', reason: total.error, settings };
    const share = await checkUseBudget(db, resolved.value.route, use, useSettings);
    if (!share.ok) return { ok: false, status: 'over_budget', reason: share.error, settings };

    return { ok: true, settings, route: resolved.value };
}

export interface DecideCall {
    serverId: string;
    use: DecisionUse;
    /** The content being judged. Untrusted text goes here and only here. */
    state: DecideText;
    questions: Record<string, DecideQuestion>;
    /** Total time allowed including retries (default: the adapter's, 3 s). */
    timeoutMs?: number;
    /** For the usage ledger. */
    channelId?: string | null;
    userId?: string | null;
    runId?: string | null;
    /** A `decisionReady` result from just before, to avoid checking twice. */
    ready?: DecideReady;
}

/** Ask the server's decision model. Never throws for provider trouble: see `DecideOutcome`. */
export async function decide(db: Queryable, call: DecideCall): Promise<DecideOutcome> {
    const ready = call.ready ?? await decisionReady(db, call.serverId, call.use);
    if (!ready.ok) return { status: ready.status, reason: ready.reason, retryable: ready.status === 'over_budget' };

    const { route } = ready;
    const tooLarge = checkDecideRequest(call, route.adapter.decideLimits!);
    if (tooLarge) return { status: 'too_large', reason: tooLarge, retryable: false };

    const started = Date.now();
    const usageBase = {
        serverId: call.serverId, capability: 'decide' as const, providerId: route.providerId, adapter: route.adapter.id,
        route: route.route, channelId: call.channelId, userId: call.userId, runId: call.runId, decisionUse: call.use,
    };

    try {
        const raw = await route.adapter.decide!(route.credentials, {
            model: route.model, state: call.state, questions: call.questions, timeoutMs: call.timeoutMs,
        });
        const result = validateDecideResult(call.questions, raw);
        // Recorded under the model that answered: `jev-latest` is an alias that moves
        await recordUsage(db, { ...usageBase, model: result.model, usage: result.usage, latencyMs: Date.now() - started });
        return { status: 'ok', answers: result.answers, model: result.model, usage: result.usage, settings: ready.settings };
    } catch (err) {
        const failure = err instanceof DecideError ? err : new DecideError('transient', err instanceof Error ? err.message : String(err));
        await recordUsage(db, {
            ...usageBase, model: route.model, usage: { inputTokens: 0, outputTokens: 0 },
            latencyMs: Date.now() - started, error: failure.message.slice(0, 500),
        });
        return failure.kind === 'invalid_response'
            ? { status: 'invalid_response', reason: failure.message, retryable: false }
            : { status: 'provider_error', reason: failure.message, retryable: failure.kind !== 'permanent' };
    }
}

/**
 * How a server budgets its model agents (docs/model-agents.md, "Budget"):
 * - `shared` (default): agent calls are chat usage and count toward the Chat route's
 *   daily limits together with @assistant's.
 * - `separate`: agent calls count only toward a pool for all of the server's agents,
 *   and the Chat route's limits count @assistant's calls only.
 * Per-agent limits apply in both modes. The mode is read on every check, so a change
 * takes effect on the next call.
 */

interface Queryable {
    query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export type AgentBudgetMode = 'shared' | 'separate';

export interface AgentBudgetSettings {
    mode: AgentBudgetMode;
    dailyRequestLimit: number | null;
    dailyTokenLimit: number | null;
    dailyCostLimitMicros: number | null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function agentBudgetFromRow(row: any): AgentBudgetSettings {
    return {
        mode: row?.budget_mode === 'separate' ? 'separate' : 'shared',
        dailyRequestLimit: num(row?.daily_request_limit),
        dailyTokenLimit: num(row?.daily_token_limit),
        dailyCostLimitMicros: num(row?.daily_cost_limit_micros),
    };
}

export async function loadAgentBudget(db: Queryable, serverId: string): Promise<AgentBudgetSettings> {
    const res = await db.query('SELECT * FROM ai_model_agent_settings WHERE server_id = $1', [serverId]);
    return agentBudgetFromRow(res.rows[0]);
}

/** Today's (UTC) usage by all of a server's model agents. */
export async function agentPoolToday(db: Queryable, serverId: string): Promise<{ requests: number; tokens: number; costMicros: number | null }> {
    const res = await db.query(
        `SELECT COUNT(*)::int AS requests, COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens, SUM(cost_micros)::bigint AS cost
         FROM ai_usage_events
         WHERE server_id = $1 AND model_agent_id IS NOT NULL
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [serverId]
    );
    const r = res.rows[0];
    return { requests: r.requests, tokens: Number(r.tokens), costMicros: num(r.cost) };
}

/** The pool limits of `separate` mode; null when none is reached. */
export async function agentPoolError(db: Queryable, serverId: string, settings: AgentBudgetSettings): Promise<string | null> {
    const { dailyRequestLimit: req, dailyTokenLimit: tok, dailyCostLimitMicros: cost } = settings;
    if (req === null && tok === null && cost === null) return null;
    const today = await agentPoolToday(db, serverId);
    if (req !== null && today.requests >= req) return `Daily request limit reached for model agents (${req}/day)`;
    if (tok !== null && today.tokens >= tok) return `Daily token limit reached for model agents (${tok}/day)`;
    if (cost !== null && (today.costMicros ?? 0) >= cost) return 'Daily cost limit reached for model agents';
    return null;
}

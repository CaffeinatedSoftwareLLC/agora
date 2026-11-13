/**
 * Agent limits are the user's choice (docs/agent-limits.md): every one is "no limit" (NULL in the
 * database, `null` in the API) until the owner sets a number. The largest number the API takes is
 * the largest integer JSON carries exactly; it is not a product cap.
 */
export const MAX_LIMIT = Number.MAX_SAFE_INTEGER;
/** JSON Schema for a limit field: a positive integer, or null for "no limit". */
export const LIMIT_SCHEMA = { type: ['integer', 'null'], minimum: 1, maximum: MAX_LIMIT } as const;
/** A limit column as the API reports it: BIGINT comes back from pg as a string. */
export function limitOf(value: unknown): number | null {
    return value == null ? null : Number(value);
}

/** A channel's loop guard limit: null is off, and so is a 0 stored before migration 097 or by hand. */
export function hopLimitOf(value: unknown): number | null {
    return Number(value) > 0 ? Number(value) : null;
}

/** The limit that stopped a session: which one, the numbers, and whose it is (`sessionId`: this session or a parent). */
export interface ExhaustedBudget {
    sessionId: string;
    kind: 'wake' | 'token';
    used: number;
    limit: number;
    /**
     * Token limits only: 'session' when that session has a token limit of its own (set in its
     * session controls or given to a subtask), which is then the one to change; otherwise the
     * limit is its agent's "Tokens per session" in Settings → Agents.
     */
    source?: 'session' | 'agent';
}

const n = (value: number) => value.toLocaleString('en-US');

/**
 * The notice for a session a limit stopped. It names the limit, the numbers, whose limit it is
 * and the one action that lifts it. Settings → Agents changes reach existing sessions at once.
 */
export function budgetShelveNotice(profileName: string, sessionId: string, budget: ExhaustedBudget): string {
    const own = budget.sessionId === sessionId;
    const subject = own ? `Session for ${profileName}` : `Subtask session for ${profileName} (${sessionId})`;
    const unit = budget.kind === 'wake' ? 'wakes' : 'tokens';
    const name = budget.kind === 'wake' ? 'wake limit' : 'token limit';
    const whose = own ? `its ${name}` : `the ${name} of its parent session ${budget.sessionId}`;
    const where = budget.kind === 'wake'
        ? `Raise or remove "Wakes per session" for ${own ? profileName : "the parent's agent"} in [Agent settings](/settings/agents)`
        : budget.source === 'session'
        ? `That is ${own ? "this session's" : "the parent session's"} own token limit: raise or clear it in ${own ? 'its' : "the parent's"} session controls (the agent's chip, or its task card)`
        : `Raise or remove "Tokens per session" for ${own ? profileName : "the parent's agent"} in [Agent settings](/settings/agents)`;
    return `${subject} shelved: ${whose} is used up (${n(budget.used)} of ${n(budget.limit)} ${unit}). ${where}, then /resume ${sessionId}.`;
}

/** The same stop as one short line, for the 409 a refused resume returns and the session's status. */
export function limitStopSummary(budget: ExhaustedBudget, sessionId: string): string {
    const unit = budget.kind === 'wake' ? 'wakes' : 'tokens';
    const whose = budget.sessionId === sessionId ? '' : ` of parent session ${budget.sessionId}`;
    const own = budget.source === 'session' ? " (that session's own)" : '';
    return `${budget.kind === 'wake' ? 'Wake' : 'Token'} limit${whose}${own} reached: ${n(budget.used)} of ${n(budget.limit)} ${unit}.`;
}

/** A session shelved because its profile's API key is out of credit (agora-host `credit_exhausted`). */
export function creditShelveNotice(profileName: string, sessionId: string, apiKeyEnv: string | null): string {
    // OPENROUTER_API_KEY, or OPENROUTER_API_KEY_<NAME> for one key per agent
    const fix = apiKeyEnv?.startsWith('OPENROUTER_API_KEY')
        ? "its OpenRouter key is out of credit or has used up its credit limit. Raise the key's limit at https://openrouter.ai/settings/keys or wait for it to reset"
        : `its API key${apiKeyEnv ? ` (${apiKeyEnv})` : ''} is out of credit. Add credit to the key`;
    return `Session for ${profileName} shelved: ${fix}, then /resume ${sessionId}.`;
}

/**
 * The notice the loop guard posts when it stops bots. It starts "Loop guard: " because agents
 * read a line starting that way as the stop signal (agora-collab skill); keep that prefix.
 */
export function loopGuardNotice(scope: 'channel' | 'thread', limit: number): string {
    const what = scope === 'thread' ? 'bot replies in this thread' : 'bot messages';
    return `Loop guard: ${limit} consecutive ${what}. Human input required to continue. `
        + `This ${scope}'s limit is ${limit} in a row: a person's message or Continue resets the count, and Server settings → Bots raises it or turns it off.`;
}

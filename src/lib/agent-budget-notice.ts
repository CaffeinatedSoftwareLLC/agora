export interface ExhaustedBudget {
    sessionId: string;
    kind: 'wake' | 'token';
    used: number;
    limit: number;
}

export function budgetShelveNotice(profileName: string, sessionId: string, budget: ExhaustedBudget): string {
    const own = budget.sessionId === sessionId;
    const subject = own ? `Session for ${profileName}` : `Subtask session for ${profileName} (${sessionId})`;
    const whose = own ? 'its' : `the budget of its parent session ${budget.sessionId}`;
    const usage = `${budget.used.toLocaleString('en-US')} of ${budget.limit.toLocaleString('en-US')} ${budget.kind === 'wake' ? 'wakes' : 'tokens'}`;
    const reason = own ? `${whose} ${budget.kind} budget` : `${whose} (${budget.kind} budget)`;
    const fix = budget.kind === 'wake'
        ? 'Raise the wake budget in [Agent settings](/settings/agents)'
        : `Raise ${own ? 'the' : "the parent session's"} token budget in the session controls`;
    return `${subject} shelved: ${reason} is used up (${usage}). ${fix}, then /resume ${sessionId}.`;
}

/** A session shelved because its profile's API key is out of credit (agora-host `credit_exhausted`). */
export function creditShelveNotice(profileName: string, sessionId: string, apiKeyEnv: string | null): string {
    // OPENROUTER_API_KEY, or OPENROUTER_API_KEY_<NAME> for one key per agent
    const fix = apiKeyEnv?.startsWith('OPENROUTER_API_KEY')
        ? "its OpenRouter key is out of credit or has used up its credit limit. Raise the key's limit at https://openrouter.ai/settings/keys or wait for it to reset"
        : `its API key${apiKeyEnv ? ` (${apiKeyEnv})` : ''} is out of credit. Add credit to the key`;
    return `Session for ${profileName} shelved: ${fix}, then /resume ${sessionId}.`;
}

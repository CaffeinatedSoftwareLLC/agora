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

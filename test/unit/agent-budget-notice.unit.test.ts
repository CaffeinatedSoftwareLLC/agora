import { budgetShelveNotice } from '../../src/lib/agent-budget-notice';

it('identifies exhausted wakes and links to the setting that raises them', () => {
    const text = budgetShelveNotice('codex', 'S', { sessionId: 'S', kind: 'wake', used: 50, limit: 50 });
    expect(text).toContain('its wake budget is used up (50 of 50 wakes)');
    expect(text).toContain('[Agent settings](/settings/agents)');
    expect(text).toContain('/resume S');
    expect(text).not.toContain('token');
});

it('identifies token overspending with readable counts and session controls', () => {
    const text = budgetShelveNotice('claude', 'S', { sessionId: 'S', kind: 'token', used: 2100000, limit: 2000000 });
    expect(text).toContain('its token budget is used up (2,100,000 of 2,000,000 tokens)');
    expect(text).toContain('Raise the token budget in the session controls');
    expect(text).not.toContain('wake');
});

it('names a parent token budget instead of directing the owner to raise the child budget', () => {
    const text = budgetShelveNotice('builder', 'CHILD', { sessionId: 'PARENT', kind: 'token', used: 11000, limit: 10000 });
    expect(text).toContain('Subtask session for builder (CHILD)');
    expect(text).toContain('parent session PARENT (token budget) is used up (11,000 of 10,000 tokens)');
    expect(text).toContain("Raise the parent session's token budget");
});

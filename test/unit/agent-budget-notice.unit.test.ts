import { budgetShelveNotice, hopLimitOf, limitOf, limitStopSummary, loopGuardNotice } from '../../src/lib/agent-budget-notice';
import { runTimeoutNotice } from '../../src/lib/agent-runs';

it('a wake stop names the wake limit, its numbers and the setting that lifts it, and never mentions tokens', () => {
    const text = budgetShelveNotice('codex', 'S', { sessionId: 'S', kind: 'wake', used: 50, limit: 50 });
    expect(text).toContain('Session for codex shelved: its wake limit is used up (50 of 50 wakes)');
    expect(text).toContain('Raise or remove "Wakes per session" for codex in [Agent settings](/settings/agents)');
    expect(text).toContain('/resume S');
    expect(text).not.toContain('token');
});

it('a token stop names the token limit with readable counts, and never mentions wakes', () => {
    const text = budgetShelveNotice('claude', 'S', { sessionId: 'S', kind: 'token', used: 2100000, limit: 2000000 });
    expect(text).toContain('its token limit is used up (2,100,000 of 2,000,000 tokens)');
    expect(text).toContain('Raise or remove "Tokens per session" for claude in [Agent settings](/settings/agents)');
    expect(text).not.toContain('wake');
});

it("a parent's token limit is named as the parent's, with the parent's session", () => {
    const text = budgetShelveNotice('builder', 'CHILD', { sessionId: 'PARENT', kind: 'token', used: 11000, limit: 10000 });
    expect(text).toContain('Subtask session for builder (CHILD)');
    expect(text).toContain('the token limit of its parent session PARENT is used up (11,000 of 10,000 tokens)');
    expect(text).toContain(`"Tokens per session" for the parent's agent`);
    expect(text).toContain('/resume CHILD');
});

it("a session's own token limit points at the session controls, not at the agent's setting", () => {
    const own = budgetShelveNotice('claude', 'S', { sessionId: 'S', kind: 'token', used: 6, limit: 5, source: 'session' });
    expect(own).toBe("Session for claude shelved: its token limit is used up (6 of 5 tokens). That is this session's own token limit: "
        + "raise or clear it in its session controls (the agent's chip, or its task card), then /resume S.");
    const parent = budgetShelveNotice('builder', 'CHILD', { sessionId: 'PARENT', kind: 'token', used: 11000, limit: 10000, source: 'session' });
    expect(parent).toContain("That is the parent session's own token limit: raise or clear it in the parent's session controls");
    expect(limitStopSummary({ sessionId: 'S', kind: 'token', used: 6, limit: 5, source: 'session' }, 'S')).toBe("Token limit (that session's own) reached: 6 of 5 tokens.");
});

it('the one-line summary says which limit, whose and the numbers', () => {
    expect(limitStopSummary({ sessionId: 'S', kind: 'wake', used: 50, limit: 50 }, 'S')).toBe('Wake limit reached: 50 of 50 wakes.');
    expect(limitStopSummary({ sessionId: 'P', kind: 'token', used: 12, limit: 10 }, 'S')).toBe('Token limit of parent session P reached: 12 of 10 tokens.');
});

it('a run time stop names the limit and its setting; with no limit it names the old host that stopped it', () => {
    expect(runTimeoutNotice('diakrisis', 900)).toBe(`diakrisis's run was stopped by its run time limit (15-minute), and its last wake was dropped. `
        + 'Raise or remove "Time per run" for diakrisis in [Agent settings](/settings/agents), then send it again.');
    expect(runTimeoutNotice('diakrisis', 90)).toContain('(90-second)');
    expect(runTimeoutNotice('diakrisis', null)).toContain('stopped after 24 hours by its agora-host, which is older than this server');
});

it('the loop guard notice keeps the prefix agents read as the stop signal, and says how to lift it', () => {
    const channel = loopGuardNotice('channel', 4);
    expect(channel.startsWith('Loop guard: 4 consecutive bot messages. Human input required to continue.')).toBe(true);
    expect(channel).toContain("This channel's limit is 4 in a row");
    expect(channel).toContain('Server settings → Bots raises it or turns it off');
    expect(loopGuardNotice('thread', 2).startsWith('Loop guard: 2 consecutive bot replies in this thread. Human input required to continue.')).toBe(true);
});

it('null is "no limit"; a number of any size comes back as that number', () => {
    expect(limitOf(null)).toBeNull();
    expect(limitOf(undefined)).toBeNull();
    expect(limitOf('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(hopLimitOf(null)).toBeNull();
    expect(hopLimitOf(0)).toBeNull();
    expect(hopLimitOf('12')).toBe(12);
});

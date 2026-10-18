import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import { classifyCommandError, compactTokens, deriveChips, describeSession, NO_AUTHORITY, type AgentSession } from './agentSessions';

const s = (over: Partial<AgentSession>): AgentSession => ({
  id: 'S'.repeat(26), profile: 'codex', botUsername: 'codex', state: 'live', endReason: null,
  wakesUsed: 0, tokensUsed: 0, lastActiveAt: '2026-10-17T10:00:00Z', ...over,
});

describe('compactTokens', () => {
  it('shows branch @ sha in /sessions', () => {
    expect(describeSession(s({ branch: 'agora/codex/session', headSha: 'a'.repeat(40) }))).toContain('agora/codex/session @ aaaaaaaaaaaa');
  });
  it.each([
    [0, '0'], [950, '950'], [1000, '1k'], [1234, '1.2k'], [9999, '10k'], [14321, '14k'],
    [999_499, '999k'], [1_250_000, '1.3M'], [12_000_000, '12M'],
  ])('%d → %s', (n, out) => {
    expect(compactTokens(n)).toBe(out);
  });
});

describe('deriveChips', () => {
  it('puts working, then idle, then shelved, then ended', () => {
    const chips = deriveChips([
      s({ id: 'a', profile: 'ended-one', state: 'ended', lastActiveAt: '2026-10-17T12:00:00Z' }),
      s({ id: 'b', profile: 'shelf', state: 'shelved' }),
      s({ id: 'c', profile: 'idle', state: 'live', running: false }),
      s({ id: 'd', profile: 'busy', state: 'live', running: true, lastActiveAt: '2026-10-17T09:00:00Z' }),
    ]);
    expect(chips.map(c => [c.profile, c.state])).toEqual([
      ['busy', 'working'], ['idle', 'idle'], ['shelf', 'shelved'], ['ended-one', 'ended'],
    ]);
  });

  it('makes one chip per profile, standing for the live session over a newer shelved one', () => {
    const chips = deriveChips([
      s({ id: 'old', state: 'shelved', lastActiveAt: '2026-10-17T11:00:00Z' }),
      s({ id: 'live', state: 'live', lastActiveAt: '2026-10-17T10:00:00Z' }),
      s({ id: 'older', state: 'ended', lastActiveAt: '2026-10-16T10:00:00Z' }),
    ]);
    expect(chips).toHaveLength(1);
    expect(chips[0].session.id).toBe('live');
    expect(chips[0].state).toBe('idle');
    expect(chips[0].sessions.map(x => x.id)).toEqual(['old', 'live', 'older']);
  });

  it('without a live session, stands for the most recently active one', () => {
    const [chip] = deriveChips([
      s({ id: 'e', state: 'ended', lastActiveAt: '2026-10-17T09:00:00Z' }),
      s({ id: 'sh', state: 'shelved', lastActiveAt: '2026-10-17T10:00:00Z' }),
    ]);
    expect(chip.session.id).toBe('sh');
    expect(chip.state).toBe('shelved');
  });
});

describe('classifyCommandError', () => {
  it('asks on session_live for start and resume only', () => {
    const err = new ApiError(409, 'session_live');
    expect(classifyCommandError(err, 'start')).toEqual({ kind: 'live' });
    expect(classifyCommandError(err, 'resume')).toEqual({ kind: 'live' });
    expect(classifyCommandError(err, 'end')).toEqual({ kind: 'error', text: 'That agent already has a live session here.' });
  });

  it('explains 403s, known codes and unknown failures in sentences', () => {
    expect(classifyCommandError(new ApiError(403, 'whatever'), 'start')).toEqual({ kind: 'error', text: NO_AUTHORITY });
    expect(classifyCommandError(new ApiError(404, 'no_live_session'), 'end'))
      .toEqual({ kind: 'error', text: 'That agent has no live session here.' });
    expect(classifyCommandError(new Error('network'), 'start')).toEqual({ kind: 'error', text: 'Command failed (unknown_error).' });
  });
});

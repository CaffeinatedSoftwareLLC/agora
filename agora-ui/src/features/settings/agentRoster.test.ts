import { describe, expect, it } from 'vitest';
import { buildRoster, findRow, type RosterInput } from './agentRoster';
import { bot, box, host, input, model, profile, session } from './agentRoster.fixtures';

describe('buildRoster', () => {
  it('lists one row per agent whatever its kind, each with the kind a person would name', () => {
    const rows = buildRoster(input({
      bots: [bot('bot-cci', 'cci'), bot('bot-boxy', 'boxy'), bot('bot-qwen', 'qwen'), bot('bot-term', 'term'), bot('bot-assistant', 'assistant')],
      hosts: [host('h1'), host('hb', { kind: 'box' })],
      profiles: [profile('cci', 'h1'), profile('boxy', 'hb', { boxed: true })],
      boxes: [box('boxy')],
      modelAgents: [model('qwen')],
      assistantBotId: 'bot-assistant',
    }));
    expect(rows.map(r => [r.name, r.kind])).toEqual([
      ['assistant', 'assistant'], ['boxy', 'box'], ['cci', 'machine'], ['qwen', 'model'], ['term', 'terminal'],
    ]);
    // The box with its profile and its account is one row
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length);
    expect(rows.find(r => r.name === 'boxy')?.box?.id).toBe('box-boxy');
  });

  it('shows a box that has no profile yet, and finds it by its box key', () => {
    const rows = buildRoster(input({ boxes: [box('fresh')] }));
    expect(rows).toHaveLength(1);
    expect(findRow(rows, 'box-box-fresh')).toBe(rows[0]);
  });

  it('leaves deleted boxes out', () => {
    expect(buildRoster(input({ boxes: [box('gone', { desiredState: 'deleted' })] }))).toEqual([]);
  });

  it('builds rows without the account list when the viewer may not manage bots', () => {
    const rows = buildRoster(input({ bots: null, hosts: [host('h1')], profiles: [profile('cci', 'h1')] }));
    expect(rows.map(r => r.name)).toEqual(['cci']);
    expect(rows[0].bot).toBeNull();
  });
});

describe('agent state', () => {
  const one = (extra: Partial<RosterInput>) => buildRoster(input(extra))[0].state;

  it('says a stopped box is stopped and why', () => {
    const state = one({ boxes: [box('b', { state: 'stopped', desiredState: 'stopped' })] });
    expect(state).toMatchObject({ tone: 'stopped', label: 'Stopped', why: 'The box is stopped.' });
  });
  it('quotes why a box failed', () => {
    expect(one({ boxes: [box('b', { state: 'failed', lastError: 'image pull failed' })] }).why).toBe('The box failed: image pull failed');
  });
  it('says a subscription box needs its login before it can work', () => {
    expect(one({ boxes: [box('b', { auth: 'subscription', loginState: 'none' })] })).toMatchObject({ tone: 'attention', label: 'Needs login' });
  });
  it('says an agent whose host was revoked is stopped', () => {
    const state = one({ hosts: [host('h1', { revokedAt: '2026-11-01T00:00:00Z' })], profiles: [profile('cci', 'h1')] });
    expect(state).toMatchObject({ tone: 'stopped', label: 'Stopped', why: 'Its host was revoked, so nothing wakes it.' });
  });
  it('says an agent whose host never connected is waiting', () => {
    expect(one({ hosts: [host('h1', { lastSeenAt: null })], profiles: [profile('cci', 'h1')] }).label).toBe('Waiting for its host');
  });
  it('says a paused account is paused, with the reason', () => {
    const state = one({ bots: [bot('bot-t', 't', { pausedAt: '2026-11-01T00:00:00Z', pausedReason: 'spam' })] });
    expect(state).toMatchObject({ tone: 'stopped', label: 'Paused', why: 'Paused by an admin: spam' });
  });
  it('says a model agent that is switched off is stopped', () => {
    expect(one({ modelAgents: [model('q', { enabled: false })] })).toMatchObject({ label: 'Stopped', why: 'It is switched off in its settings.' });
  });
  it('shows working, idle and a terminal that is not connected', () => {
    const base = { hosts: [host('h1')], profiles: [profile('cci', 'h1')] };
    expect(one({ ...base, sessions: [session({ profile: 'cci', running: true })] }).label).toBe('Working');
    expect(one({ ...base, sessions: [session({ profile: 'cci' })] }).label).toBe('Idle');
    expect(one({ bots: [bot('bot-t', 't')] })).toMatchObject({ label: 'Not connected' });
  });
  it('names the limit that stopped a shelved session', () => {
    const state = one({
      hosts: [host('h1')], profiles: [profile('cci', 'h1')],
      sessions: [session({ profile: 'cci', state: 'shelved', endReason: 'budget', limitStop: { kind: 'wake', used: 50, limit: 50, sessionId: 's1' } })],
    });
    expect(state.label).toBe('Stopped');
    expect(state.why).toContain('wake limit');
    expect(state.why).toContain('50 of 50 wakes');
  });
});

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { threadWaiting, waitedFor } from './threadWaiting';
import { ThreadWaitingBanner } from './ThreadWaitingBanner';
import { useAgentPresenceStore } from '../../stores/agentPresenceStore';
import type { ProtocolInfo } from '../../lib/contracts/ws-events';

/** #327: the thread header says who the thread waits on, for what, and for how long. */

const msg = (id: string, protocol?: Partial<ProtocolInfo>, extra: Record<string, unknown> = {}) => ({
  id, createdAt: '2026-11-03T17:06:00.000Z', authorUsername: 'Claude',
  ...(protocol ? { protocol: { version: 1, mode: 'fix', ...protocol } as ProtocolInfo } : {}), ...extra,
});

afterEach(() => { cleanup(); useAgentPresenceStore.getState().clear(); vi.useRealTimers(); });

describe('threadWaiting', () => {
  it('follows the latest protocol message: a WAIT, a YIELD, or nobody after an outcome', () => {
    expect(threadWaiting([msg('1', { state: 'TURN', yieldTo: 'Codex' })]))
      .toEqual({ on: 'Codex', for: null, since: '2026-11-03T17:06:00.000Z', messageId: '1' });
    expect(threadWaiting([msg('1', { state: 'TURN', yieldTo: 'Codex' }), msg('2'), msg('3', { state: 'WAIT', waitingOn: 'Claude', waitingFor: 'builder commit' })]))
      .toEqual(expect.objectContaining({ on: 'Claude', for: 'builder commit', messageId: '3' }));
    expect(threadWaiting([msg('1', { state: 'WAIT' })])?.on).toBe('Claude');
    expect(threadWaiting([msg('1', { state: 'TURN', yieldTo: 'Codex' }), msg('2', { state: 'DONE' })])).toBeNull();
    expect(threadWaiting([msg('1', { state: 'TURN', yieldTo: 'Codex' }), msg('2', { state: 'DECIDE', decision: 'BLOCK' })])).toBeNull();
    expect(threadWaiting([msg('1', { state: 'CHECKPOINT' })])).toBeNull();
    // A deleted protocol message no longer counts
    expect(threadWaiting([msg('1', { state: 'TURN', yieldTo: 'Codex' }), msg('2', { state: 'DONE' }, { deletedAt: 'x' })])?.on).toBe('Codex');
  });

  it('formats the wait', () => {
    const since = '2026-11-03T17:06:00.000Z';
    expect(waitedFor(since, Date.parse('2026-11-03T17:58:59Z'))).toBe('52 min');
    expect(waitedFor(since, Date.parse('2026-11-03T20:11:00Z'))).toBe('3 h 5 min');
    expect(waitedFor(since, Date.parse('2026-11-03T18:06:00Z'))).toBe('1 h');
  });
});

describe('ThreadWaitingBanner', () => {
  it('shows who, for what, how long and the agent\'s presence, and keeps counting', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-03T17:58:00Z') });
    useAgentPresenceStore.getState().setAll([{ userId: 'B1', username: 'Claude', channelId: 'C1', status: 'offline', mode: null }]);
    render(<ThreadWaitingBanner channelId="C1" waiting={{ on: 'claude', for: 'builder commit', since: '2026-11-03T17:06:00.000Z', messageId: 'm' }} />);
    const banner = screen.getByRole('status', { name: 'Thread is waiting on claude' });
    expect(banner.textContent).toBe('Waiting onclaudefor: builder commit·52 min·offline');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(banner.textContent).toContain('53 min');
  });

  it('leaves presence out for an agent not connected through agora-mcp', () => {
    render(<ThreadWaitingBanner channelId="C1" waiting={{ on: 'Codex', for: null, since: new Date().toISOString(), messageId: 'm' }} />);
    expect(screen.getByRole('status').textContent).toBe('Waiting onCodex·0 min');
  });
});

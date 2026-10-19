import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import type { Message } from '../../stores/messageStore';
import { ToolApprovalCard } from './ToolApprovalCard';
import { decisionError, isSleeping, sessionState, deriveChips, type AgentSession } from './agentSessions';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const post = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async orig => ({ ...await orig<typeof import('../../lib/api')>(), api: { post: (...args: unknown[]) => post(...args) } }));

const card = (status: string): Message => ({
  id: 'M'.repeat(26), channelId: 'C'.repeat(26), content: 'codex was denied `Bash(gh:*)`.', authorId: null, authorUsername: null,
  createdAt: '2026-10-18T10:00:00Z', systemEvent: 'agent_tool_approval',
  systemData: { kind: 'agent_tool_approval', requestId: 'R'.repeat(26), profile: 'codex', tool: 'Bash(gh:*)', status },
} as unknown as Message);

beforeEach(() => { post.mockReset(); });

describe('tool approval card', () => {
  it('sends the decision for a pending request', async () => {
    post.mockResolvedValue({ id: 'R'.repeat(26), status: 'once' });
    render(<ToolApprovalCard message={card('pending')} />);
    expect(screen.getByText('Bash(gh:*)').tagName).toBe('CODE');
    fireEvent.click(screen.getByText('Approve once'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/channels/${'C'.repeat(26)}/agent-tool-requests/${'R'.repeat(26)}`, { decision: 'once' }));
    fireEvent.click(screen.getByText('Always allow'));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(expect.any(String), { decision: 'always' }));
  });

  it('shows why a decision failed', async () => {
    post.mockRejectedValue(new ApiError(403, 'Only the server owner can always allow a tool'));
    render(<ToolApprovalCard message={card('pending')} />);
    fireEvent.click(screen.getByText('Always allow'));
    expect((await screen.findByRole('alert')).textContent).toBe('Only the server owner can always allow a tool');
  });

  it('has no buttons once decided', () => {
    render(<ToolApprovalCard message={card('always')} />);
    expect(screen.getByText('ALWAYS ALLOWED')).toBeTruthy();
    expect(screen.queryByText('Approve once')).toBeNull();
  });

  it('maps server errors to sentences', () => {
    expect(decisionError(new ApiError(409, 'already_decided'))).toBe('Someone already answered this.');
    expect(decisionError(new ApiError(403, 'cannot_direct'))).toBe('Only the owner and directors can approve agent tools.');
    expect(decisionError(new Error('x'))).toBe('Request failed');
  });
});

describe('sleeping sessions', () => {
  const s = (over: Partial<AgentSession>): AgentSession => ({
    id: 'S'.repeat(26), profile: 'codex', botUsername: 'codex', state: 'live', endReason: null,
    wakesUsed: 0, tokensUsed: 0, lastActiveAt: '2026-10-17T10:00:00Z', ...over,
  });
  const now = Date.parse('2026-10-18T12:00:00Z');
  it('is sleeping only while live and before the reset', () => {
    expect(sessionState(s({ sleepingUntil: '2026-10-18T13:00:00Z' }), now)).toBe('sleeping');
    expect(sessionState(s({ sleepingUntil: '2026-10-18T11:00:00Z' }), now)).toBe('idle');
    expect(sessionState(s({ sleepingUntil: '2026-10-18T13:00:00Z', running: true }), now)).toBe('working');
    expect(isSleeping(s({ state: 'shelved', sleepingUntil: '2026-10-18T13:00:00Z' }), now)).toBe(false);
  });
  it('ranks a sleeping chip after live ones and before shelved', () => {
    const later = new Date(Date.now() + 3600_000).toISOString();
    const chips = deriveChips([
      s({ profile: 'a', state: 'shelved' }), s({ profile: 'b', sleepingUntil: later }), s({ profile: 'c' }),
    ]);
    expect(chips.map(c => `${c.profile}:${c.state}`)).toEqual(['c:idle', 'b:sleeping', 'a:shelved']);
  });
});

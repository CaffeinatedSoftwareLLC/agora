import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import type { Message } from '../../stores/messageStore';
import { RunApprovalCard, ToolApprovalCard } from './ToolApprovalCard';
import { authLabel, classifyCommandError, decisionError, describeSession, ERRORS, isSleeping, sessionState, deriveChips, type AgentSession } from './agentSessions';

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

  it('shows the whole command of a waiting step, however long, as plain text', () => {
    const long = `git log --format=${'x'.repeat(240)} && git push --force origin main <b>`;
    const msg = card('pending');
    msg.systemData = { ...(msg.systemData as object), live: true, detail: long, cwd: '/srv/work/tree' } as Message['systemData'];
    const { container } = render(<ToolApprovalCard message={msg} />);
    expect(screen.getByText('Full command')).toBeTruthy();
    expect(container.querySelector('pre')!.textContent).toBe(long);
    expect(container.querySelector('pre b')).toBeNull();
    expect(screen.getByText('/srv/work/tree').tagName).toBe('CODE');
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

describe('run approval card (provider terms)', () => {
  const run = (status: string): Message => ({
    id: 'M'.repeat(26), channelId: 'C'.repeat(26), content: 'gem wants to run for: "eryk: hi".', authorId: null, authorUsername: null,
    createdAt: '2026-10-19T10:00:00Z', systemEvent: 'agent_run_approval',
    systemData: { kind: 'agent_run_approval', approvalId: 'A'.repeat(26), profile: 'gem', status },
  } as unknown as Message);

  it('sends approve or deny for a pending run', async () => {
    post.mockResolvedValue({ id: 'A'.repeat(26), status: 'approved' });
    render(<RunApprovalCard message={run('pending')} />);
    expect(screen.getByText('Run request from gem')).toBeTruthy();
    fireEvent.click(screen.getByText('Approve run'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/channels/${'C'.repeat(26)}/agent-run-approvals/${'A'.repeat(26)}`, { decision: 'approve' }));
    fireEvent.click(screen.getByText('Deny'));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(expect.any(String), { decision: 'deny' }));
  });

  it('shows the outcome without buttons once decided, and why a decision failed', async () => {
    const { unmount } = render(<RunApprovalCard message={run('expired')} />);
    expect(screen.getByText('EXPIRED')).toBeTruthy();
    expect(screen.queryByText('Approve run')).toBeNull();
    unmount();
    post.mockRejectedValue(new ApiError(403, 'Only the server owner can approve agent runs'));
    render(<RunApprovalCard message={run('pending')} />);
    fireEvent.click(screen.getByText('Approve run'));
    expect((await screen.findByRole('alert')).textContent).toBe('Only the server owner can approve agent runs');
  });
});

describe('auth mode labels', () => {
  it('labels subscription and API-key agents, in /sessions too', () => {
    expect(authLabel('subscription')).toBe('subscription (owner only)');
    expect(authLabel('api_key', true)).toBe('API key, approval per run');
    expect(describeSession({ id: 'S'.repeat(26), profile: 'claude', botUsername: 'claude', state: 'live', endReason: null,
      wakesUsed: 1, tokensUsed: 10, lastActiveAt: '2026-10-19T10:00:00Z', authMode: 'subscription' })).toContain('subscription (owner only)');
    expect(classifyCommandError(new ApiError(403, 'subscription_owner_only'), 'start')).toEqual({ kind: 'error', text: ERRORS.subscription_owner_only });
  });
});

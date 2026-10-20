import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import type { Message } from '../../stores/messageStore';
import { HandoffCard, ThreadOwnerBadge } from './HandoffCard';
import { handoffStatus, useThreadOwner } from './handoffs';
import { isPlainNotice } from '../messages/systemNotices';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async orig => ({ ...await orig<typeof import('../../lib/api')>(), api: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) } }));

const C = 'C'.repeat(26), O = 'O'.repeat(26), SHA = 'a'.repeat(40);
const card = (status: string, extra: object = {}): Message => ({
  id: 'M'.repeat(26), channelId: C, threadId: 'T'.repeat(26), content: `[HANDOFF offer=${O} to=codex]\nclaude offers codex ownership of this thread's task.`,
  authorId: 'B'.repeat(26), authorUsername: 'claude', createdAt: '2026-10-20T10:00:00Z', systemEvent: 'agent_handoff',
  systemData: { kind: 'agent_handoff', offerId: O, status, from: 'claude', to: 'codex', branch: 'agora/claude/S', headSha: SHA,
    senderRunning: false, paths: ['src/'], expiresAt: new Date(Date.now() + 600_000).toISOString(), reason: null, ...extra },
} as unknown as Message);

beforeEach(() => { post.mockReset(); get.mockReset(); });

describe('handoff card', () => {
  it('shows a pending offer with its branch@sha and lets the owner or a director cancel it', async () => {
    post.mockResolvedValue({ offer: { status: 'cancelled' } });
    render(<HandoffCard message={card('pending')} />);
    expect(screen.getByText('Handoff: claude → codex')).toBeTruthy();
    expect(screen.getByText('PENDING')).toBeTruthy();
    expect(screen.getByText(`agora/claude/S @ ${SHA.slice(0, 12)}`)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel offer'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/channels/${C}/handoffs/${O}`, { action: 'cancel' }));
  });

  it.each([['accepted', 'ACCEPTED'], ['declined', 'DECLINED'], ['expired', 'EXPIRED'], ['cancelled', 'CANCELLED']])('renders %s without actions', (status, label) => {
    render(<HandoffCard message={card(status)} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('Cancel offer')).toBeNull();
  });

  it('reads a pending offer past its expiry as expired', () => {
    render(<HandoffCard message={card('pending', { expiresAt: new Date(Date.now() - 1000).toISOString() })} />);
    expect(screen.getByText('EXPIRED')).toBeTruthy();
    expect(screen.queryByText('Cancel offer')).toBeNull();
    expect(handoffStatus({ status: 'accepted', expiresAt: '2000-01-01T00:00:00Z' })).toBe('accepted');
  });

  it('notes a mid-turn sender and explains a refused cancel', async () => {
    post.mockRejectedValue(new ApiError(403, 'cannot_cancel'));
    render(<HandoffCard message={card('pending', { senderRunning: true })} />);
    expect(screen.getByText(/turn in progress not included/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel offer'));
    expect((await screen.findByRole('alert')).textContent).toContain('Only the agent that made the offer');
  });

  it('is a card, never folded into a run of plain notices', () => {
    expect(isPlainNotice({ id: 'x', systemEvent: 'agent_handoff' })).toBe(false);
  });
});

function Owner({ version }: { version: string }) {
  const owner = useThreadOwner(C, 'T'.repeat(26), version);
  return owner ? <ThreadOwnerBadge owner={owner} /> : <span>none</span>;
}

describe('thread owner', () => {
  it('shows the owner in the header and refetches when an offer changes state', async () => {
    get.mockResolvedValueOnce({ owner: null })
      .mockResolvedValueOnce({ owner: { username: 'codex', sessionState: 'live', from: 'claude', branch: 'agora/claude/S', headSha: SHA } });
    const view = render(<Owner version="m:pending" />);
    await screen.findByText('none');
    view.rerender(<Owner version="m:accepted" />);
    const badge = await screen.findByTestId('thread-owner');
    expect(badge.textContent).toBe('Owner: codex');
    expect(badge.getAttribute('title')).toContain(`handed off by claude @ agora/claude/S@${SHA.slice(0, 12)}`);
    expect(get).toHaveBeenCalledWith(`/channels/${C}/threads/${'T'.repeat(26)}/handoffs`);
  });

  it('marks an owner whose session ended', () => {
    render(<ThreadOwnerBadge owner={{ username: 'codex', sessionState: 'ended', from: null, branch: null, headSha: null }} />);
    expect(screen.getByTestId('thread-owner').textContent).toBe('Owner: codex (session ended)');
  });
});

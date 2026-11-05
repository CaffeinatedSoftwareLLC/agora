import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, ApiError } from '../../lib/api';
import type { Message } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { clearViewerAuthority } from '../agents/viewerAuthority';
import { MessageItem } from '../messages/MessageItem';
import { isPlainNotice } from '../messages/systemNotices';
import { isFoldableAgentUpdate } from '../messages/messageRuns';
import { EdgeRequestCard } from './EdgeRequestCard';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} }); });

const REQ = 'R'.repeat(26);
const card = (status: string, extra: Record<string, unknown> = {}): Message => ({
  id: 'M'.repeat(26), channelId: 'C'.repeat(26), authorId: null, authorUsername: null, createdAt: '2026-11-04T10:00:00Z',
  content: 'Box **builder** wants to push to `octo/app`.', systemEvent: 'box_edge_request',
  systemData: { requestId: REQ, boxId: 'B'.repeat(26), boxName: 'builder', kind: 'push', status,
    summary: 'push to `octo/app`: `feature` (none) → 1234567890', canAlways: true, ...extra },
} as unknown as Message);

const DIRECTORS = { directors: [
  { userId: 'owner', username: 'owner', bot: false, authority: 'owner' },
  { userId: 'dir', username: 'dir', bot: false, authority: 'director' },
] };
const viewAs = (id: string) => useAuthStore.setState({ user: { id } as never });
const buttons = () => screen.queryAllByRole('button').map(b => b.textContent);

let post: ReturnType<typeof vi.spyOn>;
let get: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clearViewerAuthority();
  viewAs('owner');
  get = vi.spyOn(api, 'get').mockResolvedValue(DIRECTORS as never);
  post = vi.spyOn(api, 'post').mockResolvedValue({ status: 'allowed' } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('edge request card', () => {
  it('shows the summary, status and the owner\'s three choices', async () => {
    render(<EdgeRequestCard message={card('pending')} />);
    expect(screen.getByText('Push request from builder')).toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.getByText('octo/app').tagName).toBe('CODE');
    await waitFor(() => expect(buttons()).toEqual(['Allow', 'Always allow from this box here', 'Deny']));
  });

  it.each([['allow', 'Allow'], ['always', 'Always allow from this box here'], ['deny', 'Deny']])('sends %s', async (decision, label) => {
    render(<EdgeRequestCard message={card('pending')} />);
    fireEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/box-edge-requests/${REQ}`, { decision }));
  });

  it('has no Always for a domain request', async () => {
    render(<EdgeRequestCard message={card('pending', { kind: 'domain', summary: 'reach `example.com`', canAlways: false })} />);
    expect(screen.getByText('Domain request from builder')).toBeInTheDocument();
    await waitFor(() => expect(buttons()).toEqual(['Allow', 'Deny']));
  });

  it('offers the wildcard the server picked on a domain card, and sends only the decision', async () => {
    render(<EdgeRequestCard message={card('pending', { kind: 'domain', summary: 'reach `sdmntprwestus.oaiusercontent.com`', canAlways: false, wildcard: '*.oaiusercontent.com' })} />);
    await waitFor(() => expect(buttons()).toEqual(['Allow', 'Allow *.oaiusercontent.com', 'Deny']));
    fireEvent.click(screen.getByRole('button', { name: 'Allow *.oaiusercontent.com' }));
    // The entry itself is never sent: the server recomputes it from the stored host
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/box-edge-requests/${REQ}`, { decision: 'wildcard' }));
  });

  it('has no wildcard button when the server offers none', async () => {
    render(<EdgeRequestCard message={card('pending', { kind: 'domain', summary: 'reach `example.com`', canAlways: false, wildcard: null })} />);
    await waitFor(() => expect(buttons()).toEqual(['Allow', 'Deny']));
  });

  it.each(['dir', 'member'])('shows no buttons to a non-owner (%s)', async who => {
    viewAs(who);
    render(<EdgeRequestCard message={card('pending')} />);
    expect(await screen.findByText('The server owner decides.')).toBeInTheDocument();
    expect(buttons()).toEqual([]);
  });

  it.each([['allowed', 'ALLOWED'], ['denied', 'DENIED'], ['expired', 'EXPIRED'], ['used', 'DONE'], ['unknown', 'OUTCOME UNKNOWN'], ['changed', 'DIFFERENT COMMIT']])(
    'has no buttons once %s', (status, label) => {
      render(<EdgeRequestCard message={card(status)} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(buttons()).toEqual([]);
      expect(get).not.toHaveBeenCalled();
    });

  it('shows why a decision failed', async () => {
    post.mockRejectedValue(new ApiError(409, 'already_decided'));
    render(<EdgeRequestCard message={card('pending')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone already answered this.');
  });

  it('is what MessageItem renders for box_edge_request, and re-renders on a MessageUpdate', async () => {
    const props = { isGrouped: false, isOwn: false, onEdit: vi.fn(), onDelete: vi.fn(), channelId: 'C'.repeat(26) };
    const { rerender } = render(<MessageItem message={card('pending')} {...props} />);
    expect(screen.getByTestId('edge-request-card')).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Allow' });
    // The server's MessageUpdate replaces systemData in the store; the row re-renders with it
    rerender(<MessageItem message={card('allowed')} {...props} />);
    expect(screen.getByText('ALLOWED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  it('stays a card, never folded while pending', () => {
    expect(isPlainNotice(card('pending'))).toBe(false);
    expect(isFoldableAgentUpdate(card('pending'))).toBe(false);
    expect(isFoldableAgentUpdate(card('used'))).toBe(true);
  });
});

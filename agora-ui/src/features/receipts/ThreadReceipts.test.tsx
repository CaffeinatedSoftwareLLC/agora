import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { useUIStore } from '../../stores/uiStore';
import { ThreadPanel } from '../messages/ThreadPanel';
import { MessageItem } from '../messages/MessageItem';
import { isPlainNotice } from '../messages/systemNotices';
import { clearViewerAuthority } from '../agents/viewerAuthority';
import { useReceiptStore } from './receiptStore';
import { CH, TH, ledger, receipt } from './receipts.fixtures';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
vi.mock('../agents/handoffs', () => ({ useThreadOwner: () => null }));
vi.mock('../voice/MicButton', () => ({ MicButton: () => null }));

const parent: Message = { id: TH, channelId: CH, content: 'Fix the upload race', authorId: 'u', authorUsername: 'owner', createdAt: '2026-11-25T09:00:00Z', replyCount: 2 };
let receipts = ledger();

beforeEach(() => {
  vi.restoreAllMocks();
  receipts = ledger();
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path.endsWith('/directors')) return { directors: [{ userId: 'me', authority: 'owner' }] } as never;
    if (path.endsWith('/receipts')) return { receipts } as never;
    return [] as never;
  });
  clearViewerAuthority();
  useReceiptStore.getState().reset();
  useAuthStore.setState({ user: { id: 'me', username: 'me' } as never });
  useMessageStore.setState({ byChannel: new Map([[CH, [parent]]]) });
  useThreadStore.getState().clear();
  useThreadStore.setState({ openThreadId: TH, openThreadChannelId: CH, repliesByThread: new Map([[TH, []]]) });
  useUIStore.setState({ activeOverlay: null, threadView: 'replies' });
});

it('shows a Receipts tab and the badge once the thread has receipts, and opens on replies', async () => {
  render(<ThreadPanel />);
  const tab = await screen.findByRole('tab', { name: /Receipts/ });
  expect(screen.getByRole('tab', { name: 'Replies' }).getAttribute('aria-selected')).toBe('true');
  expect(tab.getAttribute('aria-selected')).toBe('false');
  // One contradicted claim: the badge is on the tab and in the header
  expect(screen.getAllByTestId('receipt-badge')).toHaveLength(2);
  expect(screen.queryByTestId('receipts-panel')).toBeNull();

  fireEvent.click(tab);
  expect(await screen.findByTestId('receipts-panel')).toBeTruthy();
  expect(screen.queryByPlaceholderText('Reply...')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Replies' }));
  expect(screen.getByPlaceholderText('Reply...')).toBeTruthy();
});

it('adds nothing to a thread without receipts', async () => {
  receipts = [];
  render(<ThreadPanel />);
  await waitFor(() => expect(useReceiptStore.getState().byThread.get(TH)).toEqual([]));
  expect(screen.queryByRole('tab')).toBeNull();
  expect(screen.queryByTestId('receipt-badge')).toBeNull();
});

it('opens on the receipts when the link asked for them (a notification), and on replies when there are none', async () => {
  useUIStore.setState({ threadView: 'receipts' });
  render(<ThreadPanel />);
  expect(await screen.findByTestId('receipts-panel')).toBeTruthy();
});

it('falls back to the replies when a link asked for receipts and there are none', async () => {
  receipts = [];
  useUIStore.setState({ threadView: 'receipts' });
  render(<ThreadPanel />);
  await waitFor(() => expect(screen.getByPlaceholderText('Reply...')).toBeTruthy());
  expect(screen.queryByTestId('receipts-panel')).toBeNull();
});

it('a receipt that arrives live brings the tab with it, and an accept takes the badge away', async () => {
  receipts = [];
  render(<ThreadPanel />);
  await waitFor(() => expect(useReceiptStore.getState().byThread.get(TH)).toEqual([]));
  expect(screen.queryByRole('tab')).toBeNull();
  act(() => useReceiptStore.getState().applyUpdate({ channelId: CH, threadId: TH, receipt: receipt(1, { grade: 'contradicted', gradeReason: 'run_failed' }) }));
  // The thread was already loaded (empty), so the event patches it in place
  expect(await screen.findByRole('tab', { name: /Receipts/ })).toBeTruthy();
  expect(screen.getAllByTestId('receipt-badge').length).toBeGreaterThan(0);
  act(() => useReceiptStore.getState().applyUpdate({ channelId: CH, threadId: TH, receipt: receipt(1, { grade: 'contradicted', gradeReason: 'run_failed', updatedAt: '2026-11-25T12:00:00Z',
    verdict: { value: 'accepted', by: { id: 'me', username: 'me' }, note: null, at: '2026-11-25T12:00:00Z' } }) }));
  expect(screen.queryByTestId('receipt-badge')).toBeNull();
});

it('Show the message goes back to the replies', async () => {
  render(<ThreadPanel />);
  fireEvent.click(await screen.findByRole('tab', { name: /Receipts/ }));
  fireEvent.click((await screen.findAllByRole('button', { name: 'Show the message' }))[0]);
  expect(useUIStore.getState().threadView).toBe('replies');
  expect(screen.getByRole('tab', { name: 'Replies' }).getAttribute('aria-selected')).toBe('true');
});

it('renders a dispute as a card with the person\'s note, never folded into a run of notices', () => {
  const dispute = { id: 'D', channelId: CH, authorId: 'me', authorUsername: 'eryk', createdAt: '2026-11-25T11:00:00Z', systemEvent: 'receipt_verdict',
    content: 'Disputed: receipt R (claim, message M).\nReason: Still [broken](https://x.example).', systemData: { receiptKind: 'claim', verdict: 'disputed' } } as unknown as Message;
  expect(isPlainNotice(dispute)).toBe(false);
  render(<MessageItem message={dispute} isGrouped={false} isOwn onEdit={() => {}} onDelete={() => {}} channelId={CH} />);
  const card = screen.getByTestId('verdict-message');
  expect(card.textContent).toContain('eryk disputed a claim');
  expect(card.textContent).toContain('Still [broken](https://x.example).');
  expect(card.querySelector('a')).toBeNull();
});

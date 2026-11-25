import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { clearViewerAuthority } from '../agents/viewerAuthority';
import { ReceiptBadge } from './ReceiptBadge';
import { ReceiptsPanel } from './ReceiptsPanel';
import { useReceiptAttention, useReceiptStore } from './receiptStore';
import { CH, TH, ledger, receipt } from './receipts.fixtures';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async orig => ({
  ...await orig<typeof import('../../lib/api')>(),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  inBackground: <T,>(fn: () => Promise<T>) => fn(),
}));

const DIRECTORS = { directors: [{ userId: 'owner', authority: 'owner' }, { userId: 'dir', authority: 'director' }] };
let receipts = ledger();

function serve() {
  get.mockImplementation(async (path: string) => {
    if (path.endsWith('/directors')) return DIRECTORS;
    if (path.endsWith('/receipts')) return { receipts };
    throw new Error(`unexpected GET ${path}`);
  });
}
const viewAs = (id: string) => useAuthStore.setState({ user: { id } as never });
const cards = () => screen.getAllByTestId('receipt-card');
const mount = async (asJudge = true) => {
  render(<ReceiptsPanel channelId={CH} threadId={TH} />);
  await screen.findByTestId('receipts-summary');
  // The owner's and a director's buttons appear once the viewer's authority is known
  if (asJudge) await screen.findAllByRole('button', { name: /^Accept/ });
};

beforeEach(() => {
  get.mockReset(); post.mockReset();
  receipts = ledger();
  serve();
  clearViewerAuthority();
  useReceiptStore.getState().reset();
  viewAs('owner');
});

describe('receipts panel', () => {
  it('lists every receipt in order and leads with the summary line', async () => {
    await mount();
    expect(screen.getByTestId('receipts-summary').textContent).toBe('5 receipts: 1 contradicted, 5 waiting for a verdict');
    expect(cards().map(c => c.getAttribute('aria-label'))).toEqual([
      'Claim by codex', 'Claim by codex', 'Decision', 'Stop by codex', 'Claim by codex',
    ]);
  });

  it('says what the server graded and why, in plain words', async () => {
    await mount();
    const [verified, contradicted, , , unverified] = cards();
    expect(within(verified).getByText('Verified')).toBeTruthy();
    expect(within(verified).getByTestId('grade-reason').textContent).toContain("the owner's verify command (npm test) passed");
    expect(within(verified).getByTestId('grade-reason').textContent).toContain('a1b2c3d');
    expect(within(verified).getByTestId('run-ref').textContent).toContain('agora/codex/S at a1b2c3d, 2 files changed');
    expect(within(contradicted).getByText('Contradicted')).toBeTruthy();
    expect(within(contradicted).getByTestId('grade-reason').textContent).toContain('the run failed after this claim was posted');
    expect(within(unverified).getByText('Unverified')).toBeTruthy();
    expect(within(unverified).getByTestId('grade-reason').textContent).toContain('not from a hosted run');
  });

  it('shows a decision round with each vote and the dissent word for word', async () => {
    await mount();
    const round = cards()[2];
    expect(within(round).getByText('Blocked')).toBeTruthy();
    const votes = within(round).getByRole('list', { name: 'Votes' });
    expect(votes.textContent).toContain('claude (agent) agreed');
    expect(votes.textContent).toContain('codex (agent) blocked');
    expect(votes.textContent).toContain('Dissent: The cap is too high.');
  });

  it('renders author text as plain text: no link, no mention, no markup', async () => {
    await mount();
    const claim = cards()[1];
    expect(claim.textContent).toContain('All done, [click](https://evil.example) @everyone');
    expect(claim.querySelector('a')).toBeNull();
  });

  it('marks what the agent reported as unchecked and never as part of the grade', async () => {
    receipts = [receipt(1, { evidence: { run: null, selfReported: [{ sha: 'f'.repeat(40), tested: true, note: 'npm test: 412 passed' }] }, grade: 'unverified', gradeReason: 'no_run', basis: 'assumed' })];
    await mount();
    expect(screen.getByText(/not checked, never changes the grade/)).toBeTruthy();
    expect(screen.getByText(/commit fffffff, says tests passed/)).toBeTruthy();
  });

  it('shows gates with who passed them and a replaced one as replaced', async () => {
    receipts = [
      receipt(1, { kind: 'artifact', grade: null, gradeReason: null, basis: null, summary: 'plan.md', evidence: {} }),
      receipt(2, { kind: 'gate', grade: null, gradeReason: null, basis: null, outcome: 'rejected', summary: 'cap too high', isLatest: false, evidence: { authority: 'owner', byBot: false } }),
      receipt(3, { kind: 'gate', grade: null, gradeReason: null, basis: null, outcome: 'approved', summary: null, isLatest: true, evidence: { authority: 'director', byBot: true } }),
    ];
    await mount(false);
    const [file, rejected, approved] = cards();
    expect(file.textContent).toContain('plan.md');
    expect(within(rejected).getByText('Replaced')).toBeTruthy();
    expect(rejected.textContent).toContain('Passed by the owner.');
    expect(approved.textContent).toContain('Passed by an agent the owner lets direct.');
    // A file and a gate reply are not judged here
    expect(within(file).queryByRole('button', { name: /Accept/ })).toBeNull();
    expect(within(approved).queryByRole('button', { name: /Accept/ })).toBeNull();
  });

  it('shows nothing but a sentence when the thread has no receipts', async () => {
    receipts = [];
    render(<ReceiptsPanel channelId={CH} threadId={TH} />);
    expect(await screen.findByText(/Nothing has been claimed or decided/)).toBeTruthy();
    expect(screen.queryByTestId('receipt-card')).toBeNull();
  });

  it('says so when the receipts cannot be loaded, and retries', async () => {
    get.mockImplementation(async (path: string) => { if (path.endsWith('/directors')) return DIRECTORS; throw new ApiError(500, 'unknown_error'); });
    render(<ReceiptsPanel channelId={CH} threadId={TH} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load the receipts');
    serve();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('receipts-summary');
  });
});

describe('verdict card', () => {
  const claim = () => cards()[1];

  it('lets the owner accept, once, however many times the button is pressed', async () => {
    let finish!: (v: unknown) => void;
    post.mockImplementation(() => new Promise(r => { finish = r; }));
    await mount();
    const accept = within(claim()).getByRole('button', { name: /^Accept/ });
    fireEvent.click(accept);
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(`/channels/${CH}/receipts/${receipts[1].id}/verdict`, { verdict: 'accepted' });
    // Both buttons are off while it is on its way
    expect((within(claim()).getByRole('button', { name: /^Dispute/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish({ receipt: { ...receipts[1], updatedAt: '2026-11-25T11:00:00Z', verdict: { value: 'accepted', by: { id: 'owner', username: 'eryk' }, note: null, at: new Date().toISOString() } } }); });
    expect(within(claim()).getByTestId('verdict-state').textContent).toMatch(/Accepted by eryk, just now/);
    expect(within(claim()).queryByRole('button', { name: /^Accept:/ })).toBeNull();
  });

  it('needs a note to dispute, sends it, and says whether the agent was woken', async () => {
    post.mockResolvedValue({ receipt: { ...receipts[1], updatedAt: '2026-11-25T11:00:00Z', verdict: { value: 'disputed', by: { id: 'owner', username: 'eryk' }, note: 'Still broken.', at: new Date().toISOString() } },
      messageId: 'X', wake: { woke: true, sessionId: 'S' } });
    await mount();
    fireEvent.click(within(claim()).getByRole('button', { name: /^Dispute/ }));
    fireEvent.click(within(claim()).getByRole('button', { name: 'Send dispute' }));
    expect((await within(claim()).findByRole('alert')).textContent).toBe('Say why you dispute it. The agent reads your note.');
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(within(claim()).getByLabelText('Why do you dispute it?'), { target: { value: '  Still broken.  ' } });
    fireEvent.click(within(claim()).getByRole('button', { name: 'Send dispute' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/channels/${CH}/receipts/${receipts[1].id}/verdict`, { verdict: 'disputed', note: 'Still broken.' }));
    expect((await within(claim()).findByRole('status')).textContent).toBe('Disputed. The agent was woken with your note.');
    expect(within(claim()).getByTestId('verdict-state').textContent).toContain('Disputed by eryk');
    expect(within(claim()).getByTestId('verdict-state').textContent).toContain('Note: Still broken.');
    // The other way is still open
    expect(within(claim()).getByRole('button', { name: /^Accept instead/ })).toBeTruthy();
  });

  it.each([
    [new ApiError(403, 'cannot_direct'), /Only the owner and the people they allow to direct agents/],
    [new ApiError(403, 'people_only'), 'Only people can give a verdict, not agents.'],
    [new ApiError(404, 'receipt_not_found'), 'That receipt is gone. Reload the thread.'],
    [new ApiError(400, 'note_required'), 'Say why you dispute it. The agent reads your note.'],
    [new ApiError(500, 'unknown_error'), 'The server could not save the verdict. Try again.'],
    [new TypeError('Failed to fetch'), 'Could not reach the server. Try again.'],
  ])('explains a refusal in plain words (%#)', async (err, text) => {
    post.mockRejectedValue(err);
    await mount();
    fireEvent.click(within(claim()).getByRole('button', { name: /^Accept/ }));
    const alert = await within(claim()).findByRole('alert');
    if (typeof text === 'string') expect(alert.textContent).toBe(text); else expect(alert.textContent).toMatch(text);
    // And the buttons come back, so the owner can try again
    expect((within(claim()).getByRole('button', { name: /^Accept/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says why a dispute woke nobody', async () => {
    post.mockResolvedValue({ receipt: { ...receipts[1], updatedAt: '2026-11-25T11:00:00Z', verdict: { value: 'disputed', by: { id: 'owner', username: 'eryk' }, note: 'x', at: new Date().toISOString() } },
      messageId: 'X', wake: { woke: false, reason: 'plan_owner_only' } });
    await mount();
    fireEvent.click(within(claim()).getByRole('button', { name: /^Dispute/ }));
    fireEvent.change(within(claim()).getByLabelText('Why do you dispute it?'), { target: { value: 'x' } });
    fireEvent.click(within(claim()).getByRole('button', { name: 'Send dispute' }));
    expect((await within(claim()).findByRole('status')).textContent).toMatch(/wakes only for its plan owner/);
  });

  it('is read-only for a member: the state, never the buttons', async () => {
    viewAs('member');
    receipts[1] = { ...receipts[1], verdict: { value: 'disputed', by: { id: 'owner', username: 'eryk' }, note: 'Still broken.', at: new Date().toISOString() } };
    await mount(false);
    await within(cards()[0]).findByText(/The owner or a director can accept or dispute it/);
    expect(screen.queryByRole('button', { name: /^(Accept|Dispute)/ })).toBeNull();
    expect(within(cards()[0]).getByText(/The owner or a director can accept or dispute it/)).toBeTruthy();
    expect(within(cards()[1]).getByTestId('verdict-state').textContent).toContain('Disputed by eryk');
    expect(post).not.toHaveBeenCalled();
  });

  it('gives a director the buttons too', async () => {
    viewAs('dir');
    await mount();
    expect(within(claim()).getByRole('button', { name: /^Accept/ })).toBeTruthy();
  });
});

describe('real time', () => {
  it('a ReceiptUpdate adds a receipt and changes a card without a reload', async () => {
    await mount();
    expect(cards()).toHaveLength(5);
    act(() => useReceiptStore.getState().applyUpdate({ channelId: CH, threadId: TH, receipt: receipt(6, { grade: 'unverified', gradeReason: 'run_in_progress', basis: 'assumed', summary: 'Second try.' }) }));
    expect(cards()).toHaveLength(6);
    expect(within(cards()[5]).getByTestId('grade-reason').textContent).toContain('its run is still going');
    // The run ends: same receipt, newer
    act(() => useReceiptStore.getState().applyUpdate({ channelId: CH, threadId: TH, receipt: receipt(6, { updatedAt: '2026-11-25T10:30:00Z', summary: 'Second try.' }) }));
    expect(cards()).toHaveLength(6);
    expect(within(cards()[5]).getByText('Verified')).toBeTruthy();
    expect(get.mock.calls.filter(([p]) => String(p).endsWith('/receipts'))).toHaveLength(1);
  });

  it('an older copy never replaces a newer one', async () => {
    await mount();
    act(() => useReceiptStore.getState().applyUpdate({ channelId: CH, threadId: TH, receipt: receipt(1, { updatedAt: '2026-11-25T09:00:00Z', grade: 'contradicted', gradeReason: 'run_failed' }) }));
    expect(within(cards()[0]).getByText('Verified')).toBeTruthy();
  });

  it('a verdict made elsewhere shows up on the card', async () => {
    viewAs('member');
    await mount(false);
    act(() => useReceiptStore.getState().applyUpdate({ channelId: CH, threadId: TH, receipt: { ...receipts[0], updatedAt: '2026-11-25T11:00:00Z',
      verdict: { value: 'accepted', by: { id: 'owner', username: 'eryk' }, note: null, at: new Date().toISOString() } } }));
    expect(within(cards()[0]).getByTestId('verdict-state').textContent).toMatch(/Accepted by eryk/);
  });

  it('fetches a thread it has never loaded when an event arrives for it', async () => {
    const other = 'U'.repeat(26);
    get.mockImplementation(async () => ({ receipts: [receipt(7, { threadId: other })] }));
    act(() => useReceiptStore.getState().applyUpdate({ channelId: CH, threadId: other, receipt: receipt(7, { threadId: other }) }));
    await waitFor(() => expect(useReceiptStore.getState().byThread.get(other)).toHaveLength(1));
  });
});

describe('badge', () => {
  function Probe({ list }: { list?: number }) {
    return <ReceiptBadge count={useReceiptAttention(TH, list)} />;
  }

  it('shows nothing at zero, uses the thread list until receipts are loaded, then follows them', async () => {
    const { rerender } = render(<Probe list={0} />);
    expect(screen.queryByTestId('receipt-badge')).toBeNull();
    rerender(<Probe list={3} />);
    expect(screen.getByRole('img', { name: '3 receipts contradicted or disputed' })).toBeTruthy();
    await act(async () => { await useReceiptStore.getState().load(CH, TH); });
    // The ledger holds one contradicted claim nobody has accepted
    expect(screen.getByRole('img', { name: '1 receipt contradicted or disputed' })).toBeTruthy();
  });

  it('clears when the owner accepts the contradicted claim, and counts a dispute until it is accepted', async () => {
    render(<Probe />);
    await act(async () => { await useReceiptStore.getState().load(CH, TH); });
    expect(screen.getByTestId('receipt-badge')).toBeTruthy();
    const base = receipts[1];
    act(() => useReceiptStore.getState().applyUpdate({ channelId: CH, threadId: TH, receipt: { ...base, updatedAt: '2026-11-25T11:00:00Z', verdict: { value: 'disputed', by: { id: 'o', username: 'o' }, note: 'n', at: 'x' } } }));
    expect(screen.getByRole('img', { name: '1 receipt contradicted or disputed' })).toBeTruthy();
    act(() => useReceiptStore.getState().applyUpdate({ channelId: CH, threadId: TH, receipt: { ...base, updatedAt: '2026-11-25T11:01:00Z', verdict: { value: 'accepted', by: { id: 'o', username: 'o' }, note: null, at: 'x' } } }));
    expect(screen.queryByTestId('receipt-badge')).toBeNull();
  });

  it('does not count an unverified claim, a verified one, or a round', async () => {
    receipts = [receipt(1), receipt(2, { grade: 'unverified', gradeReason: 'no_run' }), ledger()[2], ledger()[3]];
    render(<Probe />);
    await act(async () => { await useReceiptStore.getState().load(CH, TH); });
    expect(screen.queryByTestId('receipt-badge')).toBeNull();
  });
});

import { useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { relativeTime } from '../../lib/relativeTime';
import type { Receipt } from '../../lib/contracts/receipts';
import type { ViewerAuthority } from '../agents/viewerAuthority';
import { useReceiptStore } from './receiptStore';
import { canJudge, verdictErrorText, wakeText } from './receiptText';

/**
 * The owner's verdict on a receipt: Accept, or Dispute with a note the agent reads.
 * Only the owner and the people they allow to direct agents may give one; everyone else sees the
 * state read-only. Hiding the buttons is a courtesy: the server refuses anyone else (403).
 * A second press while one is on its way does nothing.
 */

export function VerdictControls({ receipt, authority }: { receipt: Receipt; authority: ViewerAuthority }) {
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'accepted' | 'disputed' | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const sending = useRef(false);
  const noteId = useId();
  const errorId = useId();
  const v = receipt.verdict;
  // 'unknown' (the lookup failed) shows the buttons: the server decides, and says so in plain words.
  // While it loads nothing is offered, so a member never sees buttons flash up.
  const mayJudge = authority === 'owner' || authority === 'director' || authority === 'unknown';

  const submit = async (verdict: 'accepted' | 'disputed') => {
    if (sending.current) return;
    const text = note.trim();
    if (verdict === 'disputed' && !text) { setError('Say why you dispute it. The agent reads your note.'); return; }
    sending.current = true;
    setBusy(verdict);
    setError('');
    try {
      const result = await useReceiptStore.getState().giveVerdict(receipt.channelId, receipt.id, verdict, verdict === 'disputed' ? text : undefined);
      setDone(verdict === 'disputed' ? wakeText(result) ?? '' : '');
      setDisputing(false);
      setNote('');
    } catch (err) {
      setError(verdictErrorText(err));
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const decided = v && (
    <p className="text-[13px] text-text" data-testid="verdict-state">
      <span className="font-semibold">{v.value === 'accepted' ? 'Accepted' : 'Disputed'}</span>
      {' '}by {v.by?.username ?? 'someone whose account is gone'}, {relativeTime(v.at)}.
      {v.note && <span className="mt-1 block whitespace-pre-wrap break-words text-text-muted">Note: {v.note}</span>}
    </p>
  );

  if (!canJudge(receipt)) return decided || null;

  if (authority === 'loading') return decided || null;
  if (!mayJudge) {
    return decided || (
      <p className="text-[13px] text-text-muted">No verdict yet. The owner or a director can accept or dispute it.</p>
    );
  }

  const opposite = v?.value === 'accepted' ? 'disputed' : v?.value === 'disputed' ? 'accepted' : null;

  return (
    <div className="space-y-2">
      {decided || <p className="text-[13px] font-medium text-text">Waiting for your verdict.</p>}
      {done && <p role="status" className="text-[13px] text-text-muted">{done}</p>}

      {!disputing && (
        <div className="flex flex-wrap gap-2">
          {(opposite === null || opposite === 'accepted') && (
            <Button variant="secondary" disabled={busy !== null} loading={busy === 'accepted'} onClick={() => void submit('accepted')}
              aria-label={`${opposite ? 'Accept instead' : 'Accept'}: ${KIND_PHRASE[receipt.kind]}`}>
              {opposite ? 'Accept instead' : 'Accept'}
            </Button>
          )}
          {(opposite === null || opposite === 'disputed') && (
            <Button variant="danger" disabled={busy !== null} onClick={() => { setError(''); setDone(''); setDisputing(true); }}
              aria-label={`${opposite ? 'Dispute instead' : 'Dispute'}: ${KIND_PHRASE[receipt.kind]}`}>
              {opposite ? 'Dispute instead' : 'Dispute'}
            </Button>
          )}
        </div>
      )}

      {disputing && (
        <div className="space-y-2">
          <label htmlFor={noteId} className="block text-[13px] font-medium text-text">Why do you dispute it?</label>
          <textarea
            id={noteId}
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={1000}
            rows={3}
            autoFocus
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            placeholder="What is still wrong? The agent reads this."
            className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-[16px] text-text placeholder:text-text-muted/70 focus-visible:outline-2 focus-visible:outline-accent md:text-[14px]"
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={busy !== null} loading={busy === 'disputed'} onClick={() => void submit('disputed')}>Send dispute</Button>
            <Button variant="secondary" disabled={busy !== null} onClick={() => { setDisputing(false); setError(''); }}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <p id={errorId} role="alert" className="text-[13px] text-danger">{error}</p>}
    </div>
  );
}

const KIND_PHRASE: Record<Receipt['kind'], string> = {
  claim: 'this claim', decision: 'this decision', stop: 'this stop', artifact: 'this file', gate: 'this reply',
};

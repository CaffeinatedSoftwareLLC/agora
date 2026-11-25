import type { Message } from '../../stores/messageStore';
import { disputeNote } from './receiptText';

/**
 * A person's dispute of a receipt, posted in the thread by the server as their own message
 * (system event `receipt_verdict`). Shows who disputed what and their note, as plain text.
 * The receipt itself is never quoted: the message names it by ID only.
 */

const KIND: Record<string, string> = { claim: 'claim', decision: 'decision', stop: 'stop', artifact: 'file', gate: 'reply' };

export function VerdictMessage({ message }: { message: Message }) {
  const data = (message.systemData ?? {}) as { receiptKind?: string; verdict?: string };
  const kind = KIND[data.receiptKind ?? ''] ?? 'receipt';
  const note = disputeNote(message.content);
  return (
    <div className="mx-4 my-2 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3" data-testid="verdict-message" role="group" aria-label="Disputed receipt">
      <p className="text-[13px] font-semibold text-text">
        {message.authorUsername || 'Someone'} disputed a {kind}
      </p>
      {note && <p className="mt-1 whitespace-pre-wrap break-words text-[14px] text-text">{note}</p>}
      <p className="mt-1 text-[12px] text-text-muted">See the Receipts tab for the claim and its grade.</p>
    </div>
  );
}

import { ApiError } from '../../lib/api';
import type { Grade, Receipt, ReceiptKind, VerdictResult } from '../../lib/contracts/receipts';

/**
 * Plain words for the receipts ledger (docs/receipts.md). Everything here describes what Agora
 * holds; a receipt's own text (summary, vote reasons, file names) is the author's and is never
 * mixed into these sentences.
 */

export const KIND_LABEL: Record<ReceiptKind, string> = {
  claim: 'Claim', decision: 'Decision', stop: 'Stop', artifact: 'File', gate: 'Gate reply',
};

export const GRADE_LABEL: Record<Grade, string> = { verified: 'Verified', unverified: 'Unverified', contradicted: 'Contradicted' };

const sha7 = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null);

/**
 * Why Agora graded a claim as it did, in a sentence. "Verified" says a run finished and
 * committed (and, when tested, that the owner's verify command passed). It never says the work is right.
 */
export function gradeReasonText(r: Pick<Receipt, 'grade' | 'gradeReason' | 'basis' | 'evidence'>): string {
  const run = r.evidence?.run ?? null;
  const head = sha7(run?.headSha);
  const verify = run?.verification?.command ? ` (${run.verification.command})` : '';
  switch (r.gradeReason) {
    case 'tests_passed': return `Verified against its run: it finished, committed${head ? ` ${head}` : ''}, and the owner's verify command${verify} passed.`;
    case 'committed': return `Verified against its run: it finished and committed${head ? ` ${head}` : ''}. No verify command passed, so the tests are assumed.`;
    case 'verification_failed': return `Contradicted: the owner's verify command${verify} failed after this claim.`;
    case 'run_failed': return 'Contradicted: the run failed after this claim was posted.';
    case 'no_changes': return 'Contradicted: this fix claim came from a run that changed and committed nothing.';
    case 'no_run': return 'Unverified: not from a hosted run, so Agora has nothing to check it against.';
    case 'run_in_progress': return 'Unverified for now: its run is still going. This updates when the run ends.';
    case 'run_retrying': return 'Unverified for now: its run failed and will be tried again.';
    case 'other_thread': return 'Unverified: the run that posted this was working on another thread.';
    case 'no_commit': return 'Unverified: the run finished without a commit of its own.';
    case 'not_committed': return 'Unverified: the run changed files but did not commit them.';
    case 'run_interrupted': return 'Unverified: the run was stopped from outside (cancelled, expired or a limit), not by a failure.';
    default:
      return r.grade === 'verified' ? 'Verified against its run.' : r.grade === 'contradicted' ? 'Contradicted by what Agora holds about its run.' : 'Unverified: Agora could not check it.';
  }
}

export function outcomeLabel(outcome: string | null): string {
  return outcome ? outcome.charAt(0).toUpperCase() + outcome.slice(1) : '';
}

/** A receipt a person disputed, or a claim Agora found contradicted that nobody accepted. The server counts the same way (thread list `receiptAttention`). */
export function needsAttention(r: Pick<Receipt, 'grade' | 'verdict'>): boolean {
  return r.verdict?.value === 'disputed' || (r.grade === 'contradicted' && !r.verdict);
}

export function attentionCount(receipts: readonly Receipt[]): number {
  return receipts.reduce((n, r) => n + (needsAttention(r) ? 1 : 0), 0);
}

/** Kinds the owner or a director may accept or dispute here. A gate is already their own act; a file has its gate. */
export function canJudge(r: Pick<Receipt, 'kind' | 'verdict'>): boolean {
  return r.kind === 'claim' || r.kind === 'decision' || r.kind === 'stop';
}

export interface Tally { total: number; contradicted: number; disputed: number; awaiting: number }

export function tally(receipts: readonly Receipt[]): Tally {
  let contradicted = 0, disputed = 0, awaiting = 0;
  for (const r of receipts) {
    if (r.verdict?.value === 'disputed') disputed++;
    else if (r.kind === 'claim' && r.grade === 'contradicted' && !r.verdict) contradicted++;
    if (canJudge(r) && !r.verdict) awaiting++;
  }
  return { total: receipts.length, contradicted, disputed, awaiting };
}

const ERRORS: Record<string, string> = {
  people_only: 'Only people can give a verdict, not agents.',
  note_required: 'Say why you dispute it. The agent reads your note.',
  receipt_not_found: 'That receipt is gone. Reload the thread.',
  'Channel access denied': 'You can no longer see this channel.',
  not_found: 'That receipt is gone. Reload the thread.',
};

/** What a refused or failed verdict means, in a sentence. */
export function verdictErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (ERRORS[err.code]) return ERRORS[err.code];
    if (err.status === 403) return 'Only the owner and the people they allow to direct agents can accept or dispute a receipt.';
    if (err.status === 400) return 'The verdict was not accepted. Check the note and try again.';
    if (err.status === 429) return 'Too many requests. Wait a moment and try again.';
    if (err.status >= 500) return 'The server could not save the verdict. Try again.';
    return `The verdict was not saved (${err.code}).`;
  }
  return 'Could not reach the server. Try again.';
}

/** After a dispute: whether the agent was woken, and if not, why. */
export function wakeText(result: VerdictResult): string | null {
  const w = result.wake;
  if (!w) return null;
  if (w.woke) return 'Disputed. The agent was woken with your note.';
  switch (w.reason) {
    case 'already_disputed': return 'You already disputed this. Nothing new was sent.';
    case 'terminal_session': return 'Disputed. The agent is connected from a terminal and reads the thread itself.';
    case 'plan_owner_only': return 'Disputed. This agent runs on a personal plan and wakes only for its plan owner; your note is in the thread.';
    case 'no_live_session': return 'Disputed. The agent has no live session; your note is in the thread for when it returns.';
    case 'not_an_agent': return 'Disputed. The claim was not made by an agent, so nobody was woken.';
    default: return 'Disputed. Your note is in the thread.';
  }
}

export function receiptSummaryLine(receipts: readonly Receipt[]): string {
  const t = tally(receipts);
  const parts: string[] = [];
  if (t.contradicted) parts.push(`${t.contradicted} contradicted`);
  if (t.disputed) parts.push(`${t.disputed} disputed`);
  if (t.awaiting) parts.push(`${t.awaiting} waiting for a verdict`);
  return `${t.total} ${t.total === 1 ? 'receipt' : 'receipts'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/** The note in a dispute message is what follows "Reason:" in the server's text (src/routes/receipts.ts). */
export function disputeNote(content: string | null): string {
  const marker = '\nReason: ';
  const at = (content ?? '').indexOf(marker);
  return at >= 0 ? (content ?? '').slice(at + marker.length) : '';
}

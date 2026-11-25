import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import { attentionCount, disputeNote, gradeReasonText, needsAttention, tally, verdictErrorText, wakeText } from './receiptText';
import { ledger, receipt } from './receipts.fixtures';

describe('grade wording', () => {
  const reasons = ['tests_passed', 'committed', 'verification_failed', 'run_failed', 'no_changes', 'no_run', 'run_in_progress',
    'run_retrying', 'other_thread', 'no_commit', 'not_committed', 'run_interrupted'];

  it('has a sentence for every reason the server gives, starting with the grade', () => {
    for (const reason of reasons) {
      const text = gradeReasonText(receipt(1, { gradeReason: reason }));
      expect(text, reason).toMatch(/^(Verified|Unverified|Contradicted)/);
      expect(text, reason).not.toMatch(/correct|works|right/i);
    }
  });

  it('names the three cases the owner will meet most', () => {
    expect(gradeReasonText(receipt(1))).toMatch(/^Verified against its run/);
    expect(gradeReasonText(receipt(1, { gradeReason: 'no_run' }))).toBe('Unverified: not from a hosted run, so Agora has nothing to check it against.');
    expect(gradeReasonText(receipt(1, { gradeReason: 'run_failed' }))).toBe('Contradicted: the run failed after this claim was posted.');
  });

  it('falls back on the grade for a reason it does not know', () => {
    expect(gradeReasonText({ grade: 'contradicted', gradeReason: 'new_reason', basis: null, evidence: {} })).toMatch(/^Contradicted/);
    expect(gradeReasonText({ grade: null, gradeReason: null, basis: null, evidence: {} })).toMatch(/^Unverified/);
  });
});

describe('what needs a person', () => {
  it('counts contradicted claims nobody accepted and disputed claims, as the server does', () => {
    const who = { id: 'o', username: 'o' };
    expect(needsAttention(receipt(1, { grade: 'contradicted' }))).toBe(true);
    expect(needsAttention(receipt(1, { grade: 'contradicted', verdict: { value: 'accepted', by: who, note: null, at: 'x' } }))).toBe(false);
    expect(needsAttention(receipt(1, { grade: 'contradicted', verdict: { value: 'disputed', by: who, note: 'n', at: 'x' } }))).toBe(true);
    expect(needsAttention(receipt(1, { grade: 'unverified', verdict: { value: 'disputed', by: who, note: 'n', at: 'x' } }))).toBe(true);
    expect(needsAttention(receipt(1, { grade: 'verified' }))).toBe(false);
    expect(needsAttention(receipt(1, { kind: 'decision', grade: null, outcome: 'blocked' }))).toBe(false);
    // A dispute counts whatever the receipt is
    expect(needsAttention(receipt(1, { kind: 'decision', grade: null, outcome: 'blocked', verdict: { value: 'disputed', by: who, note: 'n', at: 'x' } }))).toBe(true);
    expect(attentionCount(ledger())).toBe(1);
  });

  it('tallies the ledger', () => {
    expect(tally(ledger())).toEqual({ total: 5, contradicted: 1, disputed: 0, awaiting: 5 });
  });
});

describe('refusals', () => {
  it('reads the server codes in plain words', () => {
    expect(verdictErrorText(new ApiError(403, 'cannot_direct'))).toMatch(/Only the owner/);
    expect(verdictErrorText(new ApiError(403, 'people_only'))).toBe('Only people can give a verdict, not agents.');
    expect(verdictErrorText(new ApiError(404, 'receipt_not_found'))).toMatch(/gone/);
    expect(verdictErrorText(new ApiError(418, 'teapot'))).toBe('The verdict was not saved (teapot).');
    expect(verdictErrorText(new Error('x'))).toBe('Could not reach the server. Try again.');
  });

  it('says what a dispute did', () => {
    expect(wakeText({ receipt: receipt(1), wake: { woke: true } })).toMatch(/woken/);
    expect(wakeText({ receipt: receipt(1), wake: { woke: false, reason: 'already_disputed' } })).toMatch(/already disputed/);
    expect(wakeText({ receipt: receipt(1), wake: { woke: false, reason: 'terminal_session' } })).toMatch(/terminal/);
    expect(wakeText({ receipt: receipt(1) })).toBeNull();
  });
});

describe('the dispute message', () => {
  it('takes the note after the reason line', () => {
    expect(disputeNote('Disputed: receipt R (claim, message M).\nReason: Still broken.\nSecond line.')).toBe('Still broken.\nSecond line.');
    expect(disputeNote(null)).toBe('');
  });
});

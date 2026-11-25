import type { Receipt } from '../../lib/contracts/receipts';

export const CH = 'C'.repeat(26);
export const TH = 'T'.repeat(26);
const ULID = (n: number) => `01${String(n).padStart(2, '0')}`.padEnd(26, 'A');
export const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

export function receipt(n: number, over: Partial<Receipt> = {}): Receipt {
  return {
    id: ULID(n), channelId: CH, threadId: TH, kind: 'claim', messageId: `M${n}`.padEnd(26, 'M'),
    author: { id: 'B'.repeat(26), username: 'codex', bot: true }, mode: 'fix', summary: 'Fixed the upload race.',
    grade: 'verified', gradeReason: 'tests_passed', basis: 'tested', outcome: null,
    sessionId: 'S'.repeat(26), runId: 'R'.repeat(26), fileId: null, refReceiptId: null,
    evidence: { run: { status: 'succeeded', branch: 'agora/codex/S', baseSha: 'b'.repeat(40), headSha: SHA, changedPathCount: 2,
      verification: { command: 'npm test', status: 'passed' } }, selfReported: [] },
    history: [], isLatest: null, supersededBy: null, sourceState: null, verdict: null, votes: [],
    createdAt: `2026-11-25T10:0${n}:00Z`, updatedAt: `2026-11-25T10:0${n}:00Z`, ...over,
  };
}

/** The ledger the screens are built for: verified, contradicted, a round with dissent, a stop, one awaiting a verdict. */
export function ledger(): Receipt[] {
  return [
    receipt(1),
    receipt(2, { grade: 'contradicted', gradeReason: 'run_failed', basis: 'assumed', summary: 'All done, [click](https://evil.example) @everyone' }),
    receipt(3, { kind: 'decision', author: null, mode: null, grade: null, gradeReason: null, basis: null, summary: null, outcome: 'blocked', evidence: {},
      votes: [
        { voterId: 'U1', username: 'claude', bot: true, vote: 'agree', reason: null, messageId: null, votedAt: '2026-11-25T10:03:00Z', sourceState: null },
        { voterId: 'U2', username: 'codex', bot: true, vote: 'block', reason: 'The cap is too high.', messageId: null, votedAt: '2026-11-25T10:03:30Z', sourceState: null },
      ] }),
    receipt(4, { kind: 'stop', mode: null, grade: null, gradeReason: null, basis: null, outcome: 'blocked', summary: 'Waiting on the API key.', evidence: {} }),
    receipt(5, { grade: 'unverified', gradeReason: 'no_run', basis: 'assumed', summary: 'Docs updated.', evidence: {} }),
  ];
}

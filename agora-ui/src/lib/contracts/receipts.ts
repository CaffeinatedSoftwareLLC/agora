/** The receipts ledger as the API returns it (src/lib/receipts.ts `receiptJson`, docs/receipts.md). */

export type ReceiptKind = 'claim' | 'decision' | 'stop' | 'artifact' | 'gate';
export type Grade = 'verified' | 'unverified' | 'contradicted';
export type VerdictValue = 'accepted' | 'disputed';

export interface ReceiptVote {
  voterId: string | null;
  username: string | null;
  bot: boolean;
  vote: 'agree' | 'block';
  /** The voter's own words. */
  reason: string | null;
  messageId: string | null;
  votedAt: string;
  sourceState: 'source_edited' | 'source_removed' | null;
}

export interface ReceiptRunEvidence {
  id?: string;
  status?: string;
  branch?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  changedPaths?: string[];
  changedPathCount?: number;
  verification?: { command?: string | null; status?: string; attempts?: number; exitCode?: number | null; reason?: string | null } | null;
  checkpoint?: unknown;
  finishedAt?: string | null;
}

export interface SelfReport { sha?: string; paths?: string[]; tested?: boolean; note?: string; by?: string; at?: string }

export interface Receipt {
  id: string;
  channelId: string;
  threadId: string;
  kind: ReceiptKind;
  messageId: string | null;
  author: { id: string; username: string | null; bot: boolean } | null;
  mode: string | null;
  /** The author's own words: show as plain text, never as markdown. */
  summary: string | null;
  grade: Grade | null;
  gradeReason: string | null;
  basis: 'tested' | 'assumed' | null;
  outcome: string | null;
  sessionId: string | null;
  runId: string | null;
  fileId: string | null;
  refReceiptId: string | null;
  evidence: { run?: ReceiptRunEvidence | null; selfReported?: SelfReport[]; authority?: string; byBot?: boolean; expectedVoters?: unknown; [k: string]: unknown };
  history: unknown[];
  isLatest: boolean | null;
  supersededBy: string | null;
  sourceState: 'source_edited' | 'source_removed' | null;
  verdict: { value: VerdictValue; by: { id: string; username: string | null } | null; note: string | null; at: string } | null;
  votes: ReceiptVote[];
  createdAt: string;
  updatedAt: string;
}

/** ReceiptUpdate socket event: a receipt was written or changed. */
export interface ReceiptUpdatePayload { channelId: string; threadId: string; receipt: Receipt }

export interface VerdictResult {
  receipt: Receipt;
  messageId?: string | null;
  wake?: { woke: boolean; sessionId?: string; reason?: 'no_live_session' | 'terminal_session' | 'plan_owner_only' | 'not_an_agent' | 'already_disputed' };
}

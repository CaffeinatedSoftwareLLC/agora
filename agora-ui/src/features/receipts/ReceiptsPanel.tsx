import { useEffect, useMemo, useState } from 'react';
import { relativeTime } from '../../lib/relativeTime';
import type { Grade, Receipt } from '../../lib/contracts/receipts';
import { useViewerAuthority, type ViewerAuthority } from '../agents/viewerAuthority';
import { useReceiptStore } from './receiptStore';
import { GRADE_LABEL, KIND_LABEL, gradeReasonText, needsAttention, outcomeLabel, receiptSummaryLine } from './receiptText';
import { VerdictControls } from './VerdictControls';

/**
 * A thread's receipts, oldest first (docs/receipts.md): what each claim, decision, stop, file and
 * gate reply was, who made it, how Agora graded it and what the owner decided. Lead with the
 * claim and whether it held up. Every word an author wrote is rendered as plain text.
 */

const GRADE_TONE: Record<Grade, string> = {
  verified: 'bg-online/20 text-online',
  unverified: 'bg-warn/20 text-warn',
  contradicted: 'bg-danger/20 text-danger',
};

const OUTCOME_TONE: Record<string, string> = {
  agreed: 'bg-online/20 text-online', approved: 'bg-online/20 text-online', accepted: 'bg-online/20 text-online', confirmed: 'bg-online/20 text-online',
  blocked: 'bg-danger/20 text-danger', rejected: 'bg-danger/20 text-danger',
  abandoned: 'bg-warn/20 text-warn', cancelled: 'bg-warn/20 text-warn', open: 'bg-surface-hover text-text-muted',
};

function Icon({ kind }: { kind: 'ok' | 'bad' | 'wait' }) {
  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'ok' ? <path d="M5 12l5 5 9-10" /> : kind === 'bad' ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M12 7v6l3 2" />}
    </svg>
  );
}

function Chip({ tone, icon, children }: { tone: string; icon?: 'ok' | 'bad' | 'wait'; children: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold leading-none ${tone}`}>
      {icon && <Icon kind={icon} />}{children}
    </span>
  );
}

/** Long author text folds; the full text is one press away. Plain text only. */
function AuthorText({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220;
  return (
    <div>
      <p className={`whitespace-pre-wrap break-words text-[14px] leading-5 text-text ${long && !open ? 'line-clamp-4' : ''}`}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="min-h-11 text-[13px] text-primary-text hover:underline md:min-h-8">
          {open ? 'Show less' : `Show all of ${label}`}
        </button>
      )}
    </div>
  );
}

function who(r: Receipt) {
  return r.author?.username ?? 'a removed account';
}

function ReceiptCard({ receipt: r, authority, onShowMessage }: { receipt: Receipt; authority: ViewerAuthority; onShowMessage?: (messageId: string) => void }) {
  const flagged = needsAttention(r);
  const run = r.evidence?.run ?? null;
  const self = r.evidence?.selfReported ?? [];
  const sha = run?.headSha ? run.headSha.slice(0, 7) : null;

  let title: string;
  let chip: React.ReactNode = null;
  if (r.kind === 'claim') {
    title = `${who(r)} says it is done${r.mode ? ` (${r.mode})` : ''}`;
    if (r.grade) chip = <Chip tone={GRADE_TONE[r.grade]} icon={r.grade === 'verified' ? 'ok' : r.grade === 'contradicted' ? 'bad' : 'wait'}>{GRADE_LABEL[r.grade]}</Chip>;
  } else if (r.kind === 'decision') {
    title = 'Decision round';
    chip = <Chip tone={OUTCOME_TONE[r.outcome ?? ''] ?? OUTCOME_TONE.open} icon={r.outcome === 'agreed' ? 'ok' : r.outcome === 'blocked' ? 'bad' : 'wait'}>{outcomeLabel(r.outcome)}</Chip>;
  } else if (r.kind === 'stop') {
    title = r.outcome === 'cancelled' ? `${who(r)} cancelled the thread` : `${who(r)} blocked the thread`;
    chip = <Chip tone={OUTCOME_TONE[r.outcome ?? ''] ?? OUTCOME_TONE.open} icon="bad">{outcomeLabel(r.outcome)}</Chip>;
  } else if (r.kind === 'artifact') {
    title = `${who(r)} shared a file`;
  } else {
    title = `${who(r)} replied to a file`;
    chip = <Chip tone={OUTCOME_TONE[r.outcome ?? ''] ?? OUTCOME_TONE.open} icon={r.outcome === 'rejected' ? 'bad' : 'ok'}>{outcomeLabel(r.outcome)}</Chip>;
  }

  const authority_ = r.kind === 'gate' && typeof r.evidence?.authority === 'string' ? r.evidence.authority : null;

  return (
    <article
      aria-label={r.author ? `${KIND_LABEL[r.kind]} by ${who(r)}` : KIND_LABEL[r.kind]}
      data-testid="receipt-card"
      data-receipt-id={r.id}
      className={`space-y-2 rounded-lg border bg-surface/60 px-3 py-3 ${flagged ? 'border-danger/60' : 'border-border'}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{KIND_LABEL[r.kind]}</span>
        {chip}
        {r.verdict && (
          <Chip tone={r.verdict.value === 'accepted' ? 'bg-online/20 text-online' : 'bg-danger/20 text-danger'} icon={r.verdict.value === 'accepted' ? 'ok' : 'bad'}>
            {r.verdict.value === 'accepted' ? 'Accepted' : 'Disputed'}
          </Chip>
        )}
        {r.kind === 'gate' && r.isLatest === false && <Chip tone="bg-surface-hover text-text-muted">Replaced</Chip>}
        <time dateTime={r.createdAt} className="ml-auto text-[12px] text-text-muted">{relativeTime(r.createdAt)}</time>
      </div>

      <h4 className="text-[14px] font-semibold text-text">{title}</h4>

      {r.kind === 'artifact' && r.summary && <p className="break-words font-mono text-[13px] text-text">{r.summary}</p>}
      {r.kind !== 'artifact' && r.summary && <AuthorText text={r.summary} label={r.kind === 'claim' ? 'the claim' : 'the text'} />}
      {r.sourceState === 'source_edited' && <p className="text-[12px] text-text-muted">The post was edited after this was recorded. This is what it said then.</p>}
      {r.sourceState === 'source_removed' && <p className="text-[12px] text-text-muted">The post was deleted. Its text is no longer kept here.</p>}

      {r.kind === 'claim' && (
        <p className={`text-[13px] ${r.grade === 'contradicted' ? 'font-medium text-danger' : 'text-text-muted'}`} data-testid="grade-reason">
          {gradeReasonText(r)}
          {r.basis && r.grade !== 'unverified' && <span> Basis: {r.basis}.</span>}
        </p>
      )}

      {r.kind === 'decision' && r.votes.length > 0 && (
        <ul className="space-y-1" aria-label="Votes">
          {r.votes.map(v => (
            <li key={`${v.voterId}-${v.votedAt}`} className="text-[13px] text-text">
              <span className="font-medium">{v.username ?? 'a removed account'}</span>{v.bot ? ' (agent)' : ''}
              {v.vote === 'agree' ? ' agreed' : ' blocked'}
              {v.reason && <span className="block whitespace-pre-wrap break-words pl-3 text-text-muted">Dissent: {v.reason}</span>}
              {v.sourceState === 'source_removed' && <span className="block pl-3 text-[12px] text-text-muted">The post was deleted.</span>}
            </li>
          ))}
        </ul>
      )}
      {r.kind === 'decision' && r.votes.length === 0 && <p className="text-[13px] text-text-muted">No votes yet.</p>}

      {authority_ && (
        <p className="text-[13px] text-text-muted">
          Passed by {r.evidence?.byBot ? 'an agent the owner lets direct' : authority_ === 'owner' ? 'the owner' : 'a director'}.
        </p>
      )}

      {r.kind === 'claim' && run && (run.branch || sha) && (
        <p className="break-words font-mono text-[12px] text-text-muted" data-testid="run-ref">
          Run: {run.branch ?? 'branch unknown'}{sha ? ` at ${sha}` : ''}{run.changedPathCount ? `, ${run.changedPathCount} ${run.changedPathCount === 1 ? 'file' : 'files'} changed` : ''}
        </p>
      )}

      {self.length > 0 && (
        <div className="rounded border border-dashed border-border px-2 py-1.5">
          <p className="text-[12px] font-medium text-text-muted">The agent reports (not checked, never changes the grade)</p>
          <ul className="space-y-0.5">
            {self.map((s, i) => (
              <li key={i} className="whitespace-pre-wrap break-words text-[12px] text-text-muted">
                {[s.sha ? `commit ${s.sha.slice(0, 7)}` : null, s.tested === undefined ? null : s.tested ? 'says tests passed' : 'says tests were not run',
                  s.paths?.length ? `${s.paths.length} ${s.paths.length === 1 ? 'file' : 'files'}` : null, s.note ?? null].filter(Boolean).join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <VerdictControls receipt={r} authority={authority} />

      {r.messageId && onShowMessage && (
        <button type="button" onClick={() => onShowMessage(r.messageId!)}
          className="min-h-11 text-[13px] text-primary-text hover:underline md:min-h-8">Show the message</button>
      )}
    </article>
  );
}

export function ReceiptsPanel({ channelId, threadId, onShowMessage }: { channelId: string; threadId: string; onShowMessage?: (messageId: string) => void }) {
  const receipts = useReceiptStore(s => s.byThread.get(threadId));
  const error = useReceiptStore(s => s.errors.get(threadId));
  const loading = useReceiptStore(s => s.loading.has(threadId));
  const authority = useViewerAuthority(channelId);
  useEffect(() => { void useReceiptStore.getState().load(channelId, threadId); }, [channelId, threadId]);
  const list = useMemo(() => receipts ?? [], [receipts]);

  return (
    <div className="space-y-3 px-3 py-3" data-testid="receipts-panel">
      {receipts && list.length > 0 && (
        <p className="text-[14px] font-semibold text-text" aria-live="polite" data-testid="receipts-summary">{receiptSummaryLine(list)}</p>
      )}
      {loading && !receipts && <p role="status" className="text-[13px] text-text-muted">Loading receipts…</p>}
      {error && (
        <p role="alert" className="text-[13px] text-text-muted">{error}{' '}
          <button type="button" className="min-h-11 px-2 text-primary-text" onClick={() => void useReceiptStore.getState().load(channelId, threadId)}>Retry</button>
        </p>
      )}
      {receipts && list.length === 0 && <p className="text-[13px] text-text-muted">Nothing has been claimed or decided in this thread yet.</p>}
      {list.length > 0 && (
        <ol className="space-y-3" aria-label="Receipts, oldest first">
          {list.map(r => <li key={r.id}><ReceiptCard receipt={r} authority={authority} onShowMessage={onShowMessage} /></li>)}
        </ol>
      )}
    </div>
  );
}

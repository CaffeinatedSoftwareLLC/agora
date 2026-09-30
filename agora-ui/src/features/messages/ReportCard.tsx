import { useState } from 'react';
import type { Message } from '../../stores/messageStore';
import { MessageContent } from './MessageContent';
import { FileAttachment } from './FileAttachment';

interface Counts { passed: number; failed: number; skipped: number; durationMs?: number }
interface ReportData {
  title?: string;
  summary?: string | null;
  summarySource?: 'model' | 'computed' | null;
  totals?: Counts;
  suites?: (Counts & { name: string })[];
  failures?: { name: string; suite?: string; message: string }[];
}

const SUITES_SHOWN = 8;

function duration(ms?: number): string {
  if (ms === undefined || ms === null) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** Proportional passed / failed / skipped bar. */
function StackedBar({ counts, className = 'h-2.5' }: { counts: Counts; className?: string }) {
  const total = counts.passed + counts.failed + counts.skipped;
  // Any non-zero segment stays visible (3 failures in 2,000 tests shouldn't vanish)
  const seg = (n: number) => ({ width: total ? `${(n / total) * 100}%` : '0%', minWidth: n > 0 ? 4 : 0 });
  return (
    <div
      className={`flex w-full overflow-hidden rounded-full bg-surface-hover ${className}`}
      role="img"
      aria-label={`${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`}
    >
      <div className="bg-online shrink" style={seg(counts.passed)} />
      <div className="bg-danger shrink-0" style={seg(counts.failed)} />
      <div className="bg-warn/70 shrink-0" style={seg(counts.skipped)} />
    </div>
  );
}

/**
 * Results card for a test run (WBS 4.1), drawn from the validated data a run posted
 * through the capability gateway. The full report is the attached Markdown file.
 */
export function ReportCard({ message }: { message: Message }) {
  const data = (message.systemData ?? {}) as ReportData;
  const totals = data.totals ?? { passed: 0, failed: 0, skipped: 0 };
  const suites = data.suites ?? [];
  const failures = data.failures ?? [];
  const total = totals.passed + totals.failed + totals.skipped;
  const passRate = total ? Math.round((totals.passed / total) * 1000) / 10 : 0;
  const failed = totals.failed > 0;
  const [allSuites, setAllSuites] = useState(false);
  const shownSuites = allSuites ? suites : suites.slice(0, SUITES_SHOWN);

  return (
    <div className="mx-4 my-2 rounded-lg border border-border bg-surface/60 px-4 py-3">
      <div className="flex items-center gap-2 mb-2 min-w-0">
        <svg className="h-4 w-4 text-accent shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
        </svg>
        <span className="text-sm font-semibold text-text truncate">{data.title || 'Test report'}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none shrink-0 ${failed ? 'bg-danger/20 text-danger' : 'bg-online/20 text-online'}`}>
          {failed ? 'FAILED' : 'PASSED'}
        </span>
        {message.authorUsername && <span className="ml-auto text-xs text-text-dim shrink-0">by {message.authorUsername}</span>}
      </div>

      <div className="flex items-baseline gap-x-4 gap-y-1 flex-wrap mb-1.5 text-sm">
        <span className="text-2xl font-semibold text-text tabular-nums">{passRate}%</span>
        <span className="text-text-muted tabular-nums"><span className="text-online font-medium">{totals.passed}</span> passed</span>
        <span className="text-text-muted tabular-nums"><span className={failed ? 'text-danger font-medium' : ''}>{totals.failed}</span> failed</span>
        <span className="text-text-muted tabular-nums">{totals.skipped} skipped</span>
        {totals.durationMs !== undefined && <span className="text-text-dim tabular-nums">{duration(totals.durationMs)}</span>}
      </div>
      <StackedBar counts={totals} />

      {data.summary && (
        <div className="mt-3">
          {data.summarySource === 'model' && <div className="text-[10px] uppercase tracking-wide text-text-dim mb-0.5">AI summary</div>}
          <MessageContent content={data.summary} />
        </div>
      )}

      {suites.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-text-muted mb-1">Suites</div>
          <ul className="space-y-1">
            {shownSuites.map(s => (
              <li key={s.name} className="grid grid-cols-[minmax(0,1fr)_7.5rem] sm:grid-cols-[minmax(0,1fr)_6rem_7.5rem] items-center gap-x-2 text-xs">
                <span className={`col-span-2 sm:col-span-1 truncate font-mono ${s.failed ? 'text-danger' : 'text-text-muted'}`} title={s.name}>{s.name}</span>
                <StackedBar counts={s} className="h-1.5" />
                <span className="text-text-dim tabular-nums whitespace-nowrap text-right">
                  {s.passed}/{s.passed + s.failed + s.skipped}{s.durationMs !== undefined ? ` · ${duration(s.durationMs)}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {suites.length > SUITES_SHOWN && (
            <button className="mt-1 text-xs text-primary hover:underline" onClick={() => setAllSuites(v => !v)}>
              {allSuites ? 'Show fewer' : `Show all ${suites.length} suites`}
            </button>
          )}
        </div>
      )}

      {failures.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-text-muted mb-1">
            Failures{totals.failed > failures.length ? ` (first ${failures.length} of ${totals.failed})` : ''}
          </div>
          <div className="space-y-1">
            {failures.map((f, i) => (
              <details key={i} className="rounded border border-border bg-bg/60">
                <summary className="cursor-pointer px-2 py-1 text-xs text-text break-words">
                  {f.suite && <span className="text-text-dim">{f.suite} › </span>}{f.name}
                </summary>
                <pre className="max-h-60 overflow-auto px-2 pb-2 text-[11px] text-text-muted font-mono whitespace-pre-wrap break-words">{f.message}</pre>
              </details>
            ))}
          </div>
        </div>
      )}

      {message.attachments && message.attachments.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          {message.attachments.map(att => <FileAttachment key={att.id} attachment={att} />)}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { truncateNotice } from './systemNotices';

interface NoticeRunToggleProps {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

/** The "▸ N system notices" row that opens or closes a run. */
export function NoticeRunToggle({ count, expanded, onToggle }: NoticeRunToggleProps) {
  return (
    <div className="px-4 py-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-h-8 max-w-full items-center gap-2 rounded px-2 text-left text-[13px] text-text-muted transition-colors hover:bg-surface-hover/50 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span aria-hidden="true" className="inline-block w-3 text-center">{expanded ? '▾' : '▸'}</span>
        <span>{count} system notices</span>
      </button>
    </div>
  );
}

/** Notice text that folds after ~6 lines / 600 chars behind a show more / show less button. */
export function NoticeText({ text, className = '' }: { text: string | null | undefined; className?: string }) {
  const [open, setOpen] = useState(false);
  const short = truncateNotice(text);
  return (
    <span className={`min-w-0 whitespace-pre-line [overflow-wrap:anywhere] ${className}`}>
      {short && !open ? short : text}
      {short && (
        <>
          {' '}
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className="inline-flex min-h-8 items-center rounded px-1 align-middle text-[13px] font-medium text-primary-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            {open ? 'show less' : 'show more'}
          </button>
        </>
      )}
    </span>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"
    className={`h-4 w-4 shrink-0 text-text transition-transform ${expanded ? 'rotate-90' : ''}`}>
    <path d="m7 4 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function AgentRunCollapse({ count, onCollapse }: { count: number; onCollapse: () => void }) {
  return <button type="button" onClick={onCollapse} aria-label={`Collapse ${count} agent updates`}
    className="flex min-h-11 items-center gap-2 rounded px-3 text-[13px] font-medium text-text hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
    <Chevron expanded />Collapse updates
  </button>;
}

export function AgentMessageRunToggle({ count, names, noticeCount = 0, expanded, onToggle }: {
  count: number; names: readonly string[]; noticeCount?: number; expanded: boolean; onToggle: () => void;
}) {
  return (
    <div className="px-4 py-0.5">
      <button type="button" onClick={onToggle} aria-expanded={expanded}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-[13px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <Chevron expanded={expanded} />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="font-medium text-text">{count} agent {count === 1 ? 'update' : 'updates'}</span>
          {names.length > 0 && <> <span>({names.join(', ')})</span></>}
          {noticeCount > 0 && <> · incl. {noticeCount} {noticeCount === 1 ? 'notice' : 'notices'}</>}
        </span>
      </button>
    </div>
  );
}

export function AgentMessageRunToggle({ count, names, expanded, onToggle }: {
  count: number; names: readonly string[]; expanded: boolean; onToggle: () => void;
}) {
  return (
    <div className="px-4 py-0.5">
      <button type="button" onClick={onToggle} aria-expanded={expanded}
        className="flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-[13px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <span aria-hidden="true" className="shrink-0">{expanded ? '▾' : '▸'}</span>
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="font-medium text-text">{count} agent messages</span>{' '}
          <span>({names.join(', ')})</span>
        </span>
      </button>
    </div>
  );
}

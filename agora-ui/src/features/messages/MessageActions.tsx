interface MessageActionsProps {
  isOwn: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onReact: () => void;
}

export function MessageActions({ isOwn, onEdit, onDelete, onReact }: MessageActionsProps) {
  return (
    <div className="absolute bottom-1 right-2 flex gap-0.5 bg-surface border border-border rounded shadow-md opacity-0 group-hover:opacity-100 transition-opacity z-10">
      <button
        onClick={onReact}
        className={`px-2 py-1 text-text-muted hover:text-text hover:bg-surface-hover transition-colors ${isOwn ? '' : 'rounded'}`}
        title="Add reaction"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
      {isOwn && (
        <>
          <button
            onClick={onEdit}
            className="px-2 py-1 text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
            title="Edit"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
          <button
            onClick={onDelete}
            className="px-2 py-1 text-text-muted hover:text-danger hover:bg-surface-hover rounded-r transition-colors"
            title="Delete"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}

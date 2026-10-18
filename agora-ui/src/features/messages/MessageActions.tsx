import { useState } from 'react';
import { MessageActionSheet } from './MessageActionSheet';

interface MessageActionsProps {
  isOwn: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onReply?: () => void;
  messageContent?: string;
  sheetOpen?: boolean;
  onSheetOpenChange?: (open: boolean) => void;
}

export function MessageActions({
  isOwn,
  onEdit,
  onDelete,
  onReply,
  messageContent,
  sheetOpen,
  onSheetOpenChange,
}: MessageActionsProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isSheetOpen = sheetOpen ?? internalOpen;
  const setSheetOpen = onSheetOpenChange ?? setInternalOpen;

  const handleCopy = messageContent !== undefined
    ? () => {
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(messageContent);
        }
      }
    : undefined;

  return (
    <>
      {/* Desktop (>=768px) hover / focus-within inline toolbar */}
      <div className="hidden md:flex absolute bottom-1 right-2 gap-0.5 bg-surface border border-border rounded-lg shadow-md opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity z-10">
        {onReply && (
          <button
            type="button"
            onClick={onReply}
            className="h-8 w-8 flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-hover transition-colors rounded-l-lg"
            title="Reply in thread"
            aria-label="Reply in thread"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </button>
        )}
        {handleCopy && (
          <button
            type="button"
            onClick={handleCopy}
            className="h-8 w-8 flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
            title="Copy text"
            aria-label="Copy text"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeWidth={2} />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          </button>
        )}
        {isOwn && (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="h-8 w-8 flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
              title="Edit"
              aria-label="Edit"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="h-8 w-8 flex items-center justify-center text-text-muted hover:text-danger hover:bg-surface-hover rounded-r-lg transition-colors"
              title="Delete"
              aria-label="Delete"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* Touch / phone (<768px) visible 44x44 actions trigger */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        className="md:hidden absolute top-0.5 right-1 min-h-11 min-w-11 flex items-center justify-center rounded-lg text-text-muted hover:text-text hover:bg-surface-hover/60 transition-colors z-10"
        title="Message actions"
        aria-label="Message actions"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>

      <MessageActionSheet
        isOpen={isSheetOpen}
        onClose={() => setSheetOpen(false)}
        isOwn={isOwn}
        onReply={onReply}
        onCopy={handleCopy}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </>
  );
}

import { useState } from 'react';
import type { Message } from '../../stores/messageStore';
import { MessageActions } from './MessageActions';
import { EditMessageInput } from './EditMessageInput';

interface MessageItemProps {
  message: Message;
  isGrouped: boolean;
  isOwn: boolean;
  onEdit: (msgId: string, content: string) => void;
  onDelete: (msgId: string) => void;
}

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function MessageItem({ message, isGrouped, isOwn, onEdit, onDelete }: MessageItemProps) {
  const [editing, setEditing] = useState(false);

  // Deleted message tombstone
  if (message.deletedAt) {
    return (
      <div className={`px-4 ${isGrouped ? 'py-0.5 pl-[68px]' : 'pt-3 pb-0.5'}`}>
        {!isGrouped && <div className="h-4" />}
        <span className="text-sm text-text-dim italic">[message deleted]</span>
      </div>
    );
  }

  const opacity = message.pending ? 'opacity-50' : message.failed ? 'opacity-70' : '';

  if (isGrouped) {
    return (
      <div className={`group relative px-4 py-0.5 pl-[68px] hover:bg-surface-hover/30 ${opacity}`}>
        {isOwn && !editing && <MessageActions onEdit={() => setEditing(true)} onDelete={() => onDelete(message.id)} />}
        {editing ? (
          <EditMessageInput
            message={message}
            onSave={(content) => { onEdit(message.id, content); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="text-sm text-text">{message.content}</div>
        )}
        {message.failed && (
          <span className="text-xs text-danger ml-2">Failed to send</span>
        )}
      </div>
    );
  }

  return (
    <div className={`group relative px-4 pt-3 pb-0.5 hover:bg-surface-hover/30 flex gap-3 ${opacity}`}>
      {isOwn && !editing && <MessageActions onEdit={() => setEditing(true)} onDelete={() => onDelete(message.id)} />}
      {/* Avatar */}
      <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-sm font-bold text-white shrink-0 mt-0.5">
        {(message.authorUsername || '?')[0].toUpperCase()}
      </div>
      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm text-text">{message.authorUsername || 'Unknown'}</span>
          <span className="text-xs text-text-dim">{formatTimestamp(message.createdAt)}</span>
          {message.editedAt && <span className="text-xs text-text-dim">(edited)</span>}
        </div>
        {editing ? (
          <EditMessageInput
            message={message}
            onSave={(content) => { onEdit(message.id, content); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="text-sm text-text">{message.content}</div>
        )}
        {message.failed && (
          <span className="text-xs text-danger">Failed to send</span>
        )}
      </div>
    </div>
  );
}

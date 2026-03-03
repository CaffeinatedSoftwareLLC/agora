import { useState } from 'react';
import type { Message } from '../../stores/messageStore';
import { MessageActions } from './MessageActions';
import { EditMessageInput } from './EditMessageInput';
import { ReactionBar } from '../live/ReactionBar';
import { FileAttachment } from './FileAttachment';
import { usePalette } from '../../theme';

interface MessageItemProps {
  message: Message;
  isGrouped: boolean;
  isOwn: boolean;
  onEdit: (msgId: string, content: string) => void;
  onDelete: (msgId: string) => void;
  channelId?: string;
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

export function MessageItem({ message, isGrouped, isOwn, onEdit, onDelete, channelId }: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const P = usePalette();

  // System event message (e.g., call started, call ended)
  if (message.systemEvent) {
    return (
      <div className="flex items-center justify-center gap-2 py-2 px-4">
        <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke={P.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
        </svg>
        <span className="text-xs" style={{ color: P.muted }}>
          {message.content}
        </span>
      </div>
    );
  }

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
        {!editing && <MessageActions isOwn={isOwn} onEdit={() => setEditing(true)} onDelete={() => onDelete(message.id)} onReact={() => setShowPicker(true)} />}
        {editing ? (
          <EditMessageInput
            message={message}
            onSave={(content) => { onEdit(message.id, content); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="text-sm text-text">{message.content}</div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-1">
            {message.attachments.map(att => (
              <FileAttachment key={att.id} attachment={att} />
            ))}
          </div>
        )}
        {channelId && <ReactionBar messageId={message.id} channelId={channelId} pickerOpen={showPicker} onPickerClose={() => setShowPicker(false)} />}
        {message.failed && (
          <span className="text-xs text-danger ml-2">Failed to send</span>
        )}
      </div>
    );
  }

  return (
    <div className={`group relative px-4 pt-3 pb-0.5 hover:bg-surface-hover/30 flex gap-3 ${opacity}`}>
      {!editing && <MessageActions isOwn={isOwn} onEdit={() => setEditing(true)} onDelete={() => onDelete(message.id)} onReact={() => setShowPicker(true)} />}
      {/* Avatar */}
      <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-sm font-bold text-white shrink-0 mt-0.5">
        {(message.authorUsername || '?')[0].toUpperCase()}
      </div>
      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm text-text">{message.authorUsername || 'Unknown'}</span>
          {message.authorBot && (
            <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-semibold leading-none bg-primary/20 text-primary">BOT</span>
          )}
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
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-1">
            {message.attachments.map(att => (
              <FileAttachment key={att.id} attachment={att} />
            ))}
          </div>
        )}
        {channelId && <ReactionBar messageId={message.id} channelId={channelId} pickerOpen={showPicker} onPickerClose={() => setShowPicker(false)} />}
        {message.failed && (
          <span className="text-xs text-danger">Failed to send</span>
        )}
      </div>
    </div>
  );
}

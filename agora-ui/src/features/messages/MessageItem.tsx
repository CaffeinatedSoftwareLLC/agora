import { useUIStore } from '../../stores/uiStore';
import { ProviderTermsNotice } from './ProviderTermsNotice';
import { useState, useRef } from 'react';
import type { Message } from '../../stores/messageStore';
import { MessageActions } from './MessageActions';
import { EditMessageInput } from './EditMessageInput';
import { MessageContent } from './MessageContent';
import { FileAttachment } from './FileAttachment';
import { ThreadIndicator } from './ThreadIndicator';
import { ProtocolBadge } from './ProtocolBadge';
import { RuntimeCard } from './RuntimeCard';
import { NoticeText } from './SystemNoticeRun';
import { RunApprovalCard, ToolApprovalCard } from '../agents/ToolApprovalCard';
import { HandoffCard } from '../agents/HandoffCard';
import { PermissionRelayCard } from '../agents/PermissionRelayCard';
import { TaskThreadNotice } from '../tasks/TaskThreadNotice';
import { SearchCard } from './SearchCard';
import { ReportCard } from './ReportCard';
import { ArtifactCard } from '../canvas/ArtifactCard';
import { usePalette } from '../../theme';
import { browserSpeechSupported, primeAudio, useVoiceStore } from '../voice/voiceStore';

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
  const [sheetOpen, setSheetOpen] = useState(false);
  const longPressTimerRef = useRef<number | null>(null);
  const P = usePalette();
  const openThread = useUIStore(s => s.openThreadView);
  const canReply = !!(channelId && !message.deletedAt && !message.systemEvent);
  const handleReply = canReply ? () => openThread(channelId!, message.id) : undefined;
  const voiceOutput = useVoiceStore(s => (channelId ? s.channels[channelId]?.output : undefined));
  const readingAloud = useVoiceStore(s => s.speaking === message.id);
  const canReadAloud = !!(channelId && message.content?.trim() && !message.pending && !message.failed && !message.streaming
    && (voiceOutput === 'server' || (voiceOutput === 'browser' && browserSpeechSupported())));
  const handleReadAloud = canReadAloud
    ? () => {
        primeAudio();
        const voice = useVoiceStore.getState();
        if (readingAloud) voice.stop();
        else voice.speak({ id: message.id, channelId: channelId!, content: message.content });
      }
    : undefined;

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleTouchStart = () => {
    if (editing) return;
    clearLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      setSheetOpen(true);
      longPressTimerRef.current = null;
    }, 400);
  };

  // Sandboxed runtime: grounded search display, test report, approval request, result summary, tripwire
  if (message.systemEvent === 'runtime_search') {
    return <SearchCard message={message} />;
  }
  if (message.systemEvent === 'runtime_report') {
    return <ReportCard message={message} />;
  }
  if (message.systemEvent?.startsWith('runtime_')) {
    return <RuntimeCard message={message} />;
  }

  // A hosted agent was denied a tool: approve once / always / deny (#73)
  if (message.systemEvent === 'agent_tool_approval') {
    return <ToolApprovalCard message={message} />;
  }
  // A profile with run approval asks the owner before every wake (docs/provider-terms.md)
  if (message.systemEvent === 'agent_run_approval') {
    return <RunApprovalCard message={message} />;
  }

  // An agent offers a thread's task to another (#84)
  if (message.systemEvent === 'agent_handoff') {
    return <HandoffCard message={message} />;
  }

  if (message.systemEvent === 'agent_permission_relay') {
    return <PermissionRelayCard message={message} />;
  }

  // A task card's or subtask's thread (docs/task-board.md)
  if ((message.systemEvent === 'task_card' || message.systemEvent === 'subtask') && channelId) {
    return <TaskThreadNotice message={message} channelId={channelId} />;
  }

  // Agent session notice (started / shelved / ended): left-aligned with the message column, console icon
  if (message.systemEvent === 'agent_session') {
    return (
      <div className="flex items-start gap-3 px-4 py-1">
        <div className="flex w-10 shrink-0 justify-center pt-[3px]">
          <svg className="h-4 w-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M7 9l3 3-3 3M13 15h4" />
          </svg>
        </div>
        <NoticeText text={message.content} className="text-[13px] leading-5 text-text-muted" />
      </div>
    );
  }

  if (message.systemEvent === 'provider_terms') return <ProviderTermsNotice content={message.content} />;

  // Other system events (e.g. loop guard)
  if (message.systemEvent) {
    return (
      <div className="flex items-start justify-center gap-2 py-2 px-4">
        <svg className="mt-[3px] h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke={P.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
        </svg>
        <NoticeText text={message.content} className="text-[13px] leading-5 text-text-muted" />
      </div>
    );
  }

  // Deleted message tombstone
  if (message.deletedAt) {
    return (
      <div className={`px-4 ${isGrouped ? 'py-0.5 pl-[68px]' : 'pt-3 pb-0.5'}`}>
        {!isGrouped && <div className="h-4" />}
        <span className="text-[13px] text-text-muted italic">[message deleted]</span>
      </div>
    );
  }

  const opacity = message.pending ? 'opacity-50' : message.failed ? 'opacity-70' : '';

  if (isGrouped) {
    return (
      <div
        className={`group relative px-4 pr-12 md:pr-4 py-0.5 pl-[68px] hover:bg-surface-hover/30 ${opacity}`}
        onTouchStart={handleTouchStart}
        onTouchEnd={clearLongPress}
        onTouchMove={clearLongPress}
        onTouchCancel={clearLongPress}
      >
        {!editing && (
          <MessageActions
            isOwn={isOwn}
            onEdit={() => setEditing(true)}
            onDelete={() => onDelete(message.id)}
            onReply={handleReply}
            messageContent={message.content ?? ''}
            onReadAloud={handleReadAloud}
            readingAloud={readingAloud}
            sheetOpen={sheetOpen}
            onSheetOpenChange={setSheetOpen}
          />
        )}
        {message.protocol && !editing && (
          <div className="mb-0.5"><ProtocolBadge protocol={message.protocol} /></div>
        )}
        {editing ? (
          <EditMessageInput
            message={message}
            onSave={(content) => { onEdit(message.id, content); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <MessageContent content={message.content} />
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-1">
            {message.attachments.map(att => (
              <FileAttachment key={att.id} attachment={att} />
            ))}
          </div>
        )}
        {message.artifact && (channelId ?? message.channelId) && (
          <ArtifactCard artifact={message.artifact} channelId={channelId ?? message.channelId} />
        )}
        {!!(message.replyCount && message.replyCount > 0 && channelId) && (
          <ThreadIndicator replyCount={message.replyCount} lastReplyAt={message.lastReplyAt} channelId={channelId} messageId={message.id} threadClosedAt={message.threadClosedAt} />
        )}
        {message.failed && (
          <span className="text-[11px] text-danger ml-2">Failed to send</span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`group relative px-4 pr-12 md:pr-4 pt-3 pb-0.5 hover:bg-surface-hover/30 flex gap-3 ${opacity}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={clearLongPress}
      onTouchMove={clearLongPress}
      onTouchCancel={clearLongPress}
    >
      {!editing && (
        <MessageActions
          isOwn={isOwn}
          onEdit={() => setEditing(true)}
          onDelete={() => onDelete(message.id)}
          onReply={handleReply}
          messageContent={message.content ?? ''}
          onReadAloud={handleReadAloud}
          readingAloud={readingAloud}
          sheetOpen={sheetOpen}
          onSheetOpenChange={setSheetOpen}
        />
      )}
      {/* Avatar */}
      {message.authorAvatarUrl ? (
        <img
          src={message.authorAvatarUrl}
          alt={message.authorUsername || '?'}
          className="w-10 h-10 rounded-full object-cover shrink-0 mt-0.5"
        />
      ) : (
        <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-sm font-bold text-on-primary shrink-0 mt-0.5">
          {(message.authorUsername || '?')[0].toUpperCase()}
        </div>
      )}
      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold text-[15px] text-text">{message.authorUsername || 'Unknown'}</span>
          {message.authorBot && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold leading-none bg-primary/20 text-primary-text">BOT</span>
          )}
          <span className="text-[11px] text-text-muted">{formatTimestamp(message.createdAt)}</span>
          {message.editedAt && <span className="text-[11px] text-text-muted">(edited)</span>}
          {message.protocol && <ProtocolBadge protocol={message.protocol} />}
        </div>
        {editing ? (
          <EditMessageInput
            message={message}
            onSave={(content) => { onEdit(message.id, content); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <MessageContent content={message.content} />
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-1">
            {message.attachments.map(att => (
              <FileAttachment key={att.id} attachment={att} />
            ))}
          </div>
        )}
        {message.artifact && (channelId ?? message.channelId) && (
          <ArtifactCard artifact={message.artifact} channelId={channelId ?? message.channelId} />
        )}
        {!!(message.replyCount && message.replyCount > 0 && channelId) && (
          <ThreadIndicator replyCount={message.replyCount} lastReplyAt={message.lastReplyAt} channelId={channelId} messageId={message.id} threadClosedAt={message.threadClosedAt} />
        )}
        {message.failed && (
          <span className="text-[11px] text-danger">Failed to send</span>
        )}
      </div>
    </div>
  );
}

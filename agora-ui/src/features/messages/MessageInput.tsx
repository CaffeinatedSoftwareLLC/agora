import { useDraftStore, sendDraft, type DraftKey } from '../../stores/draftStore';
import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useSocket } from '../../hooks/useSocket';
import { MentionAutocomplete } from '../live/MentionAutocomplete';
import { useAgentCommands } from './AgentCommands';

interface MessageInputProps {
  channelId: string;
}

export function MessageInput({ channelId }: MessageInputProps) {
  const draftKey: DraftKey = `channel:${channelId}`;
  const content = useDraftStore(s => s.drafts[draftKey] ?? '');
  const setContent = (text: string) => useDraftStore.getState().setDraft(draftKey, text);
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingRef = useRef(0);
  const sendMessage = useMessageStore(s => s.sendMessage);
  const user = useAuthStore(s => s.user);
  const activeServerId = useServerStore(s => s.activeServerId);
  const socket = useSocket();
  const agentCommands = useAgentCommands(channelId, () => {
    if (useDraftStore.getState().getDraft(draftKey) === content) useDraftStore.getState().clearDraft(draftKey);
  });

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 104)}px`; // max 4 lines
    }
  }, [content]);

  const handleSend = async () => {
    if (sending) return;
    const trimmed = content.trim();
    if (!trimmed || !user) return;
    // /start, /end, /sessions, /resume go to the agent sessions route, not the channel
    if (agentCommands.tryHandle(trimmed)) {
      setShowMentions(false);
      return;
    }
    setSending(true);
    await sendDraft(draftKey, () => sendMessage(channelId, trimmed, user.id, user.username));
    setSending(false);
    setShowMentions(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentions) return; // Let MentionAutocomplete handle keyboard events
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setContent(value);

    // Emit typing event (debounced to every 2 seconds)
    const now = Date.now();
    if (socket && now - lastTypingRef.current > 2000) {
      socket.emit('Typing', { channelId });
      lastTypingRef.current = now;
    }

    // Detect @mention
    const cursorPos = e.target.selectionStart;
    const textUpToCursor = value.slice(0, cursorPos);
    const mentionMatch = textUpToCursor.match(/@([\w-]*)$/);
    if (mentionMatch) {
      setMentionQuery(mentionMatch[1]);
      setShowMentions(true);
    } else {
      setShowMentions(false);
    }
  };

  const handleMentionSelect = (username: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart;
    const textUpToCursor = content.slice(0, cursorPos);
    const atIndex = textUpToCursor.lastIndexOf('@');
    if (atIndex === -1) return;

    const before = content.slice(0, atIndex);
    const after = content.slice(cursorPos);
    const newContent = `${before}@${username} ${after}`;
    setContent(newContent);
    setShowMentions(false);

    // Restore focus and cursor position
    requestAnimationFrame(() => {
      el.focus();
      const newPos = atIndex + username.length + 2; // @username + space
      el.setSelectionRange(newPos, newPos);
    });
  };

  return (
    <div className="px-2.5 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-4 md:pb-4 md:pt-2 shrink-0 relative">
      {agentCommands.panel}
      <MentionAutocomplete
        query={mentionQuery}
        serverId={activeServerId}
        onSelect={handleMentionSelect}
        onClose={() => setShowMentions(false)}
        visible={showMentions}
      />
      <div className="bg-surface rounded-2xl border border-border flex items-end gap-1.5 px-2.5 py-1.5">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          className="flex-1 bg-transparent px-2 py-2 md:py-1.5 text-[16px] md:text-[15px] leading-[1.4] text-text placeholder:text-text-muted/70 resize-none focus:outline-none overflow-y-auto"
          style={{ maxHeight: 104 }}
          rows={1}
          maxLength={4000}
          disabled={!user}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!content.trim() || !user}
          className="min-h-11 min-w-11 md:h-9 md:w-9 rounded-xl flex items-center justify-center shrink-0 bg-primary text-on-primary hover:bg-primary-hover disabled:bg-bg disabled:text-text-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          aria-label="Send message"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

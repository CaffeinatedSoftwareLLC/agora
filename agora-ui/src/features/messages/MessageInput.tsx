import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useSocket } from '../../hooks/useSocket';
import { MentionAutocomplete } from '../live/MentionAutocomplete';

interface MessageInputProps {
  channelId: string;
}

export function MessageInput({ channelId }: MessageInputProps) {
  const [content, setContent] = useState('');
  const [mentionQuery, setMentionQuery] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingRef = useRef(0);
  const sendMessage = useMessageStore(s => s.sendMessage);
  const user = useAuthStore(s => s.user);
  const activeServerId = useServerStore(s => s.activeServerId);
  const socket = useSocket();

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 144)}px`; // max ~6 lines
    }
  }, [content]);

  const handleSend = () => {
    const trimmed = content.trim();
    if (!trimmed || !user) return;
    sendMessage(channelId, trimmed, user.id, user.username);
    setContent('');
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
    <div className="px-4 pb-4 pt-2 shrink-0 relative">
      <MentionAutocomplete
        query={mentionQuery}
        serverId={activeServerId}
        onSelect={handleMentionSelect}
        onClose={() => setShowMentions(false)}
        visible={showMentions}
      />
      <div className="bg-surface rounded-lg border border-border flex items-end">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          className="flex-1 bg-transparent px-4 py-3 text-sm text-text placeholder:text-text-dim resize-none focus:outline-none overflow-y-auto"
          style={{ maxHeight: 144 }}
          rows={1}
          maxLength={4000}
          disabled={!user}
        />
        <button
          onClick={handleSend}
          disabled={!content.trim() || !user}
          className="px-3 py-3 text-text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';

interface MessageInputProps {
  channelId: string;
}

export function MessageInput({ channelId }: MessageInputProps) {
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useMessageStore(s => s.sendMessage);
  const user = useAuthStore(s => s.user);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 144)}px`; // max ~6 lines
    }
  }, [content]);

  // Reset input when channel changes
  useEffect(() => {
    setContent('');
  }, [channelId]);

  const handleSend = () => {
    const trimmed = content.trim();
    if (!trimmed || !user) return;
    sendMessage(channelId, trimmed, user.id, user.username);
    setContent('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="px-4 pb-4 pt-2 shrink-0">
      <div className="bg-surface rounded-lg border border-border flex items-end">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
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

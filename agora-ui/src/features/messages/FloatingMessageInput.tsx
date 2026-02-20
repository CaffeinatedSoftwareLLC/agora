import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useSocket } from '../../hooks/useSocket';
import { MentionAutocomplete } from '../live/MentionAutocomplete';
import { usePalette, hexToRgb } from '../../theme';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FloatingMessageInputProps {
  channelId: string;
  channelName?: string;
  accentColor: string;
  isDm?: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function FloatingMessageInput({
  channelId,
  channelName,
  accentColor,
  isDm,
}: FloatingMessageInputProps) {
  const P = usePalette();
  const accentRgb = hexToRgb(accentColor);

  const [content, setContent] = useState('');
  const [mentionQuery, setMentionQuery] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingRef = useRef(0);

  const sendMessage = useMessageStore(s => s.sendMessage);
  const user = useAuthStore(s => s.user);
  const activeServerId = useServerStore(s => s.activeServerId);
  const socket = useSocket();

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
    }
  }, [content]);

  // Send handler
  const handleSend = () => {
    const trimmed = content.trim();
    if (!trimmed || !user) return;
    sendMessage(channelId, trimmed, user.id, user.username);
    setContent('');
    setShowMentions(false);
  };

  // Enter to send, Shift+Enter for newline
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentions) return; // Let MentionAutocomplete handle keyboard events
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Typing emission (debounced 2s) + @mention detection
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
    const mentionMatch = textUpToCursor.match(/@(\w*)$/);
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

  const hasContent = content.trim().length > 0;

  return (
    <div className="shrink-0 px-5 pb-4 pt-2">
      {/* Mention autocomplete (positioned above the input) */}
      <div className="relative">
        <MentionAutocomplete
          query={mentionQuery}
          serverId={activeServerId}
          onSelect={handleMentionSelect}
          onClose={() => setShowMentions(false)}
          visible={showMentions}
        />
      </div>

      {/* Pill-shaped glass-blur input container */}
      <div
        className="relative rounded-2xl transition-all"
        style={{
          background: `${P.surface}dd`,
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: `1px solid ${hasContent ? `rgba(${accentRgb}, 0.3)` : P.border}`,
          boxShadow: hasContent
            ? `0 0 20px rgba(${accentRgb}, 0.08)`
            : '0 2px 12px rgba(0,0,0,0.2)',
        }}
      >
        {/* Top row: + attach button */}
        <div className="flex items-center gap-0.5 px-3 pt-2">
          <button
            className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
            style={{ color: P.dim }}
            title="Attach file"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        {/* Bottom row: textarea + emoji + send */}
        <div className="flex items-end gap-2 px-3 pb-2.5 pt-1">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={isDm ? `Message @${channelName || 'user'}` : `Message #${channelName || 'channel'}`}
            className="flex-1 bg-transparent text-[14px] outline-none min-w-0 py-1 resize-none overflow-y-auto"
            style={{ color: P.text, caretColor: accentColor, maxHeight: 144 }}
            rows={1}
            maxLength={4000}
            disabled={!user}
          />
          <div className="flex items-center gap-0.5 shrink-0">
            {/* Emoji button */}
            <button
              className="h-8 w-8 rounded-lg flex items-center justify-center transition-colors"
              style={{ color: P.dim }}
              title="Emoji"
            >
              <svg
                className="h-4.5 w-4.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                <line x1="9" y1="9" x2="9.01" y2="9" />
                <line x1="15" y1="9" x2="15.01" y2="9" />
              </svg>
            </button>

            {/* Send button - gradient when text present */}
            <button
              onClick={handleSend}
              disabled={!hasContent || !user}
              className="h-8 w-8 rounded-xl flex items-center justify-center transition-all disabled:cursor-not-allowed"
              style={{
                background: hasContent
                  ? `linear-gradient(135deg, ${P.primary}, ${accentColor})`
                  : P.bg,
                color: hasContent ? P.text : P.dim,
                boxShadow: hasContent ? `0 2px 8px ${accentColor}40` : 'none',
              }}
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

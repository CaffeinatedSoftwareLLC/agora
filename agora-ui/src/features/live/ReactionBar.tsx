import { useState, useMemo, useRef } from 'react';
import { useReactionStore } from '../../stores/reactionStore';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';
import { ReactionPicker } from './ReactionPicker';

interface ReactionBarProps {
  messageId: string;
  channelId: string;
  pickerOpen?: boolean;
  onPickerClose?: () => void;
}

export function ReactionBar({ messageId, channelId, pickerOpen, onPickerClose }: ReactionBarProps) {
  const rawReactions = useReactionStore((s) => s.byMessage.get(messageId));
  const reactions = useMemo(() => rawReactions ?? [], [rawReactions]);
  const userId = useAuthStore((s) => s.user?.id);
  const [internalPicker, setInternalPicker] = useState(false);
  const addBtnRef = useRef<HTMLDivElement>(null);
  const showPicker = pickerOpen ?? internalPicker;
  const closePicker = () => { setInternalPicker(false); onPickerClose?.(); };

  const handleToggle = async (emoji: string, isMe: boolean) => {
    if (!userId) return;
    if (isMe) {
      await api.delete(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
    } else {
      await api.put(`/channels/${channelId}/messages/${messageId}/reactions`, { emoji });
    }
  };

  const handlePickerSelect = async (emoji: string) => {
    closePicker();
    if (!userId) return;
    await api.put(`/channels/${channelId}/messages/${messageId}/reactions`, { emoji });
  };

  if (reactions.length === 0 && !showPicker) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1 relative">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          onClick={() => handleToggle(r.emoji, r.me)}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border transition-colors ${
            r.me
              ? 'bg-primary/20 border-primary text-text'
              : 'bg-surface-hover/50 border-border text-text-muted hover:border-text-dim'
          }`}
        >
          <span>{r.emoji}</span>
          <span>{r.count}</span>
        </button>
      ))}
      <div className="relative" ref={addBtnRef}>
        <button
          onClick={() => showPicker ? closePicker() : setInternalPicker(true)}
          className="w-6 h-6 flex items-center justify-center rounded border border-border text-text-dim hover:text-text hover:bg-surface-hover transition-colors text-xs"
          title="Add reaction"
        >
          +
        </button>
        {showPicker && (
          <ReactionPicker
            onSelect={handlePickerSelect}
            onClose={closePicker}
            anchorRef={addBtnRef}
          />
        )}
      </div>
    </div>
  );
}

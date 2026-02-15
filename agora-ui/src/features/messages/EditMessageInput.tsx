import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import type { Message } from '../../stores/messageStore';

interface EditMessageInputProps {
  message: Message;
  onSave: (content: string) => void;
  onCancel: () => void;
}

export function EditMessageInput({ message, onSave, onCancel }: EditMessageInputProps) {
  const [content, setContent] = useState(message.content ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    // Place cursor at end
    const el = textareaRef.current;
    if (el) {
      el.selectionStart = el.value.length;
      el.selectionEnd = el.value.length;
    }
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [content]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const trimmed = content.trim();
      if (trimmed.length > 0 && trimmed !== message.content) {
        onSave(trimmed);
      } else {
        onCancel();
      }
    }
  };

  return (
    <div className="mt-1">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full bg-bg border border-border rounded px-3 py-2 text-text text-sm resize-none focus:outline-none focus:border-primary"
        maxLength={4000}
        rows={1}
      />
      <div className="text-xs text-text-dim mt-1">
        Escape to <button onClick={onCancel} className="text-accent hover:underline">cancel</button>
        {' '}&middot; Enter to <button onClick={() => { const t = content.trim(); if (t.length > 0 && t !== message.content) onSave(t); else onCancel(); }} className="text-accent hover:underline">save</button>
      </div>
    </div>
  );
}

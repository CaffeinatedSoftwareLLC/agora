import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type DragEvent } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useUploadStore, type PendingUpload } from '../../stores/uploadStore';
import { useSocket } from '../../hooks/useSocket';
import { MentionAutocomplete } from '../live/MentionAutocomplete';
import { usePalette, hexToRgb } from '../../theme';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ATTACHMENTS = 10;

// ─── Types ───────────────────────────────────────────────────────────────────

interface FloatingMessageInputProps {
  channelId: string;
  channelName?: string;
  accentColor: string;
  isDm?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingRef = useRef(0);
  const dragCounterRef = useRef(0);

  const sendMessage = useMessageStore(s => s.sendMessage);
  const user = useAuthStore(s => s.user);
  const activeServerId = useServerStore(s => s.activeServerId);
  const socket = useSocket();

  // Upload store
  const addUpload = useUploadStore(s => s.addUpload);
  const removeUpload = useUploadStore(s => s.removeUpload);
  const clearCompleted = useUploadStore(s => s.clearCompleted);
  const uploads = useUploadStore(s => s.getChannelUploads(channelId));
  const completedIds = useUploadStore(s => s.getCompletedIds(channelId));

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
    }
  }, [content]);

  // Handle files from any source
  const handleFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const currentCount = uploads.length;
    const allowed = fileArray.slice(0, MAX_ATTACHMENTS - currentCount);
    for (const file of allowed) {
      addUpload(channelId, file);
    }
  }, [channelId, addUpload, uploads.length]);

  // Send handler
  const handleSend = () => {
    const trimmed = content.trim();
    const hasAttachments = completedIds.length > 0;
    if ((!trimmed && !hasAttachments) || !user) return;

    // Check if all uploads are complete
    const pending = uploads.filter(u => u.status === 'uploading');
    if (pending.length > 0) return; // Wait for uploads to finish

    sendMessage(
      channelId,
      trimmed || '',
      user.id,
      user.username,
      hasAttachments ? completedIds : undefined,
    );
    setContent('');
    setShowMentions(false);
    clearCompleted(channelId);
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

  // File input change handler
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
    // Reset so the same file can be selected again
    e.target.value = '';
  };

  // Paste handler for images
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      handleFiles(files);
    }
  };

  // Drag and drop handlers
  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setDragging(true);
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setDragging(false);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounterRef.current = 0;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const hasContent = content.trim().length > 0;
  const hasAttachments = completedIds.length > 0;
  const hasPendingUploads = uploads.some(u => u.status === 'uploading');
  const canSend = (hasContent || hasAttachments) && !hasPendingUploads;

  return (
    <div
      className="shrink-0 px-5 pb-4 pt-2"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />

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
          border: dragging
            ? `2px dashed ${P.primary}`
            : `1px solid ${hasContent ? `rgba(${accentRgb}, 0.3)` : P.border}`,
          boxShadow: hasContent
            ? `0 0 20px rgba(${accentRgb}, 0.08)`
            : '0 2px 12px rgba(0,0,0,0.2)',
        }}
      >
        {/* Drag overlay */}
        {dragging && (
          <div className="absolute inset-0 rounded-2xl flex items-center justify-center z-10"
            style={{ backgroundColor: `${P.bg}cc` }}>
            <span className="text-sm font-medium" style={{ color: P.primary }}>Drop files to upload</span>
          </div>
        )}

        {/* Top row: + attach button */}
        <div className="flex items-center gap-0.5 px-3 pt-2">
          <button
            className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors hover:opacity-80"
            style={{ color: P.dim }}
            title="Attach file"
            onClick={() => fileInputRef.current?.click()}
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

        {/* Pending uploads preview */}
        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-1">
            {uploads.map(upload => (
              <UploadPreview key={upload.id} upload={upload} onRemove={removeUpload} />
            ))}
          </div>
        )}

        {/* Bottom row: textarea + emoji + send */}
        <div className="flex items-end gap-2 px-3 pb-2.5 pt-1">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
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
              disabled={!canSend || !user}
              className="h-8 w-8 rounded-xl flex items-center justify-center transition-all disabled:cursor-not-allowed"
              style={{
                background: canSend
                  ? `linear-gradient(135deg, ${P.primary}, ${accentColor})`
                  : P.bg,
                color: canSend ? P.text : P.dim,
                boxShadow: canSend ? `0 2px 8px ${accentColor}40` : 'none',
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

// ─── Upload Preview ──────────────────────────────────────────────────────────

function UploadPreview({ upload, onRemove }: { upload: PendingUpload; onRemove: (id: string) => void }) {
  const P = usePalette();
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const isImage = upload.file.type.startsWith('image/');

  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(upload.file);
    setThumbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [upload.file, isImage]);

  return (
    <div
      className="relative flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs"
      style={{ backgroundColor: P.bg, border: `1px solid ${P.border}` }}
    >
      {/* Thumbnail or file icon */}
      {isImage && thumbUrl ? (
        <img src={thumbUrl} alt="" className="w-8 h-8 rounded object-cover" />
      ) : (
        <svg className="w-6 h-6 shrink-0" fill="none" viewBox="0 0 24 24" stroke={P.muted} strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      )}

      {/* File info */}
      <div className="min-w-0 max-w-[120px]">
        <div className="truncate font-medium" style={{ color: P.text }}>{upload.file.name}</div>
        <div style={{ color: P.dim }}>
          {upload.status === 'uploading' && 'Uploading...'}
          {upload.status === 'done' && formatFileSize(upload.file.size)}
          {upload.status === 'error' && (
            <span style={{ color: P.danger }}>{upload.error || 'Failed'}</span>
          )}
        </div>
      </div>

      {/* Progress bar for uploading state */}
      {upload.status === 'uploading' && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-b-lg overflow-hidden">
          <div
            className="h-full transition-all animate-pulse"
            style={{ width: '60%', backgroundColor: P.primary }}
          />
        </div>
      )}

      {/* Remove button */}
      <button
        className="ml-1 shrink-0 rounded-full p-0.5 hover:opacity-80 transition-opacity"
        style={{ color: P.dim }}
        onClick={() => onRemove(upload.id)}
        title="Remove"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

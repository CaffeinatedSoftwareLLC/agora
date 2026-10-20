import { useState, useEffect, useRef } from 'react';
import type { Attachment } from '../../stores/messageStore';
import { getAuthHeaders } from '../../lib/api';
import { usePalette } from '../../theme';

/** Keyboard focus ring shared by every interactive attachment control. */
const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file in a message, with the tags the server's decision model gave it (when it tags files). */
export function FileAttachment({ attachment }: { attachment: Attachment }) {
  return (
    <>
      <AttachmentBody attachment={attachment} />
      {!attachment.deletedAt && <FileTags attachment={attachment} />}
    </>
  );
}

/** Tag chips under a file, and a warning when its text tries to instruct an AI reader. */
export function FileTags({ attachment }: { attachment: Pick<Attachment, 'tags' | 'tagging' | 'partial' | 'injectionWarning'> }) {
  const P = usePalette();
  const tags = attachment.tags ?? [];
  const busy = attachment.tagging === 'pending' || attachment.tagging === 'running';
  if (tags.length === 0 && !attachment.injectionWarning && !busy) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]" style={{ color: P.muted }}>
      {tags.map(tag => (
        <span key={tag} className="px-1.5 py-0.5 rounded-full" style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.muted }}>
          {tag}
        </span>
      ))}
      {attachment.partial && tags.length > 0 && <span title="The file was longer than what was read">(partly read)</span>}
      {busy && <span>tagging…</span>}
      {attachment.injectionWarning && (
        <span style={{ color: P.warn }} title="A decision model judged that this file contains text addressed to an AI">
          ⚠ Contains text that tries to instruct an AI
        </span>
      )}
    </div>
  );
}

function AttachmentBody({ attachment }: { attachment: Attachment }) {
  const P = usePalette();
  const isImage = attachment.mime.startsWith('image/');

  if (attachment.deletedAt) {
    return <span className="text-[13px] italic" style={{ color: P.muted }}>[file deleted]</span>;
  }

  if (isImage) {
    return <ImageAttachment attachment={attachment} />;
  }

  if (attachment.mime.startsWith('audio/')) {
    return <MediaAttachment attachment={attachment} kind="audio" />;
  }

  // Formats browsers play natively (not .mov)
  if (attachment.mime === 'video/mp4' || attachment.mime === 'video/webm') {
    return <MediaAttachment attachment={attachment} kind="video" />;
  }

  return <FileCard attachment={attachment} />;
}

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const thumbRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    fetch(attachment.url, { headers: getAuthHeaders() })
      .then(r => r.blob())
      .then(blob => {
        if (!cancelled) {
          url = URL.createObjectURL(blob);
          setBlobUrl(url);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.url]);

  // The expanded view takes focus, closes on Escape, and hands focus back to the thumbnail.
  useEffect(() => {
    if (!expanded) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); };
    document.addEventListener('keydown', onKey);
    const thumb = thumbRef.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      thumb?.focus();
    };
  }, [expanded]);

  const maxWidth = 400;
  const maxHeight = 300;
  let displayWidth = attachment.width || maxWidth;
  let displayHeight = attachment.height || maxHeight;

  if (displayWidth > maxWidth) {
    displayHeight = Math.round(displayHeight * (maxWidth / displayWidth));
    displayWidth = maxWidth;
  }
  if (displayHeight > maxHeight) {
    displayWidth = Math.round(displayWidth * (maxHeight / displayHeight));
    displayHeight = maxHeight;
  }

  return (
    <>
      <button
        ref={thumbRef}
        type="button"
        className={`mt-1 block rounded-lg overflow-hidden cursor-pointer max-w-full p-0 ${FOCUS_RING}`}
        style={{ width: displayWidth, height: displayHeight, backgroundColor: 'rgba(0,0,0,0.1)' }}
        onClick={() => setExpanded(true)}
        aria-label={`Open image ${attachment.name}`}
      >
        {blobUrl && (
          <img
            src={blobUrl}
            alt={attachment.name}
            className="w-full h-full object-cover rounded-lg"
            loading="lazy"
          />
        )}
      </button>
      {expanded && blobUrl && (
        <button
          ref={closeRef}
          type="button"
          className={`fixed inset-0 bg-black/80 z-50 flex items-center justify-center cursor-pointer ${FOCUS_RING}`}
          onClick={() => setExpanded(false)}
          aria-label={`Close image ${attachment.name}`}
        >
          <img src={blobUrl} alt={attachment.name} className="max-w-[90vw] max-h-[90vh] object-contain" />
        </button>
      )}
    </>
  );
}

async function downloadAttachment(attachment: Attachment) {
  const res = await fetch(attachment.url, { headers: getAuthHeaders() });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.name;
  a.click();
  URL.revokeObjectURL(url);
}

function DownloadIcon({ color }: { color: string }) {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth="2" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

/** Inline audio/video player; the file is fetched (with auth) on first play, not on render. */
function MediaAttachment({ attachment, kind }: { attachment: Attachment; kind: 'audio' | 'video' }) {
  const P = usePalette();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(attachment.url, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error(String(res.status));
      setBlobUrl(URL.createObjectURL(await res.blob()));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  const download = (
    <button
      type="button"
      onClick={() => downloadAttachment(attachment)}
      className={`min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 flex items-center justify-center rounded-lg hover:opacity-80 shrink-0 ${FOCUS_RING}`}
      title={`Download ${attachment.name}`}
      aria-label={`Download ${attachment.name}`}
    >
      <DownloadIcon color={P.muted} />
    </button>
  );

  if (kind === 'video' && blobUrl) {
    return (
      <div className="mt-1 max-w-lg">
        <video controls autoPlay playsInline src={blobUrl} className="w-full max-h-96 rounded-lg bg-black" aria-label={attachment.name} />
        <div className="flex items-center gap-2 mt-0.5 text-[11px]" style={{ color: P.muted }}>
          <span className="truncate">{attachment.name} · {formatFileSize(attachment.size)}</span>
          <span className="ml-auto">{download}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1 max-w-md">
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
        style={{ backgroundColor: P.surface, border: `1px solid ${P.border}` }}
      >
        {blobUrl ? (
          <audio controls autoPlay src={blobUrl} className="flex-1 min-w-0 h-9" aria-label={attachment.name} />
        ) : (
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className={`flex flex-1 min-w-0 min-h-11 items-center gap-2.5 text-left rounded-lg hover:opacity-80 disabled:opacity-60 ${FOCUS_RING}`}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: P.primary }}>
              <svg className="w-4 h-4 ml-0.5" viewBox="0 0 24 24" fill={P.onPrimary} aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium truncate" style={{ color: P.primaryText }}>{loading ? 'Loading…' : attachment.name}</span>
              <span className="block text-[11px]" style={{ color: P.muted }}>{formatFileSize(attachment.size)}</span>
            </span>
          </button>
        )}
        {download}
      </div>
      {error && <span className="text-[11px] text-danger">Couldn't load the {kind}.</span>}
    </div>
  );
}

function FileCard({ attachment }: { attachment: Attachment }) {
  const P = usePalette();

  const handleDownload = () => downloadAttachment(attachment);

  return (
    <button
      type="button"
      className={`mt-1 flex w-full items-center gap-3 min-h-12 px-3 py-2 rounded-lg max-w-xs text-left cursor-pointer hover:opacity-80 ${FOCUS_RING}`}
      style={{ backgroundColor: P.surface, border: `1px solid ${P.border}` }}
      onClick={handleDownload}
      aria-label={`Download ${attachment.name}`}
      title={`Download ${attachment.name}`}
    >
      <div className="shrink-0">
        <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke={P.muted} strokeWidth="1.5" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate" style={{ color: P.primaryText }}>{attachment.name}</div>
        <div className="text-[11px]" style={{ color: P.muted }}>{formatFileSize(attachment.size)}</div>
      </div>
      <DownloadIcon color={P.muted} />
    </button>
  );
}

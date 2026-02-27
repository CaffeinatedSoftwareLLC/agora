import { useState, useEffect } from 'react';
import type { Attachment } from '../../stores/messageStore';
import { getAuthHeaders } from '../../lib/api';
import { usePalette } from '../../theme';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileAttachment({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.mime.startsWith('image/');

  if (attachment.deletedAt) {
    return <span className="text-sm italic" style={{ color: usePalette().dim }}>[file deleted]</span>;
  }

  if (isImage) {
    return <ImageAttachment attachment={attachment} />;
  }

  return <FileCard attachment={attachment} />;
}

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

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
      <div
        className="mt-1 rounded-lg overflow-hidden cursor-pointer inline-block"
        style={{ width: displayWidth, height: displayHeight, backgroundColor: 'rgba(0,0,0,0.1)' }}
        onClick={() => setExpanded(true)}
      >
        {blobUrl && (
          <img
            src={blobUrl}
            alt={attachment.name}
            className="w-full h-full object-cover rounded-lg"
            loading="lazy"
          />
        )}
      </div>
      {expanded && blobUrl && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center cursor-pointer"
          onClick={() => setExpanded(false)}
        >
          <img src={blobUrl} alt={attachment.name} className="max-w-[90vw] max-h-[90vh] object-contain" />
        </div>
      )}
    </>
  );
}

function FileCard({ attachment }: { attachment: Attachment }) {
  const P = usePalette();

  const handleDownload = async () => {
    const res = await fetch(attachment.url, { headers: getAuthHeaders() });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = attachment.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="mt-1 flex items-center gap-3 px-3 py-2 rounded-lg max-w-xs cursor-pointer hover:opacity-80"
      style={{ backgroundColor: P.surface, border: `1px solid ${P.border}` }}
      onClick={handleDownload}
    >
      <div className="shrink-0">
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke={P.muted} strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate" style={{ color: P.primary }}>{attachment.name}</div>
        <div className="text-xs" style={{ color: P.dim }}>{formatFileSize(attachment.size)}</div>
      </div>
      <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke={P.dim} strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
    </div>
  );
}

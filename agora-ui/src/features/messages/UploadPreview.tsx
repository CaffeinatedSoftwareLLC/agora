import { useEffect, useState } from 'react';
import type { PendingUpload } from '../../stores/uploadStore';
import { usePalette } from '../../theme';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadPreview({ upload, onRemove }: { upload: PendingUpload; onRemove: (id: string) => void }) {
  const P = usePalette();
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const isImage = upload.file.type.startsWith('image/');

  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(upload.file);
    // Object URLs are external resources tied to the selected File.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
        <div style={{ color: P.muted }}>
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
        type="button"
        className="ml-1 shrink-0 min-h-7 min-w-7 flex items-center justify-center rounded-full hover:opacity-80 transition-opacity"
        style={{ color: P.muted }}
        onClick={() => onRemove(upload.id)}
        title="Remove"
        aria-label="Remove attachment"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

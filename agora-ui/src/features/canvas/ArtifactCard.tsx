import type { ArtifactRef } from '../../lib/contracts/ws-events';
import { useUIStore } from '../../stores/uiStore';
import { usePalette } from '../../theme';
import { KIND_LABELS } from './frame';

/** A canvas artifact carried by a message: opens it in the canvas pane. */
export function ArtifactCard({ artifact, channelId }: { artifact: ArtifactRef; channelId: string }) {
  const P = usePalette();
  const openCanvas = useUIStore(s => s.openCanvas);
  const newer = artifact.latestVersion > artifact.version;
  return (
    <button
      type="button"
      // The newest version follows later edits; an older one stays on its own version
      onClick={() => openCanvas({ channelId, artifactId: artifact.id, version: newer ? artifact.version : null })}
      className="mt-1 flex w-full max-w-[420px] items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:brightness-110 min-h-11"
      style={{ background: P.surface, border: `1px solid ${P.border}` }}
      aria-label={`Open ${artifact.title} in the canvas`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: `${P.accent}1f`, color: P.accent }}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold" style={{ color: P.text }}>{artifact.title}</span>
        <span className="block text-[12px]" style={{ color: P.muted }}>
          {KIND_LABELS[artifact.kind]} · v{artifact.version}{newer ? ` of ${artifact.latestVersion}` : ''}
        </span>
      </span>
      <span className="shrink-0 text-[13px] font-semibold" style={{ color: P.primaryText }}>Open</span>
    </button>
  );
}

import { useTracks } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { usePalette } from '../../theme';

/**
 * Phase 2 placeholder: Video grid for camera feeds and screen shares.
 */
export function VideoGrid() {
  const P = usePalette();
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare]);

  if (tracks.length === 0) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{ background: P.bg }}
      >
        <div className="text-center">
          <div className="text-sm" style={{ color: P.dim }}>
            No video feeds active
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 grid gap-2 p-4 auto-rows-fr"
      style={{
        background: P.bg,
        gridTemplateColumns: tracks.length === 1 ? '1fr' : 'repeat(auto-fit, minmax(320px, 1fr))',
      }}
    >
      {tracks.map(track => (
        <div
          key={track.publication?.trackSid ?? `${track.participant.identity}-${track.source}`}
          className="rounded-xl overflow-hidden flex items-center justify-center"
          style={{ background: P.surface }}
        >
          <div className="text-sm" style={{ color: P.muted }}>
            {track.participant.name || track.participant.identity}
            {track.source === Track.Source.ScreenShare && ' (Screen)'}
          </div>
        </div>
      ))}
    </div>
  );
}

import { useTracks, VideoTrack } from '@livekit/components-react';
import type { TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { usePalette } from '../../theme';
import type { Palette } from '../../theme';

export function VideoGrid() {
  const P = usePalette();
  const cameraTracks = useTracks([Track.Source.Camera]);
  const screenShareTracks = useTracks([Track.Source.ScreenShare]);

  if (cameraTracks.length === 0 && screenShareTracks.length === 0) {
    return null;
  }

  const hasScreenShare = screenShareTracks.length > 0;

  if (hasScreenShare) {
    const mainTrack = screenShareTracks[0];
    return (
      <div className="flex-1 flex flex-col gap-2 p-4" style={{ background: P.bg }}>
        {/* Main screen share area */}
        <div
          className="flex-1 rounded-xl overflow-hidden relative"
          style={{ background: P.surface }}
        >
          <VideoTrack trackRef={mainTrack} style={{ objectFit: 'contain', width: '100%', height: '100%' }} />
          <div
            className="absolute bottom-2 left-2 px-2 py-1 rounded-md text-[11px]"
            style={{ background: `${P.bg}cc`, color: P.text }}
          >
            {mainTrack.participant.name || mainTrack.participant.identity} (Screen)
          </div>
        </div>

        {/* Camera strip below */}
        {cameraTracks.length > 0 && (
          <div className="flex gap-2 h-32 shrink-0">
            {cameraTracks.map(track => (
              <VideoTile key={track.publication?.trackSid ?? `${track.participant.identity}-${track.source}`} track={track} palette={P} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Camera-only grid layout
  const cols = cameraTracks.length === 1
    ? '1fr'
    : cameraTracks.length <= 4
      ? 'repeat(2, 1fr)'
      : 'repeat(auto-fit, minmax(280px, 1fr))';

  return (
    <div
      className="flex-1 grid gap-2 p-4 auto-rows-fr"
      style={{ background: P.bg, gridTemplateColumns: cols }}
    >
      {cameraTracks.map(track => (
        <VideoTile key={track.publication?.trackSid ?? `${track.participant.identity}-${track.source}`} track={track} palette={P} />
      ))}
    </div>
  );
}

function VideoTile({ track, palette: P }: { track: TrackReferenceOrPlaceholder; palette: Palette }) {
  return (
    <div
      className="rounded-xl overflow-hidden relative flex items-center justify-center"
      style={{ background: P.surface }}
    >
      <VideoTrack trackRef={track} style={{ objectFit: 'cover', width: '100%', height: '100%' }} />
      <div
        className="absolute bottom-2 left-2 px-2 py-1 rounded-md text-[11px]"
        style={{ background: `${P.bg}cc`, color: P.text }}
      >
        {track.participant.name || track.participant.identity}
      </div>
    </div>
  );
}

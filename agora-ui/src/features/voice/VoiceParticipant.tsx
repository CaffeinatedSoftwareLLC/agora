import { useIsSpeaking } from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import { usePalette, hexToRgb } from '../../theme';

interface VoiceParticipantProps {
  participant: Participant;
  onContextMenu?: (e: React.MouseEvent, participant: Participant) => void;
}

export function VoiceParticipant({ participant, onContextMenu }: VoiceParticipantProps) {
  const P = usePalette();
  const isSpeaking = useIsSpeaking(participant);
  const isMuted = !participant.isMicrophoneEnabled;
  const displayName = participant.name || participant.identity || 'Unknown';
  const initial = displayName[0]?.toUpperCase() ?? '?';
  const onlineRgb = hexToRgb(P.online);

  return (
    <div
      className="flex items-center gap-2 px-2 py-1 rounded-md"
      style={{
        background: isSpeaking ? `rgba(${onlineRgb}, 0.08)` : 'transparent',
      }}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, participant); } : undefined}
    >
      {/* Avatar */}
      <div className="relative shrink-0">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-shadow"
          style={{
            background: P.surfaceHover,
            color: P.text,
            boxShadow: isSpeaking ? `0 0 0 2px ${P.online}` : 'none',
          }}
        >
          {initial}
        </div>
      </div>

      {/* Name */}
      <span
        className="text-[12px] truncate flex-1"
        style={{ color: isMuted ? P.dim : P.muted }}
      >
        {displayName}
      </span>

      {/* Muted indicator */}
      {isMuted && (
        <svg
          className="h-3 w-3 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: P.danger }}
        >
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6" />
          <path d="M17 16.95A7 7 0 015 12v-2m14 0v2c0 .84-.15 1.65-.42 2.4" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}

      {/* Camera indicator */}
      {participant.isCameraEnabled && (
        <svg
          className="h-3 w-3 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: P.accent }}
        >
          <title>Camera On</title>
          <path d="M23 7l-7 5 7 5V7z" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      )}

      {/* Screen share indicator */}
      {participant.isScreenShareEnabled && (
        <svg
          className="h-3 w-3 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: P.online }}
        >
          <title>Screen Sharing</title>
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )}
    </div>
  );
}

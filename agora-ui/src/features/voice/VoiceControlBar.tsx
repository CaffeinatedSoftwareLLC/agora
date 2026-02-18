import {
  useLocalParticipant,
  useRoomContext,
} from '@livekit/components-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { usePalette, hexToRgb } from '../../theme';

export function VoiceControlBar() {
  const P = usePalette();
  const currentChannel = useVoiceStore(s => s.currentChannel);
  const connectionState = useVoiceStore(s => s.connectionState);
  const leaveChannel = useVoiceStore(s => s.leaveChannel);

  if (!currentChannel || connectionState === 'disconnected') return null;

  return (
    <div
      className="px-2 pb-2 shrink-0"
      style={{ borderTop: `1px solid ${P.border}` }}
    >
      <div
        className="rounded-xl px-3 py-2.5"
        style={{ background: P.bg }}
      >
        {connectionState === 'connecting' ? (
          <ConnectingState />
        ) : (
          <ConnectedControls />
        )}
      </div>
    </div>
  );
}

function ConnectingState() {
  const P = usePalette();
  const currentChannel = useVoiceStore(s => s.currentChannel);
  const leaveChannel = useVoiceStore(s => s.leaveChannel);

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium" style={{ color: P.warn }}>
          Connecting...
        </div>
        <div className="text-[10px] truncate" style={{ color: P.dim }}>
          #{currentChannel?.channelName}
        </div>
      </div>
      <button
        onClick={leaveChannel}
        className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
        style={{ color: P.danger }}
        title="Cancel"
      >
        <PhoneOffIcon />
      </button>
    </div>
  );
}

function ConnectedControls() {
  const P = usePalette();
  const currentChannel = useVoiceStore(s => s.currentChannel);
  const leaveChannel = useVoiceStore(s => s.leaveChannel);
  const onlineRgb = hexToRgb(P.online);

  const { isMicrophoneEnabled, localParticipant } = useLocalParticipant();
  const room = useRoomContext();

  const toggleMic = async () => {
    await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
  };

  const handleDisconnect = () => {
    room.disconnect();
    leaveChannel();
  };

  return (
    <>
      {/* Status row */}
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: P.online, boxShadow: `0 0 6px rgba(${onlineRgb}, 0.5)` }}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium" style={{ color: P.online }}>
            Voice Connected
          </div>
          <div className="text-[10px] truncate" style={{ color: P.dim }}>
            #{currentChannel?.channelName}
          </div>
        </div>
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-1">
        {/* Mic toggle */}
        <button
          onClick={toggleMic}
          className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
          style={{
            color: isMicrophoneEnabled ? P.muted : P.danger,
            background: isMicrophoneEnabled ? 'transparent' : `rgba(${hexToRgb(P.danger)}, 0.15)`,
          }}
          title={isMicrophoneEnabled ? 'Mute' : 'Unmute'}
        >
          {isMicrophoneEnabled ? <MicIcon /> : <MicOffIcon />}
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Disconnect */}
        <button
          onClick={handleDisconnect}
          className="h-7 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-colors text-[11px] font-medium"
          style={{
            background: `rgba(${hexToRgb(P.danger)}, 0.15)`,
            color: P.danger,
          }}
          title="Disconnect"
        >
          <PhoneOffIcon />
        </button>
      </div>
    </>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────────

function MicIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
      <path d="M19 10v2a7 7 0 01-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6" />
      <path d="M17 16.95A7 7 0 015 12v-2m14 0v2c0 .84-.15 1.65-.42 2.4" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function PhoneOffIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7 2 2 0 011.72 2v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.42 19.42 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91" />
      <line x1="23" y1="1" x2="1" y2="23" />
    </svg>
  );
}

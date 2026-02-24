import { useRef, useEffect, useState, useCallback } from 'react';
import {
  useLocalParticipant,
  useRoomContext,
} from '@livekit/components-react';
import { Track, RoomEvent, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from 'livekit-client';
import { useVoiceStore } from '../../stores/voiceStore';
import { useCallStore } from '../../stores/callStore';
import { usePalette, hexToRgb } from '../../theme';
import { DeviceSelector } from './DeviceSelector';

export function VoiceControlBar() {
  const P = usePalette();
  const currentChannel = useVoiceStore(s => s.currentChannel);
  const connectionState = useVoiceStore(s => s.connectionState);

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
  const isDmCall = currentChannel?.serverId === '__dm_call__';

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium" style={{ color: P.warn }}>
          Connecting...
        </div>
        <div className="text-[10px] truncate" style={{ color: P.dim }}>
          {isDmCall ? `@${currentChannel?.channelName}` : `#${currentChannel?.channelName}`}
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
  const endCall = useCallStore(s => s.endCall);
  const onlineRgb = hexToRgb(P.online);
  const isDmCall = currentChannel?.serverId === '__dm_call__';

  const isDeafened = useVoiceStore(s => s.isDeafened);
  const setDeafened = useVoiceStore(s => s.setDeafened);

  const { isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled, localParticipant } = useLocalParticipant();
  const room = useRoomContext();

  const isDeafenedRef = useRef(isDeafened);
  useEffect(() => { isDeafenedRef.current = isDeafened; }, [isDeafened]);
  const [deviceSelectorOpen, setDeviceSelectorOpen] = useState(false);

  const toggleMic = async () => {
    await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
  };

  const toggleCamera = async () => {
    await localParticipant.setCameraEnabled(!isCameraEnabled);
  };

  const toggleScreenShare = async () => {
    await localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: true });
  };

  const toggleDeafen = useCallback(() => {
    const newState = !isDeafenedRef.current;
    isDeafenedRef.current = newState;
    setDeafened(newState);

    // Un/subscribe all remote audio tracks
    room.remoteParticipants.forEach((p: RemoteParticipant) => {
      p.audioTrackPublications.forEach((pub: RemoteTrackPublication) => {
        pub.setSubscribed(!newState);
      });
    });

    // Auto-mute when deafening (but never auto-unmute)
    if (newState && isMicrophoneEnabled) {
      localParticipant.setMicrophoneEnabled(false);
    }
  }, [room, isMicrophoneEnabled, localParticipant, setDeafened]);

  // Unsubscribe new audio tracks that arrive while deafened
  useEffect(() => {
    const handler = (track: RemoteTrack, publication: RemoteTrackPublication) => {
      if (isDeafenedRef.current && track.kind === Track.Kind.Audio) {
        publication.setSubscribed(false);
      }
    };
    room.on(RoomEvent.TrackSubscribed, handler);
    return () => { room.off(RoomEvent.TrackSubscribed, handler); };
  }, [room]);

  const handleDisconnect = () => {
    if (isDmCall) {
      endCall();
    } else {
      room.disconnect();
      leaveChannel();
    }
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
            {isDmCall ? 'In call' : 'Voice Connected'}
          </div>
          <div className="text-[10px] truncate" style={{ color: P.dim }}>
            {isDmCall ? `@${currentChannel?.channelName}` : `#${currentChannel?.channelName}`}
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

        {/* Deafen toggle */}
        <button
          onClick={toggleDeafen}
          className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
          style={{
            color: isDeafened ? P.danger : P.muted,
            background: isDeafened ? `rgba(${hexToRgb(P.danger)}, 0.15)` : 'transparent',
          }}
          title={isDeafened ? 'Undeafen' : 'Deafen'}
        >
          {isDeafened ? <HeadphoneOffIcon /> : <HeadphoneIcon />}
        </button>

        {/* Camera toggle */}
        <button
          onClick={toggleCamera}
          className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
          style={{
            color: isCameraEnabled ? P.accent : P.muted,
            background: isCameraEnabled ? `rgba(${hexToRgb(P.accent)}, 0.15)` : 'transparent',
          }}
          title={isCameraEnabled ? 'Camera Off' : 'Camera On'}
        >
          {isCameraEnabled ? <CameraIcon /> : <CameraOffIcon />}
        </button>

        {/* Screen share toggle */}
        <button
          onClick={toggleScreenShare}
          className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
          style={{
            color: isScreenShareEnabled ? P.accent : P.muted,
            background: isScreenShareEnabled ? `rgba(${hexToRgb(P.accent)}, 0.15)` : 'transparent',
          }}
          title={isScreenShareEnabled ? 'Stop Sharing' : 'Share Screen'}
        >
          {isScreenShareEnabled ? <ScreenShareOffIcon /> : <ScreenShareIcon />}
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Device settings gear */}
        <div className="relative">
          <button
            onClick={() => setDeviceSelectorOpen(v => !v)}
            className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
            style={{ color: P.muted }}
            title="Audio/Video Settings"
          >
            <GearIcon />
          </button>
          <DeviceSelector isOpen={deviceSelectorOpen} onClose={() => setDeviceSelectorOpen(false)} />
        </div>

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

function HeadphoneIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 18v-6a9 9 0 0118 0v6" />
      <path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
    </svg>
  );
}

function HeadphoneOffIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 18v-6a9 9 0 0118 0v6" />
      <path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function CameraOffIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M21 21H3a2 2 0 01-2-2V8a2 2 0 012-2h3m3-3h6l2 3h4a2 2 0 012 2v9.34m-7.72-2.06a4 4 0 11-5.56-5.56" />
    </svg>
  );
}

function ScreenShareIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function ScreenShareOffIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
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

import { useCallback, useEffect, type ReactNode } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
} from '@livekit/components-react';
import { ConnectionState } from 'livekit-client';
import { useVoiceStore } from '../../stores/voiceStore';

export function VoiceChannelProvider({ children }: { children: ReactNode }) {
  const token = useVoiceStore(s => s.token);
  const livekitUrl = useVoiceStore(s => s.livekitUrl);
  const currentChannel = useVoiceStore(s => s.currentChannel);
  const leaveChannel = useVoiceStore(s => s.leaveChannel);

  const handleDisconnected = useCallback(() => {
    leaveChannel();
  }, [leaveChannel]);

  const handleError = useCallback(() => {
    leaveChannel();
  }, [leaveChannel]);

  // Only render LiveKitRoom when we have a token and URL
  if (!currentChannel || !token || !livekitUrl) {
    return <>{children}</>;
  }

  return (
    <LiveKitRoom
      serverUrl={livekitUrl}
      token={token}
      connect={true}
      audio={!!navigator.mediaDevices}
      video={false}
      onDisconnected={handleDisconnected}
      onError={handleError}
      style={{ display: 'contents' }}
    >
      <RoomAudioRenderer />
      <VoiceConnectionSync />
      {children}
    </LiveKitRoom>
  );
}

/**
 * Syncs LiveKit connection state to the voice store.
 * Must be rendered inside LiveKitRoom to access the room context.
 */
function VoiceConnectionSync() {
  const connectionState = useConnectionState();
  const setConnectionState = useVoiceStore(s => s.setConnectionState);

  useEffect(() => {
    if (connectionState === ConnectionState.Connected) {
      setConnectionState('connected');
    } else if (
      connectionState === ConnectionState.Connecting ||
      connectionState === ConnectionState.Reconnecting
    ) {
      setConnectionState('connecting');
    }
  }, [connectionState, setConnectionState]);

  return null;
}

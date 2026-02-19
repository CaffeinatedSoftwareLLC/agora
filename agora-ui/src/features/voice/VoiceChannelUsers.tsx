import { useParticipants } from '@livekit/components-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { VoiceParticipant } from './VoiceParticipant';
import { usePalette } from '../../theme';

interface VoiceChannelUsersProps {
  channelId: string;
}

/**
 * Shows LiveKit participants when the current user is in this voice channel,
 * otherwise shows participants from the voiceStore (populated via Socket.IO events).
 */
export function VoiceChannelUsers({ channelId }: VoiceChannelUsersProps) {
  const currentChannel = useVoiceStore(s => s.currentChannel);
  const connectionState = useVoiceStore(s => s.connectionState);
  const isInThisChannel = currentChannel?.channelId === channelId && connectionState === 'connected';

  if (isInThisChannel) {
    return <LiveParticipantList />;
  }

  return <StoreParticipantList channelId={channelId} />;
}

/** Shows participants from LiveKit room context (only available when connected to this channel) */
function LiveParticipantList() {
  const participants = useParticipants();

  if (participants.length === 0) return null;

  return (
    <div className="pl-4 pr-1 pb-1">
      {participants.map(p => (
        <VoiceParticipant key={p.identity} participant={p} />
      ))}
    </div>
  );
}

/** Shows participants from voiceStore for channels the user is not in */
function StoreParticipantList({ channelId }: { channelId: string }) {
  const P = usePalette();
  const participantsByChannel = useVoiceStore(s => s.participantsByChannel);
  const channelMap = participantsByChannel.get(channelId);

  if (!channelMap || channelMap.size === 0) return null;

  const participants = Array.from(channelMap.values());

  return (
    <div className="pl-4 pr-1 pb-1">
      {participants.map(p => (
        <div
          key={p.userId}
          className="flex items-center gap-2 px-2 py-1 rounded-md"
        >
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
            style={{ background: P.surfaceHover, color: P.text }}
          >
            {p.name[0]?.toUpperCase() ?? '?'}
          </div>
          <span className="text-[12px] truncate" style={{ color: P.muted }}>
            {p.name}
          </span>
        </div>
      ))}
    </div>
  );
}

import { useState, useRef, useCallback, useEffect } from 'react';
import { useParticipants } from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { VoiceParticipant } from './VoiceParticipant';
import { VoiceParticipantContextMenu } from './VoiceParticipantContextMenu';
import { useVoicePermissions } from './useVoicePermissions';
import { voiceApi } from '../../lib/api';
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
    return <LiveParticipantList channelId={channelId} />;
  }

  return <StoreParticipantList channelId={channelId} />;
}

interface ContextMenuState {
  x: number;
  y: number;
  participant: Participant;
}

/** Shows participants from LiveKit room context (only available when connected to this channel) */
function LiveParticipantList({ channelId }: { channelId: string }) {
  const participants = useParticipants();
  const permissions = useVoicePermissions(channelId);
  const currentUser = useAuthStore(s => s.user);
  const [menuState, setMenuState] = useState<ContextMenuState | null>(null);
  const [participantPerms, setParticipantPerms] = useState<Map<string, { canPublish: boolean; canSubscribe: boolean }>>(new Map());
  const fetchCounter = useRef(0);

  const fetchParticipantPerms = useCallback(async () => {
    const counter = ++fetchCounter.current;
    try {
      const data = await voiceApi.getParticipants(channelId);
      if (counter !== fetchCounter.current) return;
      const map = new Map<string, { canPublish: boolean; canSubscribe: boolean }>();
      for (const p of data) {
        if (p.permission) {
          map.set(p.identity, p.permission);
        }
      }
      setParticipantPerms(map);
    } catch {
      // ignore fetch errors — stale cache is still usable
    }
  }, [channelId]);

  // Fetch participant permissions on mount so the cache isn't empty on first right-click
  useEffect(() => { fetchParticipantPerms(); }, [fetchParticipantPerms]);

  const handleContextMenu = useCallback(async (e: React.MouseEvent, participant: Participant) => {
    const counter = ++fetchCounter.current;
    try {
      const data = await voiceApi.getParticipants(channelId);
      if (counter !== fetchCounter.current) return;
      const map = new Map<string, { canPublish: boolean; canSubscribe: boolean }>();
      for (const p of data) {
        if (p.permission) {
          map.set(p.identity, p.permission);
        }
      }
      setParticipantPerms(map);
    } catch {
      // Fetch failed — open menu anyway with existing cache (or conservative defaults)
    }
    if (counter !== fetchCounter.current) return;
    setMenuState({ x: e.clientX, y: e.clientY, participant });
  }, [channelId]);

  const handleClose = useCallback(() => setMenuState(null), []);

  const handleActionComplete = useCallback(() => {
    fetchParticipantPerms();
  }, [fetchParticipantPerms]);

  if (participants.length === 0) return null;

  const targetPerms = menuState
    ? participantPerms.get(menuState.participant.identity) ?? { canPublish: true, canSubscribe: true }
    : null;

  return (
    <div className="pl-4 pr-1 pb-1">
      {participants.map(p => (
        <VoiceParticipant
          key={p.identity}
          participant={p}
          onContextMenu={handleContextMenu}
        />
      ))}
      {menuState && targetPerms && currentUser && (
        <VoiceParticipantContextMenu
          x={menuState.x}
          y={menuState.y}
          channelId={channelId}
          targetUserId={menuState.participant.identity}
          targetName={menuState.participant.name || menuState.participant.identity}
          permissions={permissions}
          isSelf={menuState.participant.identity === currentUser.id}
          targetCanPublish={targetPerms.canPublish}
          targetCanSubscribe={targetPerms.canSubscribe}
          onClose={handleClose}
          onActionComplete={handleActionComplete}
        />
      )}
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

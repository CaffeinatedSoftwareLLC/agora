import { useEffect, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { createSocket } from '../../lib/socketFactory';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { useMessageStore } from '../../stores/messageStore';
import { useTypingStore } from '../../stores/typingStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useReactionStore } from '../../stores/reactionStore';
import { useVoiceStore } from '../../stores/voiceStore';
import type {
  ReadyPayload,
  MessagePayload,
  MessageUpdatePayload,
  MessageDeletePayload,
  TypingPayload,
  PresenceUpdatePayload,
  ReactionAddPayload,
  ReactionRemovePayload,
  DMCreatedPayload,
} from '../../lib/contracts/ws-events';
import { SocketContext } from './SocketContext';

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const token = useAuthStore(s => s.token);
  const logout = useAuthStore(s => s.logout);
  const setServers = useServerStore(s => s.setServers);
  const setChannels = useChannelStore(s => s.setChannels);
  const setConnectionStatus = useUIStore(s => s.setConnectionStatus);

  useEffect(() => {
    if (!token) return;

    const s = createSocket(token);

    s.on('connect', () => {
      setConnectionStatus('connected');
      setSocket(s);
    });

    s.on('disconnect', () => {
      setConnectionStatus('disconnected');
    });

    s.io.on('reconnect_attempt', () => {
      setConnectionStatus('reconnecting');
    });

    s.on('Ready', (data: ReadyPayload) => {
      // REPLACE all stores — idempotent, reconnect-safe
      setServers(data.servers);
      setChannels(data.channels);
      useMessageStore.getState().clear();
      useTypingStore.getState().clear();
      useReactionStore.getState().clear();
      useUnreadStore.getState().setUnreads(data.unreads || []);
      usePresenceStore.getState().setOnlineUsers(data.onlineUserIds || []);
    });

    s.on('Message', (data: MessagePayload) => {
      useMessageStore.getState().addMessage(data);
      const activeChannelId = useChannelStore.getState().activeChannelId;
      if (data.channelId !== activeChannelId) {
        useUnreadStore.getState().incrementUnread(data.channelId);
        // Check if current user is mentioned — increment mention count
        const currentUserId = useAuthStore.getState().user?.id;
        if (currentUserId) {
          const isMentioned = data.mentions?.includes(currentUserId) || data.mentionsEveryone;
          if (isMentioned) {
            useUnreadStore.getState().incrementMention(data.channelId);
          }
        }
      }
    });

    s.on('MessageUpdate', (data: MessageUpdatePayload) => {
      useMessageStore.getState().updateMessage(data);
    });

    s.on('MessageDelete', (data: MessageDeletePayload) => {
      useMessageStore.getState().removeMessage(data);
    });

    s.on('DMCreated', (data: DMCreatedPayload) => {
      useChannelStore.getState().addChannel({
        id: data.channelId,
        name: data.name,
        channelType: 1,
        serverId: null,
      });
    });

    s.on('Typing', (data: TypingPayload) => {
      useTypingStore.getState().addTyping(data.channelId, data.userId, data.username);
    });

    s.on('PresenceUpdate', (data: PresenceUpdatePayload) => {
      usePresenceStore.getState().setPresence(data.userId, data.status);
    });

    s.on('ReactionAdd', (data: ReactionAddPayload) => {
      const me = data.userId === useAuthStore.getState().user?.id;
      useReactionStore.getState().addReaction(data.messageId, data.emoji, data.userId, me);
    });

    s.on('ReactionRemove', (data: ReactionRemovePayload) => {
      const me = data.userId === useAuthStore.getState().user?.id;
      useReactionStore.getState().removeReaction(data.messageId, data.emoji, data.userId, me);
    });

    // Voice participant events (track for ALL channels, not just current)
    s.on('voice:participant_joined', (data: { channelId: string; userId: string; username: string }) => {
      useVoiceStore.getState().addParticipant(data.channelId, data.userId, data.username);
    });

    s.on('voice:participant_left', (data: { channelId: string; userId: string }) => {
      useVoiceStore.getState().removeParticipant(data.channelId, data.userId);
    });

    s.on('voice:room_finished', (data: { channelId: string }) => {
      useVoiceStore.getState().clearChannelParticipants(data.channelId);
    });

    s.on('connect_error', (err) => {
      const fatal = [
        'Invalid token',
        'Authentication required',
        'account_pending',
        'account_suspended',
      ];
      if (fatal.includes(err.message)) {
        logout();
      }
    });

    s.connect();

    return () => {
      s.removeAllListeners();
      s.io.removeAllListeners();
      s.disconnect();
      setSocket(null);
    };
  }, [token, logout, setServers, setChannels, setConnectionStatus]);

  return (
    <SocketContext.Provider value={socket}>
      {children}
    </SocketContext.Provider>
  );
}

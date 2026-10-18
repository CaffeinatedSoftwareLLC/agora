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
import { useThreadStore } from '../../stores/threadStore';
import type {
  ReadyPayload,
  MessagePayload,
  MessageUpdatePayload,
  MessageDeletePayload,
  TypingPayload,
  PresenceUpdatePayload,
  ThreadMetadataUpdatePayload,
  BotMessageStreamPayload,
} from '../../lib/contracts/ws-events';
import { SocketContext } from './SocketContext';

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const token = useAuthStore(s => s.token);
  const clearSession = useAuthStore(s => s.clearSession);
  const setServers = useServerStore(s => s.setServers);
  const setChannels = useChannelStore(s => s.setChannels);
  const setConnectionStatus = useUIStore(s => s.setConnectionStatus);

  useEffect(() => {
    if (!token) return;

    const s = createSocket(token);

    s.on('connect', () => {
      setConnectionStatus('connected');
      setSocket(s);
      // Signed in and connected: pick up the theme saved on this account (another device may have changed it)
      void useUIStore.getState().loadPreferences();
    });

    s.on('disconnect', () => {
      setConnectionStatus('disconnected');
    });

    s.io.on('reconnect_attempt', () => {
      setConnectionStatus('reconnecting');
    });

    s.on('Ready', (data: ReadyPayload) => {
      // REPLACE all stores — idempotent, reconnect-safe
      const { openThreadId, openThreadChannelId } = useThreadStore.getState();
      setServers(data.servers);
      setChannels(data.channels);
      useMessageStore.getState().clear();
      useThreadStore.getState().clear();
      useTypingStore.getState().clear();
      useUnreadStore.getState().setUnreads(data.unreads || []);
      usePresenceStore.getState().setOnlineUsers(data.onlineUserIds || []);

      // Every reconnect (a phone waking, a network change) sends Ready. The views only load
      // history when they mount, so reload what is on screen instead of leaving it blank.
      const activeChannelId = useChannelStore.getState().activeChannelId;
      if (activeChannelId && data.channels.some(c => c.id === activeChannelId)) {
        void useMessageStore.getState().loadMessages(activeChannelId);
      }
      if (openThreadId && openThreadChannelId && data.channels.some(c => c.id === openThreadChannelId)) {
        useThreadStore.getState().openThread(openThreadChannelId, openThreadId);
      }
    });

    s.on('Message', (data: MessagePayload) => {
      if (data.threadId) {
        // Thread reply — route to thread store
        useThreadStore.getState().addReply(data);
      } else {
        useMessageStore.getState().addMessage(data);
      }
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
      if (data.threadId) {
        useThreadStore.getState().updateReply(data);
      } else {
        useMessageStore.getState().updateMessage(data);
      }
    });

    s.on('MessageDelete', (data: MessageDeletePayload) => {
      if (data.threadId) {
        useThreadStore.getState().removeReply(data);
      } else {
        useMessageStore.getState().removeMessage(data);
      }
    });

    s.on('ThreadMetadataUpdate', (data: ThreadMetadataUpdatePayload) => {
      useMessageStore.getState().updateThreadMetadata(data.channelId, data.messageId, data.replyCount, data.lastReplyAt, data.threadClosedAt);
      useThreadStore.getState().updateParentMetadata(data);
    });

    s.on('BotMessageStream', (data: BotMessageStreamPayload) => {
      if (data.threadId) {
        useThreadStore.getState().streamUpdate(data.threadId, data.messageId, data.content, data.streaming, data.attachments);
      } else {
        useMessageStore.getState().streamUpdate(data.messageId, data.channelId, data.content, data.streaming, data.attachments);
      }
    });

    s.on('Typing', (data: TypingPayload) => {
      useTypingStore.getState().addTyping(data.channelId, data.userId, data.username);
    });

    s.on('PresenceUpdate', (data: PresenceUpdatePayload) => {
      usePresenceStore.getState().setPresence(data.userId, data.status);
    });

    s.on('connect_error', (err) => {
      const fatal = [
        'Invalid token',
        'Authentication required',
        'account_pending',
        'account_suspended',
        'Token revoked',
        'token_expired',
      ];
      if (fatal.includes(err.message)) {
        clearSession();
      }
    });

    s.on('error', (error: { code?: string }) => {
      if (['Token revoked', 'token_expired', 'account_suspended'].includes(error?.code ?? '')) clearSession();
    });

    s.connect();

    return () => {
      s.removeAllListeners();
      s.io.removeAllListeners();
      s.disconnect();
      setSocket(null);
    };
  }, [token, clearSession, setServers, setChannels, setConnectionStatus]);

  return (
    <SocketContext.Provider value={socket}>
      {children}
    </SocketContext.Provider>
  );
}

import { isFeedObscured } from './feedVisibility';
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
import { useAgentPresenceStore } from '../../stores/agentPresenceStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useThreadStore } from '../../stores/threadStore';
import { useFileMetadataStore } from '../../stores/fileMetadataStore';
import type {
  ReadyPayload,
  MessagePayload,
  MessageUpdatePayload,
  MessageDeletePayload,
  TypingPayload,
  PresenceUpdatePayload,
  AgentPresencePayload,
  ThreadMetadataUpdatePayload,
  BotMessageStreamPayload,
  FileAttachmentUpdatePayload,
} from '../../lib/contracts/ws-events';
import { SocketContext } from './SocketContext';
import { ChannelAvatars } from '../../components/ui/ChannelAvatars';
import { useVoiceStore } from '../voice/voiceStore';

/** A new message is on screen: in the open channel, or (a thread reply) in the open thread. */
function isOnScreen(channelId: string, threadId?: string): boolean {
  if (threadId) return useThreadStore.getState().openThreadId === threadId;
  return useChannelStore.getState().activeChannelId === channelId;
}

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  // Reconnect for each new sign-in (a different user, or the same one after signing out)
  const sessionUserId = useAuthStore(s => (s.status === 'authenticated' ? s.user?.id ?? null : null));
  const clearSession = useAuthStore(s => s.clearSession);
  const setServers = useServerStore(s => s.setServers);
  const setChannels = useChannelStore(s => s.setChannels);
  const setConnectionStatus = useUIStore(s => s.setConnectionStatus);

  useEffect(() => {
    if (!sessionUserId) return;

    const s = createSocket();

    s.on('connect', () => {
      useFileMetadataStore.getState().clear();
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
      useAgentPresenceStore.getState().setAll(data.agentPresence || []);

      // Every reconnect (a phone waking, a network change) sends Ready. The views only load
      // history when they mount, so reload what is on screen instead of leaving it blank.
      const activeChannelId = useChannelStore.getState().activeChannelId;
      if (activeChannelId && data.channels.some(c => c.id === activeChannelId)) {
        void useMessageStore.getState().loadMessages(activeChannelId);
        // The thread store was just cleared; the active-threads bar only loads on mount
        void useThreadStore.getState().loadActiveThreads(activeChannelId).catch(() => {});
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
      if (data.authorBot && !data.systemEvent && isOnScreen(data.channelId, data.threadId)) {
        useVoiceStore.getState().autoRead({ id: data.id, channelId: data.channelId, content: data.content });
      }
      const activeChannelId = useChannelStore.getState().activeChannelId;
      if (data.channelId !== activeChannelId || isFeedObscured()) {
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

    s.on('FileAttachmentUpdate', (data: FileAttachmentUpdatePayload) => {
      useMessageStore.getState().updateFileAttachment(data);
      useThreadStore.getState().updateFileAttachment(data);
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
      // The assistant streams its reply; read it once it is complete
      if (!data.streaming && isOnScreen(data.channelId, data.threadId)) {
        useVoiceStore.getState().autoRead({ id: data.messageId, channelId: data.channelId, content: data.content });
      }
    });

    s.on('Typing', (data: TypingPayload) => {
      useTypingStore.getState().addTyping(data.channelId, data.userId, data.username);
    });

    s.on('PresenceUpdate', (data: PresenceUpdatePayload) => {
      usePresenceStore.getState().setPresence(data.userId, data.status);
    });

    s.on('AgentPresence', (data: AgentPresencePayload) => {
      useAgentPresenceStore.getState().update(data);
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
      // The socket outlived the session it connected with, but the cookie may have
      // been renewed by activity since. Reconnecting sends the current cookie; if the
      // session really is over, the handshake fails and connect_error signs out.
      if (error?.code === 'session_renew') {
        setTimeout(() => { if (!s.connected) s.connect(); }, 0);
        return;
      }
      if (['Token revoked', 'token_expired', 'account_suspended'].includes(error?.code ?? '')) clearSession();
    });

    s.connect();

    return () => {
      s.removeAllListeners();
      s.io.removeAllListeners();
      s.disconnect();
      setSocket(null);
    };
  }, [sessionUserId, clearSession, setServers, setChannels, setConnectionStatus]);

  return (
    <SocketContext.Provider value={socket}>
      <ChannelAvatars>{children}</ChannelAvatars>
    </SocketContext.Provider>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { createSocket } from '../../lib/socketFactory';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import type { ReadyPayload, MessagePayload, MessageUpdatePayload, MessageDeletePayload, ServerJoinPayload } from '../../lib/contracts/ws-events';
import { useMessageStore } from '../../stores/messageStore';
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
    });

    s.on('Message', (data: MessagePayload) => {
      useMessageStore.getState().addMessage(data);
    });

    s.on('MessageUpdate', (data: MessageUpdatePayload) => {
      useMessageStore.getState().updateMessage(data);
    });

    s.on('MessageDelete', (data: MessageDeletePayload) => {
      useMessageStore.getState().removeMessage(data);
    });

    s.on('ServerJoin', (data: ServerJoinPayload) => {
      useServerStore.getState().addServer(data.server);
      useChannelStore.getState().addChannels(data.channels);
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

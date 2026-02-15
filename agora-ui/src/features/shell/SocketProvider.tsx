import { createContext, useEffect, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { createSocket } from '../../lib/socketFactory';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import type { ReadyPayload } from '../../lib/contracts/ws-events';

export const SocketContext = createContext<Socket | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const token = useAuthStore(s => s.token);
  const logout = useAuthStore(s => s.logout);
  const setServers = useServerStore(s => s.setServers);
  const setChannels = useChannelStore(s => s.setChannels);
  const setConnectionStatus = useUIStore(s => s.setConnectionStatus);

  useEffect(() => {
    if (!token) {
      setSocket(null);
      return;
    }

    const s = createSocket(token);

    s.on('connect', () => {
      setConnectionStatus('connected');
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
    setSocket(s);

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

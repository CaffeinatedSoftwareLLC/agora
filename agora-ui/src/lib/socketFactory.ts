import { io, type Socket } from 'socket.io-client';

export function createSocket(token: string): Socket {
  return io('/', {
    transports: ['websocket'],
    auth: { token },
    autoConnect: false,
  });
}

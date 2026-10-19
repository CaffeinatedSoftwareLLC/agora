import { io, type Socket } from 'socket.io-client';

// Same-origin: the handshake carries the httpOnly session cookie, which the gateway
// reads in place of a token.
export function createSocket(): Socket {
  return io('/', {
    transports: ['websocket'],
    withCredentials: true,
    autoConnect: false,
  });
}

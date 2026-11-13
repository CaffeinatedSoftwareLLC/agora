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

// The terminal's own connection (docs/box-terminal.md): the same cookie, plus a single-use ticket
// that names the box. Its own socket, so nothing the chat socket hears reaches the terminal page
// and nothing the terminal says reaches a chat room.
export function createShellSocket(ticket: string): Socket {
  return io('/', {
    transports: ['websocket'],
    withCredentials: true,
    autoConnect: false,
    reconnection: false,
    forceNew: true,
    auth: { type: 'shell', ticket },
  });
}

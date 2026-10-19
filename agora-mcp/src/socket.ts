import { io, type Socket } from 'socket.io-client';
import type { SocketLike } from './channel.js';

/**
 * The bot socket agora-mcp holds to Agora's gateway (src/gateway.ts). `mode` tells Agora
 * what kind of bring-your-own session this is, for the "connected / listening" state in
 * the UI (src/lib/agent-presence.ts):
 * - `channel`: the Claude Code Channel; listening while connected.
 * - `mcp`: the plain MCP server; listening while a chat_wait is open.
 *
 * socket.io-client reconnects on its own with backoff; nothing here throws if Agora is
 * unreachable, so the chat tools keep working over HTTP.
 */
export function connectSocket(instance: string, token: string, mode: 'channel' | 'mcp'): Socket {
    return io(instance, {
        transports: ['websocket'],
        auth: { type: 'bot', token, mode },
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 30_000,
    });
}

/**
 * Tells Agora when this agent is waiting for messages (chat_wait). Counts overlapping waits,
 * and repeats the state after a reconnect so the UI is right again.
 */
export class ListeningReporter {
    private waits = 0;
    private socket: SocketLike | null = null;

    /** The socket may come later than the tools: it is opened once stdio is up. */
    attach(socket: SocketLike): void {
        this.socket = socket;
        socket.on('connect', () => { if (this.waits > 0) socket.emit('Listening', { listening: true }); });
    }

    start(): void {
        if (this.waits++ === 0) this.socket?.emit('Listening', { listening: true });
    }

    stop(): void {
        if (this.waits === 0) return;
        if (--this.waits === 0) this.socket?.emit('Listening', { listening: false });
    }
}

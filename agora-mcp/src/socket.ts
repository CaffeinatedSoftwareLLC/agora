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

/** One live terminal session per channel, as Agora reported it after the socket connected. */
export interface TerminalSessionRef { channelId: string; sessionId: string }

/**
 * Terminal session state (#112, docs/agent-sessions.md "Terminal sessions"). Agora makes a
 * terminal session for this agent when the presence socket connects and answers with
 * `TerminalSession { sessions }`. This tells Agora whether the agent is working (calling
 * tools) or idle (waiting in chat_wait, or no tool call for `idleMs`), with the number of tool
 * calls it has seen. That is all agora-mcp can know: token use stays with the CLI ("n/a").
 */
export class ActivityReporter {
    private socket: SocketLike | null = null;
    private working = false;
    private toolCalls = 0;
    private active = 0;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSent = 0;
    sessions: TerminalSessionRef[] = [];

    constructor(private opts: { idleMs?: number; now?: () => number; minIntervalMs?: number } = {}) {}

    private get idleMs() { return this.opts.idleMs ?? 60_000; }
    private now() { return (this.opts.now ?? Date.now)(); }

    attach(socket: SocketLike): void {
        this.socket = socket;
        socket.on('TerminalSession', (data: { sessions?: TerminalSessionRef[] }) => {
            this.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
            // Agora made a fresh row after a reconnect: tell it where we are
            if (this.working || this.toolCalls > 0) this.send();
        });
    }

    /** A tool call started. chat_wait is not work: it means the agent is listening. */
    toolStart(name: string): void {
        if (name === 'chat_wait') { this.idle(); return; }
        this.active++;
        this.toolCalls++;
        this.clearIdle();
        if (!this.working) { this.working = true; this.send(); }
        else if (this.now() - this.lastSent >= (this.opts.minIntervalMs ?? 5_000)) this.send();
    }

    /** A tool call ended; with none left running, the agent counts as idle after idleMs. */
    toolEnd(name: string): void {
        if (name === 'chat_wait') return;
        this.active = Math.max(0, this.active - 1);
        if (this.active > 0) return;
        this.clearIdle();
        this.idleTimer = setTimeout(() => { this.idleTimer = null; this.idle(); }, this.idleMs);
        (this.idleTimer as { unref?: () => void }).unref?.();
    }

    /** Waiting for messages: idle now. */
    idle(): void {
        this.clearIdle();
        if (!this.working) return;
        this.working = false;
        this.send();
    }

    get state(): { working: boolean; toolCalls: number } {
        return { working: this.working, toolCalls: this.toolCalls };
    }

    private clearIdle() {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    }

    private send() {
        this.lastSent = this.now();
        this.socket?.emit('Activity', { working: this.working, toolCalls: this.toolCalls });
    }
}

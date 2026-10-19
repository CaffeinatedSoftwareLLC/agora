/**
 * Presence for agents that bring their own session (docs/claude-channel.md): a Claude Code,
 * Codex or Gemini session the user opened themselves, connected through agora-mcp.
 *
 * agora-mcp opens a bot socket and says which mode it runs in:
 * - `channel`: the Claude Code Channel, which pushes messages into the session. It is
 *   listening for as long as it is connected.
 * - `mcp`: the plain MCP server. It is listening while a `chat_wait` call is open (it sends
 *   `Listening { listening }` around each wait) and connected otherwise.
 *
 * In memory, per API process, like human presence (`onlineUsers` in gateway.ts).
 */

export type AgentPresenceStatus = 'offline' | 'connected' | 'listening';
export type AgentPresenceMode = 'channel' | 'mcp';

export interface AgentPresencePayload {
    userId: string;
    username: string;
    channelId: string;
    status: AgentPresenceStatus;
    mode: AgentPresenceMode | null;
}

interface Connection { mode: AgentPresenceMode; listening: boolean; channels: string[] }

export class AgentPresence {
    private sockets = new Map<string, Map<string, Connection>>();
    private names = new Map<string, string>();

    status(botId: string): { status: AgentPresenceStatus; mode: AgentPresenceMode | null } {
        const conns = [...(this.sockets.get(botId)?.values() ?? [])];
        if (conns.length === 0) return { status: 'offline', mode: null };
        const mode = conns.some(c => c.mode === 'channel') ? 'channel' : 'mcp';
        return { status: conns.some(c => c.listening) ? 'listening' : 'connected', mode };
    }

    /** Bots with at least one presence socket in this process. */
    bots(): string[] {
        return [...this.sockets.keys()];
    }

    /** A socket connected. Returns the events to broadcast (one per channel), if the status changed. */
    connect(botId: string, username: string, socketId: string, mode: AgentPresenceMode, channels: string[]): AgentPresencePayload[] {
        const before = this.status(botId);
        this.names.set(botId, username);
        const conns = this.sockets.get(botId) ?? new Map<string, Connection>();
        conns.set(socketId, { mode, listening: mode === 'channel', channels });
        this.sockets.set(botId, conns);
        return this.changed(botId, before, channels);
    }

    /** `chat_wait` started or ended on an mcp-mode socket. A channel socket is always listening. */
    setListening(botId: string, socketId: string, listening: boolean): AgentPresencePayload[] {
        const conn = this.sockets.get(botId)?.get(socketId);
        if (!conn || conn.mode === 'channel' || conn.listening === listening) return [];
        const before = this.status(botId);
        conn.listening = listening;
        return this.changed(botId, before, conn.channels);
    }

    disconnect(botId: string, socketId: string): AgentPresencePayload[] {
        const conns = this.sockets.get(botId);
        const conn = conns?.get(socketId);
        if (!conns || !conn) return [];
        const before = this.status(botId);
        conns.delete(socketId);
        if (conns.size === 0) this.sockets.delete(botId);
        // The channels of every remaining socket stay covered by their own status
        return this.changed(botId, before, conn.channels);
    }

    /** Every connected agent in these channels, for a human's Ready. */
    inChannels(channelIds: Iterable<string>): AgentPresencePayload[] {
        const wanted = new Set(channelIds);
        const out: AgentPresencePayload[] = [];
        for (const [botId, conns] of this.sockets) {
            const { status, mode } = this.status(botId);
            const channels = new Set([...conns.values()].flatMap(c => c.channels));
            for (const channelId of channels) {
                if (wanted.has(channelId)) out.push({ userId: botId, username: this.names.get(botId) ?? '', channelId, status, mode });
            }
        }
        return out;
    }

    private changed(botId: string, before: { status: AgentPresenceStatus; mode: AgentPresenceMode | null }, channels: string[]): AgentPresencePayload[] {
        const after = this.status(botId);
        if (after.status === before.status && after.mode === before.mode) return [];
        const username = this.names.get(botId) ?? '';
        return channels.map(channelId => ({ userId: botId, username, channelId, status: after.status, mode: after.mode }));
    }
}

export const agentPresence = new AgentPresence();

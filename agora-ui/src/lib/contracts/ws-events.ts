import type { Server, Channel } from './server';

export interface ReadyPayload {
  user: { id: string; username: string };
  servers: Server[];
  channels: Channel[];
  unreads: { channelId: string; lastReadId: string | null; mentionCount: number }[];
  onlineUserIds: string[];
  /** Bring-your-own-session agents connected now, per channel (older servers omit it). */
  agentPresence?: AgentPresencePayload[];
}

export interface MessageAttachmentPayload {
  id: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  deletedAt?: string;
}

/** Parsed agora-collab protocol header (server: src/lib/protocol.ts). */
export interface ProtocolInfo {
  version: 1;
  mode: 'plan' | 'review' | 'fix' | 'discuss';
  state: 'START' | 'ACK' | 'TURN' | 'CHECKPOINT' | 'DECIDE' | 'DONE' | 'BLOCK' | 'CANCEL';
  yieldTo?: string;
  decision?: 'AGREE' | 'BLOCK';
  participants?: string[];
}

/** A canvas artifact a message carries: one version of it (server: src/lib/artifacts.ts). */
export interface ArtifactRef {
  id: string;
  version: number;
  title: string;
  kind: 'html' | 'markdown' | 'mermaid' | 'svg';
  latestVersion: number;
}

export interface MessagePayload {
  id: string;
  content: string;
  authorId: string;
  authorUsername: string;
  authorBot?: boolean;
  authorAvatarUrl?: string | null;
  channelId: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  mentions?: string[];
  mentionsEveryone?: boolean;
  systemEvent?: string;
  attachments?: MessageAttachmentPayload[];
  artifact?: ArtifactRef;
  threadId?: string;
  replyCount?: number;
  lastReplyAt?: string;
  threadClosedAt?: string;
  protocol?: ProtocolInfo;
  /** Structured data for system messages (e.g. runtime approval / result cards). */
  systemData?: Record<string, unknown>;
}

export interface MessageUpdatePayload {
  id: string;
  channelId: string;
  content: string;
  editedAt: string;
  threadId?: string;
  protocol?: ProtocolInfo | null;
  systemData?: Record<string, unknown>;
  attachments?: MessageAttachmentPayload[];
}

export interface MessageDeletePayload {
  id: string;
  channelId: string;
  deletedAt: string;
  threadId?: string;
}

export interface ThreadMetadataUpdatePayload {
  channelId: string;
  messageId: string;
  replyCount: number;
  lastReplyAt: string | null;
  threadClosedAt?: string | null;
}

export interface ServerJoinPayload {
  server: Server;
  channels: Channel[];
}

export interface TypingPayload {
  channelId: string;
  userId: string;
  username: string;
}

/**
 * A bring-your-own-session agent (the user's own Claude Code, Codex or Gemini connected
 * through agora-mcp): `listening` = Claude Code Channel connected, or a chat_wait open;
 * `connected` = MCP server running, not waiting; `offline` = gone. Server:
 * src/lib/agent-presence.ts.
 */
export interface AgentPresencePayload {
  userId: string;
  username: string;
  channelId: string;
  status: 'offline' | 'connected' | 'listening';
  mode: 'channel' | 'mcp' | null;
}

export interface PresenceUpdatePayload {
  userId: string;
  status: 'online' | 'idle' | 'offline';
}


export interface BotMessageStreamPayload {
    messageId: string;
    channelId: string;
    content: string;
    streaming: boolean;
    /** Set when the streamed message is a thread reply. */
    threadId?: string;
    /** Files attached when the stream finishes (e.g. an audio overview). */
    attachments?: MessagePayload['attachments'];
}

/** A task card changed (docs/task-board.md); `card` is the board's full view of it. */
export interface TaskCardUpdatePayload {
  channelId: string;
  card: import('../../features/tasks/taskBoard').TaskCard;
}

export interface TaskCardDeletePayload {
  channelId: string;
  id: string;
}

/** What an ACP agent's run is doing now, from host heartbeats. Not stored; `step` is agent text. */
export interface AgentRunProgressPayload {
  channelId: string;
  sessionId: string;
  runId: string;
  step: string | null;
  toolCalls: number;
  planDone: number | null;
  planTotal: number | null;
}

export interface AgentSessionUpdatePayload {
  channelId: string;
  sessionId: string;
  /** 'terminal' (#112): running is what its agora-mcp last reported (working vs idle). */
  kind?: 'hosted' | 'terminal';
  running: boolean;
  /** Terminal sessions: tool calls agora-mcp has seen. */
  toolCalls?: number;
  state?: 'live' | 'shelved' | 'ended';
  endReason?: string | null;
  /** Set while the agent sleeps through a rate limit (#87). */
  sleepingUntil?: string | null;
  run?: import('../../features/agents/agentSessions').AgentRun | null;
}

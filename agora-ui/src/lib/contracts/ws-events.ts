import type { Server, Channel } from './server';

export interface ReadyPayload {
  user: { id: string; username: string };
  servers: Server[];
  channels: Channel[];
  unreads: { channelId: string; lastReadId: string | null; mentionCount: number }[];
  onlineUserIds: string[];
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

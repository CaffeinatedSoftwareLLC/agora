import type { Server, Channel } from './server';

export interface ReadyPayload {
  user: { id: string; username: string };
  servers: Server[];
  channels: Channel[];
  unreads: { channelId: string; lastReadId: string | null; mentionCount: number }[];
  onlineUserIds: string[];
}

export interface MessagePayload {
  id: string;
  content: string;
  authorId: string;
  authorUsername: string;
  channelId: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  mentions?: string[];
  mentionsEveryone?: boolean;
  reactions?: { emoji: string; count: number; me: boolean }[];
}

export interface MessageUpdatePayload {
  id: string;
  channelId: string;
  content: string;
  editedAt: string;
}

export interface MessageDeletePayload {
  id: string;
  channelId: string;
  deletedAt: string;
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

export interface ReactionAddPayload {
  messageId: string;
  channelId: string;
  userId: string;
  emoji: string;
}

export interface ReactionRemovePayload {
  messageId: string;
  channelId: string;
  userId: string;
  emoji: string;
}

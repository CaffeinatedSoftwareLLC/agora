import type { Server, Channel } from './server';

export interface ReadyPayload {
  user: { id: string; username: string };
  servers: Server[];
  channels: Channel[];
}

export interface MessagePayload {
  id: string;
  content: string;
  authorId: string;
  authorUsername: string;
  channelId: string;
  createdAt: string;
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

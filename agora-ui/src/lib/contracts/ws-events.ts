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
  reactions?: { emoji: string; count: number; me: boolean }[];
  systemEvent?: string;
  attachments?: MessageAttachmentPayload[];
  threadId?: string;
  replyCount?: number;
  lastReplyAt?: string;
}

export interface MessageUpdatePayload {
  id: string;
  channelId: string;
  content: string;
  editedAt: string;
  threadId?: string;
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

export interface DMCreatedPayload {
  channelId: string;
  name: string;
}

export interface CallIncomingPayload {
  callId: string;
  channelId: string;
  callerId: string;
  callerUsername: string;
  callType: 'voice' | 'video';
}

export interface CallAcceptedPayload { callId: string; }
export interface CallDeclinedPayload { callId: string; }
export interface CallCancelledPayload { callId: string; }
export interface CallTimeoutPayload { callId: string; }
export interface CallEndedPayload { callId: string; duration?: number; }

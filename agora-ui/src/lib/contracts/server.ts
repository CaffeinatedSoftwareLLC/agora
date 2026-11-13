export interface Server {
  id: string;
  name: string;
  ownerId: string;
}

export interface Channel {
  id: string;
  name: string;
  channelType: number;
  serverId: string | null;
  /** Channel loop guard: bot messages in a row before it stops them; null = off (the default). */
  maxBotHops?: number | null;
  /** Per-thread loop guard limit; null = off (the default). */
  maxThreadBotHops?: number | null;
}

export interface Member {
  id: string;
  username: string;
  joinedAt: string;
  roles: { id: string; name: string; position: number }[];
}

export interface CreateServerRequest {
  name: string;
}

export interface CreateServerResponse {
  id: string;
  name: string;
  ownerId: string;
  everyoneRoleId: string;
}

export interface CreateChannelRequest {
  name: string;
  channelType: number;
}

export interface InviteResponse {
  code: string;
}

export interface JoinServerResponse {
  serverId: string;
  userId: string;
}

export interface UserSearchResult {
  id: string;
  username: string;
}

export interface ServerAccess {
  permissions: string;
  isInstanceAdmin: boolean;
  hasModerationAccess: boolean;
  hasServerAdminAccess: boolean;
}

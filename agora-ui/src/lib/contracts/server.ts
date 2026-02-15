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

export interface CreateDMResponse {
  id: string;
  channelType: number;
}

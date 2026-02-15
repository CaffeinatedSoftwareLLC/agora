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

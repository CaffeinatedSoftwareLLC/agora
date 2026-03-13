export interface Role {
  id: string;
  name: string;
  color: string | null;
  hoist: boolean;
  position: number;
  /** Stringified bigint bitmask */
  permissions: string;
  mentionable: boolean;
  isEveryone: boolean;
  createdAt?: string;
}

export interface ChannelOverride {
  roleId?: string;
  roleName?: string;
  userId?: string;
  username?: string;
  /** Stringified bigint bitmask */
  allow: string;
  /** Stringified bigint bitmask */
  deny: string;
}

export interface ChannelOverrides {
  roles: ChannelOverride[];
  members: ChannelOverride[];
}

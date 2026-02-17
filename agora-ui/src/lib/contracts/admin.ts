import type { RegistrationPolicy } from './instance';

export interface AdminStats {
  totalUsers: number;
  pendingCount: number;
  serverCount: number;
}

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  accountStatus: 'active' | 'pending' | 'suspended';
  isInstanceAdmin: boolean;
  createdAt: string;
  lastIp?: string | null;
}

export interface PendingUser {
  id: string;
  username: string;
  email: string;
  createdAt: string;
}

export interface PaginatedUsers<T = AdminUser> {
  users: T[];
  total: number;
  page: number;
  limit: number;
}

export interface IpBanResponse {
  user: AdminUser;
  accountBanned: boolean;
  ipBanned: boolean;
}

export interface IpBan {
  id: string;
  ip: string | null;
  reason: string | null;
  bannedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface InstanceConfig {
  instanceName: string;
  registrationPolicy: RegistrationPolicy;
}

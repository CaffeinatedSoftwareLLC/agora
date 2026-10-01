import type { RegistrationPolicy } from './instance';

export interface AdminStats {
  totalUsers: number;
  pendingCount: number;
  serverCount: number;
}

export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  accountStatus: 'active' | 'pending' | 'suspended';
  isInstanceAdmin: boolean;
  createdAt: string;
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

export interface InstanceConfig {
  instanceName: string;
  registrationPolicy: RegistrationPolicy;
}

export interface FileSettings {
  'files.max_size_bytes'?: number;
  'files.allowed_extensions'?: string[];
  'files.retention_days'?: number | null;
  'files.storage_quota_bytes'?: number | null;
  'files.exif_strip'?: boolean;
}

export interface StorageStats {
  totalFiles: number;
  totalBytes: string;
  imageCount: number;
  imageBytes: string;
  expiringFiles: number;
  quotaBytes: string | null;
  quotaUsedPercent: number | null;
}

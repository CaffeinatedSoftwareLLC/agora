import type {
  CreateServerResponse,
  Channel,
  Member,
  InviteResponse,
  JoinServerResponse,
  UserSearchResult,
  CreateDMResponse,
  ServerAccess,
} from './contracts/server';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// Get token from auth store without circular import
let getToken: () => string | null = () => null;
export function setTokenGetter(fn: () => string | null) { getToken = fn; }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'unknown_error');
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export const serverApi = {
  createServer: (name: string) =>
    api.post<CreateServerResponse>('/servers', { name }),

  createChannel: (serverId: string, name: string, channelType: number) =>
    api.post<Channel>(`/servers/${serverId}/channels`, { name, channelType }),

  createInvite: (serverId: string) =>
    api.post<InviteResponse>(`/servers/${serverId}/invites`),

  joinServer: (code: string) =>
    api.post<JoinServerResponse>(`/invites/${code}`),

  getMembers: (serverId: string) =>
    api.get<Member[]>(`/servers/${serverId}/members`),

  getChannels: (serverId: string) =>
    api.get<Channel[]>(`/servers/${serverId}/channels`),

  getAccess: (serverId: string) =>
    api.get<ServerAccess>(`/servers/${serverId}/access`),
};

export const userApi = {
  searchUsers: (query: string) =>
    api.get<UserSearchResult[]>(`/users/search?q=${encodeURIComponent(query)}`),
};

export const dmApi = {
  createDM: (recipientId: string) =>
    api.post<CreateDMResponse>('/channels/dm', { recipientId }),
};

export interface VoicePermissions {
  canMuteMembers: boolean;
  canDeafenMembers: boolean;
  canMoveMembers: boolean;
}

export interface VoiceParticipantInfo {
  identity: string;
  name: string;
  permission?: { canPublish: boolean; canSubscribe: boolean };
}

export const callApi = {
  initiate: (channelId: string, callType: 'voice' | 'video') =>
    api.post<{ callId: string; token: string; url: string; callType: string }>('/calls/initiate', { channelId, callType }),
  accept: (callId: string) =>
    api.post<{ callId: string; token: string; url: string }>('/calls/accept', { callId }),
  decline: (callId: string) =>
    api.post<{ success: boolean }>('/calls/decline', { callId }),
  cancel: (callId: string) =>
    api.post<{ success: boolean }>('/calls/cancel', { callId }),
  end: (callId: string) =>
    api.post<{ success: boolean; duration: number }>('/calls/end', { callId }),
};

export async function uploadFile(channelId: string, file: File): Promise<{
  id: string; name: string; mime: string; size: number;
  width: number | null; height: number | null; url: string;
}> {
  const formData = new FormData();
  formData.append('channel_id', channelId);
  formData.append('file', file);

  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // DO NOT set Content-Type — browser sets it with boundary for FormData

  const res = await fetch('/files/upload', {
    method: 'POST',
    headers,
    body: formData,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'upload_failed');
  return data;
}

export function getAuthHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Bot Management API ───

export interface Bot {
  id: string;
  username: string;
  ownerId: string | null;
  createdAt: string;
  avatarUrl?: string | null;
}

export interface BotDetail extends Bot {
  canManageTokens: boolean;
  channels: { id: string; name: string; channelType: number }[];
}

export interface BotToken {
  id: string;
  name: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreateTokenResponse {
  tokenId: string;
  token: string;
  name: string | null;
}

export const botApi = {
  list: (serverId: string) =>
    api.get<Bot[]>(`/servers/${serverId}/bots`),

  get: (serverId: string, botId: string) =>
    api.get<BotDetail>(`/servers/${serverId}/bots/${botId}`),

  create: (serverId: string, username: string) =>
    api.post<Bot & { bot: true; serverId: string }>(`/servers/${serverId}/bots`, { username }),

  update: (serverId: string, botId: string, data: { username?: string; avatarUrl?: string | null }) =>
    api.patch<{ id: string; username: string; avatarUrl: string | null }>(`/servers/${serverId}/bots/${botId}`, data),

  remove: (serverId: string, botId: string) =>
    api.delete<{ deleted: true }>(`/servers/${serverId}/bots/${botId}`),

  createToken: (serverId: string, botId: string, name?: string) =>
    api.post<CreateTokenResponse>(`/servers/${serverId}/bots/${botId}/tokens`, { name }),

  listTokens: (serverId: string, botId: string) =>
    api.get<BotToken[]>(`/servers/${serverId}/bots/${botId}/tokens`),

  revokeToken: (serverId: string, botId: string, tokenId: string) =>
    api.delete<{ revoked: true }>(`/servers/${serverId}/bots/${botId}/tokens/${tokenId}`),

  grantChannel: (channelId: string, botId: string) =>
    api.post<{ botId: string; channelId: string }>(`/channels/${channelId}/bots/${botId}`),

  revokeChannel: (channelId: string, botId: string) =>
    api.delete<{ removed: true }>(`/channels/${channelId}/bots/${botId}`),

  updateChannelBotConfig: (channelId: string, data: { maxBotHops: number }) =>
    api.patch<{ channelId: string; maxBotHops: number }>(`/channels/${channelId}/bot-config`, data),
};

// ─── AI Config API ───

export interface AIConfig {
  configured: boolean;
  provider?: string;
  model?: string;
  botId?: string | null;
  systemPrompt?: string | null;
  maxContext?: number;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AIUsageStats {
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_latency_ms: number;
  error_count: number;
}

export const aiApi = {
  getConfig: (serverId: string) =>
    api.get<AIConfig>(`/servers/${serverId}/ai-config`),

  updateConfig: (serverId: string, data: { provider: string; model: string; apiKey: string; systemPrompt?: string | null; maxContext?: number }) =>
    api.put<AIConfig>(`/servers/${serverId}/ai-config`, data),

  patchConfig: (serverId: string, data: { enabled: boolean }) =>
    api.patch<{ enabled: boolean }>(`/servers/${serverId}/ai-config`, data),

  testConnection: (serverId: string, data: { provider: string; model: string; apiKey: string }) =>
    api.post<{ ok: boolean; error?: string }>(`/servers/${serverId}/ai-config/test`, data),

  getUsage: (serverId: string, days?: number) =>
    api.get<AIUsageStats>(`/servers/${serverId}/ai-config/usage${days ? `?days=${days}` : ''}`),
};

export const voiceApi = {
  getToken: (channelId: string) =>
    api.post<{ token: string; url: string }>('/voice/token', { channelId }),

  getParticipants: (channelId: string) =>
    api.get<VoiceParticipantInfo[]>(`/voice/participants/${channelId}`),

  kick: (channelId: string, userId: string) =>
    api.post('/voice/kick', { channelId, userId }),

  mute: (channelId: string, userId: string) =>
    api.post('/voice/mute', { channelId, userId }),

  unmute: (channelId: string, userId: string) =>
    api.post('/voice/unmute', { channelId, userId }),

  deafen: (channelId: string, userId: string) =>
    api.post('/voice/deafen', { channelId, userId }),

  undeafen: (channelId: string, userId: string) =>
    api.post('/voice/undeafen', { channelId, userId }),

  getPermissions: (channelId: string) =>
    api.get<VoicePermissions>(`/voice/permissions/${channelId}`),
};

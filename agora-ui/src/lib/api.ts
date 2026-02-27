import type {
  CreateServerResponse,
  Channel,
  Member,
  InviteResponse,
  JoinServerResponse,
  UserSearchResult,
  CreateDMResponse,
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

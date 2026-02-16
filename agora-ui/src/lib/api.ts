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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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

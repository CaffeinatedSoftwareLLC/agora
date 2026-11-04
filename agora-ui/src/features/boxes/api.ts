import { api } from '../../lib/api';

/**
 * Agent box owner API (docs/agent-boxes.md; server: src/routes/boxes.ts). Members may list
 * boxes; everything else is the server owner's, and the server enforces that.
 */

export type BoxAdapter = 'claude' | 'codex';
export type BoxAuth = 'subscription' | 'api_key';
export type BoxState = 'creating' | 'running' | 'stopped' | 'failed' | 'deleted';
export type BoxDesiredState = 'running' | 'stopped' | 'deleted';
export type BoxPendingAction = 'restart' | 'rebuild' | 'reset';
export type BoxLoginState = 'none' | 'pending' | 'logged_in' | 'failed';
export type BoxAction = 'start' | 'stop' | 'restart' | 'rebuild' | 'reset';

export interface BoxPolicy { channelId: string; autoPush: boolean; autoPr: boolean }

export interface Box {
  id: string;
  name: string;
  adapter: BoxAdapter;
  auth: BoxAuth;
  state: BoxState;
  desiredState: BoxDesiredState;
  pendingAction: BoxPendingAction | null;
  generation: number;
  imageVersion: number | null;
  loginState: BoxLoginState;
  homeChannelId: string | null;
  allowedDomains: string[];
  repos: string[];
  cpus: number;
  memoryMb: number;
  pids: number;
  lastError: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  deletedAt: string | null;
  volumePurgeAfter: string | null;
  policies: BoxPolicy[];
}

export interface CreateBoxBody {
  name: string;
  adapter: BoxAdapter;
  auth?: BoxAuth;
  apiKey?: string;
  homeChannelId: string;
  repos?: string[];
}

export interface BoxPatch {
  allowedDomains?: string[];
  repos?: string[];
  cpus?: number;
  memoryMb?: number;
  pids?: number;
  homeChannelId?: string;
}

export type LoginStatus = 'requested' | 'claimed' | 'awaiting_user' | 'awaiting_code' | 'code_sent' | 'succeeded' | 'failed' | 'expired' | 'cancelled';

export interface BoxLogin {
  id: string;
  status: LoginStatus;
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  expiresAt: string | null;
}

export interface GithubCredential { set: boolean; accountLogin: string | null; setAt: string | null }

export type EdgeDecision = 'allow' | 'deny' | 'always';

export const boxApi = {
  list: (serverId: string) => api.get<{ boxes: Box[] }>(`/servers/${serverId}/boxes`),
  create: (serverId: string, body: CreateBoxBody) => api.post<{ box: Box }>(`/servers/${serverId}/boxes`, body),
  update: (boxId: string, body: BoxPatch) => api.patch<{ box?: Box }>(`/boxes/${boxId}`, body),
  action: (boxId: string, action: BoxAction, confirm?: string) =>
  api.post<unknown>(`/boxes/${boxId}/actions`, confirm === undefined ? { action } : { action, confirm }),
  remove: (boxId: string) => api.delete<unknown>(`/boxes/${boxId}`),
  restore: (boxId: string) => api.post<unknown>(`/boxes/${boxId}/restore`),
  purge: (boxId: string) => api.post<unknown>(`/boxes/${boxId}/purge`),
  setPolicy: (boxId: string, channelId: string, policy: { autoPush: boolean; autoPr: boolean }) =>
  api.put<unknown>(`/boxes/${boxId}/policies/${channelId}`, policy),

  startLogin: (boxId: string) => api.post<{ login: BoxLogin }>(`/boxes/${boxId}/login`),
  getLogin: (boxId: string) => api.get<{ login: BoxLogin | null }>(`/boxes/${boxId}/login`),
  sendLoginCode: (boxId: string, code: string) => api.post<unknown>(`/boxes/${boxId}/login/code`, { code }),
  cancelLogin: (boxId: string) => api.delete<unknown>(`/boxes/${boxId}/login`),

  decideEdgeRequest: (requestId: string, decision: EdgeDecision) =>
  api.post<{ status: string }>(`/box-edge-requests/${requestId}`, { decision }),

  getGithub: (serverId: string) => api.get<GithubCredential>(`/servers/${serverId}/github-credential`),
  setGithub: (serverId: string, token: string) => api.put<{ accountLogin: string | null }>(`/servers/${serverId}/github-credential`, { token }),
  removeGithub: (serverId: string) => api.delete<unknown>(`/servers/${serverId}/github-credential`),

  previewProblemReport: () => api.post<{ report: string }>('/admin/problem-report/preview'),
  sendProblemReport: (report: string) => api.post<{ reportId: string }>('/admin/problem-report/send', { report }),
};

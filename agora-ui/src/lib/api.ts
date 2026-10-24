import type {
  CreateServerResponse,
  Channel,
  Member,
  InviteResponse,
  JoinServerResponse,
  UserSearchResult,
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

// The session is an httpOnly cookie the browser sends by itself (same-origin requests).
// State-changing requests echo the readable agora_csrf cookie in X-CSRF-Token, which
// the API checks against the session. X-Agora-Session asks login/register/setup to
// set the cookies instead of returning the token in the body.
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

let backgroundDepth = 0;

/**
 * Run requests the UI makes on its own (polling, refreshes on a timer) as background
 * requests. They carry X-Agora-Background, so the server does not count them as
 * activity: the 24 h idle timeout is not reset by a tab left open. Headers are built
 * synchronously when a request starts, so requests started inside `fn` are covered.
 */
export function inBackground<T>(fn: () => Promise<T>): Promise<T> {
  backgroundDepth++;
  try { return fn(); } finally { backgroundDepth--; }
}

/** Headers every API request from the UI carries. */
export function sessionHeaders(method: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Agora-Session': 'cookie' };
  if (backgroundDepth > 0) headers['X-Agora-Background'] = '1';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    const csrf = readCookie('agora_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  return headers;
}

/** For plain fetch() GETs (file downloads): the session cookie goes along by itself. */
export function getAuthHeaders(): Record<string, string> {
  return sessionHeaders('GET');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = sessionHeaders(method);
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const gatewayError = res.status === 504
      ? 'The server did not answer in time. Try again.'
      : [502, 503].includes(res.status) ? 'The server is temporarily unavailable. Try again in a few seconds.' : 'unknown_error';
    throw new ApiError(res.status, (typeof data?.error === 'string' && data.error) || gatewayError);
  }
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


export async function uploadFile(channelId: string, file: File): Promise<{
  id: string; name: string; mime: string; size: number;
  width: number | null; height: number | null; url: string;
}> {
  const formData = new FormData();
  formData.append('channel_id', channelId);
  formData.append('file', file);

  // DO NOT set Content-Type — browser sets it with boundary for FormData
  const res = await fetch('/files/upload', {
    method: 'POST',
    headers: sessionHeaders('POST'),
    credentials: 'same-origin',
    body: formData,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'upload_failed');
  return data;
}


// ─── Bot Management API ───

export interface Bot {
  id: string;
  username: string;
  ownerId: string | null;
  createdAt: string;
  avatarUrl?: string | null;
  /** Set while an admin has paused the bot (read-only). */
  pausedAt?: string | null;
  pausedReason?: string | null;
  runtimeAccess?: RuntimeAccess;
}

export interface BotDetail extends Bot {
  canManageTokens: boolean;
  /** canDirect: the bot may give agents instructions in that channel (set by the server owner) */
  channels: { id: string; name: string; channelType: number; canDirect?: boolean }[];
}

export interface ChannelAgent { id: string; username: string; inChannel: boolean }
export interface ChannelAgentPage { bots: ChannelAgent[]; hasMore: boolean; nextCursor: string | null }

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
  channelAgents: (channelId: string, options: { all?: boolean; query?: string; after?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.all) params.set('all', 'true');
    if (options.query) params.set('q', options.query);
    if (options.after) params.set('after', options.after);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return api.get<ChannelAgentPage>(`/channels/${channelId}/bots${query ? `?${query}` : ''}`);
  },
  list: (serverId: string) =>
    api.get<Bot[]>(`/servers/${serverId}/bots`),

  get: (serverId: string, botId: string) =>
    api.get<BotDetail>(`/servers/${serverId}/bots/${botId}`),

  setPaused: (serverId: string, botId: string, paused: boolean, reason?: string) =>
    api.patch<{ id: string; pausedAt: string | null; pausedReason: string | null }>(
      `/servers/${serverId}/bots/${botId}/pause`,
      reason ? { paused, reason } : { paused },
    ),

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

  /** Only the server owner may change this */
  setCanDirect: (channelId: string, botId: string, canDirect: boolean) =>
    api.put<{ botId: string; channelId: string; canDirect: boolean }>(`/channels/${channelId}/bots/${botId}/direct`, { canDirect }),

  updateChannelBotConfig: (channelId: string, data: { maxBotHops: number }) =>
    api.patch<{ channelId: string; maxBotHops: number }>(`/channels/${channelId}/bot-config`, data),
};

// ─── AI Config API ───

export interface AIConfig {
  configured: boolean;
  /** Legacy provider name ('claude' for Anthropic); prefer `adapter`. */
  provider?: string | null;
  adapter?: string | null;
  providerId?: string | null;
  model?: string | null;
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

export type AICapability = 'chat' | 'search' | 'image' | 'tts' | 'video' | 'decide' | 'stt';

export interface AIAdapter {
  id: string;
  label: string;
  capabilities: AICapability[];
  requiresApiKey: boolean;
  supportsBaseUrl: boolean;
  /** Needs an account ID besides the key (Cloudflare Workers AI). */
  requiresAccountId?: boolean;
  defaultBaseUrl: string;
  defaultModels: Partial<Record<AICapability, string>>;
  /** When set for a capability, the only valid "model" values (e.g. Tavily's search depths). */
  modelChoices?: Partial<Record<AICapability, string[]>>;
}

export interface AIProvider {
  id: string;
  adapter: string;
  label: string;
  baseUrl: string | null;
  /** Set for adapters that need one (Cloudflare). Not a secret. */
  accountId?: string | null;
  hasApiKey: boolean;
  enabled: boolean;
  capabilities: AICapability[];
  createdAt: string;
  updatedAt: string;
}

export interface AIRouteLimits {
  dailyRequestLimit: number | null;
  dailyTokenLimit: number | null;
  dailyCostLimitMicros: number | null;
  inputPriceMicrosPerMtok: number | null;
  outputPriceMicrosPerMtok: number | null;
}

export interface AIRoute extends AIRouteLimits {
  capability: AICapability;
  providerId: string;
  providerLabel: string;
  adapter: string;
  model: string;
  enabled: boolean;
  updatedAt: string;
}

export interface AICapabilityUsage {
  /** `model_agents`: every model agent's calls, on their own row. */
  capability: AICapability | 'model_agents';
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number | null;
  errors: number;
  today: { requests: number; tokens: number; costMicros: number | null };
}

export type AIConnectionResult = { ok: boolean; error?: string };

/** Tools a model agent can be given (src/ai/model-agent-tools.ts). */
export const MODEL_AGENT_TOOLS = [
  'read_history', 'post_message', 'file_search', 'file_read',
  'task_list', 'task_create', 'task_update', 'canvas_publish', 'runtime_exec',
] as const;
export type ModelAgentTool = typeof MODEL_AGENT_TOOLS[number];

/** A server-hosted model agent: its own bot, provider and model (docs/model-agents.md). */
export interface ModelAgent {
  id: string;
  botId: string;
  name: string;
  providerId: string;
  providerLabel: string;
  adapter: string;
  model: string;
  systemPrompt: string | null;
  tools: ModelAgentTool[];
  maxSteps: number;
  maxOutputTokens: number;
  dailyRequestLimit: number | null;
  dailyTokenLimit: number | null;
  dailyCostLimitMicros: number | null;
  inputPriceMicrosPerMtok: number | null;
  outputPriceMicrosPerMtok: number | null;
  enabled: boolean;
  runtimeAccess: 'none' | 'approval' | 'auto';
  channelCount: number;
  today: { requests: number; tokens: number; costMicros: number | null };
  createdAt: string;
  updatedAt: string;
}

/** How model agents are budgeted: with @assistant on the Chat route (`shared`), or in their own pool. */
export interface ModelAgentBudget {
  mode: 'shared' | 'separate';
  dailyRequestLimit: number | null;
  dailyTokenLimit: number | null;
  dailyCostLimitMicros: number | null;
  today: { requests: number; tokens: number; costMicros: number | null };
}

export interface ModelAgentInput {
  providerId?: string;
  model?: string;
  systemPrompt?: string | null;
  tools?: ModelAgentTool[];
  maxSteps?: number;
  maxOutputTokens?: number;
  dailyRequestLimit?: number | null;
  dailyTokenLimit?: number | null;
  dailyCostLimitMicros?: number | null;
  inputPriceMicrosPerMtok?: number | null;
  outputPriceMicrosPerMtok?: number | null;
  enabled?: boolean;
}

/** One audited change to the server's AI settings (providers, routes, assistant). */
export interface AIChange {
  id: string;
  action: 'ai_provider_create' | 'ai_provider_update' | 'ai_provider_delete' | 'ai_route_update' | 'ai_route_delete' | 'ai_assistant_update' | 'ai_decision_update' | 'ai_voice_update'
    | 'ai_tag_create' | 'ai_tag_update' | 'ai_tag_delete' | 'ai_tag_retag'
    | 'ai_agent_create' | 'ai_agent_update' | 'ai_agent_delete' | 'ai_agent_budget_update';
  targetType: string;
  targetId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form audit JSON, read field by field in ChangesSection
  changes: Record<string, any>;
  createdAt: string;
  actor: { id: string; username: string; bot: boolean } | null;
}

// ─── Voice in and out (docs/voice.md) ───

/** Where speech is turned into text (input) or text into speech (output) for a member. */
export type VoiceEngine = 'server' | 'browser' | 'off';

export interface AIVoiceSettings {
  voiceInputEnabled: boolean;
  /** Without a Transcription route: let browsers recognise speech themselves (Chrome/Safari send audio to Google/Apple). */
  browserSttFallback: boolean;
  maxRecordingSeconds: number;
  sttLanguage: string | null;
  readAloudEnabled: boolean;
  /** Read replies with the server's Speech route (also used by audio overviews). */
  readAloudServer: boolean;
  browserTtsFallback: boolean;
  readAloudVoice: string | null;
  readAloudMaxChars: number;
}

export type AIVoiceRouteState =
  | { configured: true; enabled: boolean; provider: string; adapter: string; model: string }
  | { configured: false; enabled: false; provider: null; adapter: null; model: null };

export interface AIVoiceView extends AIVoiceSettings {
  routes: { stt: AIVoiceRouteState; tts: AIVoiceRouteState };
  engines: { input: VoiceEngine; output: VoiceEngine };
  warnings: string[];
}

/** What a member's client uses in a channel. */
export interface ChannelVoice {
  input: VoiceEngine;
  output: VoiceEngine;
  maxRecordingSeconds: number;
  language: string | null;
  maxChars: number;
}

export const voiceApi = {
  getSettings: (serverId: string) =>
    api.get<AIVoiceView>(`/servers/${serverId}/ai/voice`),

  patchSettings: (serverId: string, data: Partial<AIVoiceSettings>) =>
    api.patch<AIVoiceView>(`/servers/${serverId}/ai/voice`, data),

  forChannel: (channelId: string) =>
    api.get<ChannelVoice>(`/channels/${channelId}/voice`),

  /** Send a recorded clip; the server passes it to its Transcription route. */
  transcribe: async (channelId: string, clip: Blob): Promise<string> => {
    const res = await fetch(`/channels/${channelId}/voice/transcribe`, {
      method: 'POST',
      headers: { ...sessionHeaders('POST'), 'Content-Type': clip.type || 'audio/webm' },
      credentials: 'same-origin',
      body: clip,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || 'transcription_failed');
    return data.text ?? '';
  },

  /** A message voiced by the server's Speech route (MP3). */
  speech: async (channelId: string, messageId: string): Promise<Blob> => {
    const res = await fetch(`/channels/${channelId}/messages/${messageId}/speech`, {
      method: 'POST',
      headers: sessionHeaders('POST'),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data.error || 'speech_failed');
    }
    return res.blob();
  },
};

/** What a decision model can be used for. Each is switched on separately. */
export type AIDecisionUse = 'routing' | 'search_screening' | 'file_tagging' | 'file_ranking';

export interface AIDecisionUseSettings {
  enabled: boolean;
  /** Percent of the decide capability's daily budget this use may spend; 0 switches it off. */
  sharePct: number;
  dailyRequests: number | null;
}

export interface AIDecisionSettings {
  uses: Record<AIDecisionUse, AIDecisionUseSettings>;
  routingMinConfidence: number;
  screeningFlagThreshold: number;
  screeningSuspectThreshold: number;
  screeningStrict: boolean;
  tagThreshold: number;
  /** The decide capability route, as configured under Capabilities. */
  route: { configured: boolean; enabled: boolean; provider: string | null; adapter: string | null; model: string | null };
  today: Record<AIDecisionUse, { requests: number; tokens: number; errors: number }>;
  warnings: string[];
}

export type AIDecisionSettingsPatch = Partial<Pick<AIDecisionSettings,
  'routingMinConfidence' | 'screeningFlagThreshold' | 'screeningSuspectThreshold' | 'screeningStrict' | 'tagThreshold'>> & {
  uses?: Partial<Record<AIDecisionUse, Partial<AIDecisionUseSettings>>>;
};

/** A file tag: a yes/no question a decision model answers about each uploaded text file. */
export interface AIFileTag {
  id: string;
  name: string;
  instructions: string;
  criteriaTrue: string | null;
  criteriaFalse: string | null;
  /** Goes up whenever the name, instructions or criteria change; older results are then stale. */
  revision: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AITaggingQueue {
  pending: number;
  running: number;
  done: number;
  skipped: number;
  failed: number;
  /** Tagged files whose results predate a tag change. */
  stale: number;
}

export type AIFileTagInput = { name: string; instructions: string; criteriaTrue?: string | null; criteriaFalse?: string | null; enabled?: boolean };

export interface FileSearchItem {
  trustedByOwner?: boolean;
  trustedBy?: string;
  trustedAt?: string;
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  messageId: string | null;
  uploadedAt: string;
  tags: { name: string; probability: number; stale?: true }[];
  tagging: 'none' | 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  partial: boolean;
  score: number;
  ranked: boolean;
  injectionWarning: boolean;
}

export interface FileSearchResult {
  query: string | null;
  tag: string | null;
  results: FileSearchItem[];
  ranking: { status: 'ranked' | 'coarse'; reason?: string; model?: string };
}

export const fileSearchApi = {
  /** Files in a channel, best match first; with no query, newest first. */
  search: (channelId: string, opts: { q?: string; tag?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.tag) params.set('tag', opts.tag);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return api.get<FileSearchResult>(`/channels/${channelId}/files/search${qs ? `?${qs}` : ''}`);
  },

  /** The tag names members can filter by. */
  tagNames: (serverId: string) =>
    api.get<{ id: string; name: string }[]>(`/servers/${serverId}/file-tags`),
};

/** A channel's project context and verify command (docs/project-context.md). */
export interface ChannelProject {
  channelId: string;
  instructions: string;
  version: number;
  files: { id: string; name: string; mime: string; size: number }[];
  verify: { command: string; maxRetries: number } | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** The viewer may change instructions and files (the owner and directors). */
  canEdit: boolean;
  /** The viewer may set the verify command (the server owner). */
  canEditVerify: boolean;
}

export const projectApi = {
  get: (channelId: string) => api.get<ChannelProject>(`/channels/${channelId}/project`),
  /** Either field may be left out; fileIds replaces the pinned list, in order. */
  update: (channelId: string, change: { instructions?: string; fileIds?: string[] }) =>
    api.put<ChannelProject>(`/channels/${channelId}/project`, change),
  /** command null turns verify off. */
  setVerify: (channelId: string, command: string | null, maxRetries?: number) =>
    api.put<ChannelProject>(`/channels/${channelId}/project/verify`, { command, ...(maxRetries === undefined ? {} : { maxRetries }) }),
};

export type ArtifactKind = 'html' | 'markdown' | 'mermaid' | 'svg';
export interface ArtifactSummary {
  id: string; title: string; kind: ArtifactKind; latestVersion: number | null;
  updatedAt: string; createdByUsername: string | null;
}
export interface ArtifactVersionInfo {
  version: number; messageId: string; threadId: string | null; authorUsername: string | null; authorBot: boolean;
  title: string; kind: ArtifactKind; size: number; createdAt: string;
}
export interface ArtifactDetail { id: string; title: string; kind: ArtifactKind; latestVersion: number | null; versions: ArtifactVersionInfo[] }
export interface ArtifactVersion { artifactId: string; version: number; title: string; kind: ArtifactKind; content: string; authorUsername: string | null; createdAt: string }

/** Canvas artifacts (docs/canvas-and-preview.md). Posting one goes through the message routes. */
export const canvasApi = {
  list: (channelId: string) => api.get<{ artifacts: ArtifactSummary[] }>(`/channels/${channelId}/artifacts?limit=50`),
  get: (channelId: string, artifactId: string) => api.get<ArtifactDetail>(`/channels/${channelId}/artifacts/${artifactId}`),
  version: (channelId: string, artifactId: string, version: number) =>
    api.get<ArtifactVersion>(`/channels/${channelId}/artifacts/${artifactId}/versions/${version}`),
};

export const aiApi = {
  listTags: (serverId: string) =>
    api.get<{ tags: AIFileTag[]; max: number; queue: AITaggingQueue }>(`/servers/${serverId}/ai/tags`),

  createTag: (serverId: string, data: AIFileTagInput) =>
    api.post<AIFileTag>(`/servers/${serverId}/ai/tags`, data),

  updateTag: (serverId: string, tagId: string, data: Partial<AIFileTagInput>) =>
    api.patch<AIFileTag>(`/servers/${serverId}/ai/tags/${tagId}`, data),

  deleteTag: (serverId: string, tagId: string) =>
    api.delete<{ deleted: true }>(`/servers/${serverId}/ai/tags/${tagId}`),

  retagFiles: (serverId: string, includeFailed = false) =>
    api.post<{ created: number; requeued: number; retried: number; queue: AITaggingQueue }>(`/servers/${serverId}/ai/tags/retag`, { includeFailed }),

  getDecisions: (serverId: string) =>
    api.get<AIDecisionSettings>(`/servers/${serverId}/ai/decisions`),

  patchDecisions: (serverId: string, data: AIDecisionSettingsPatch) =>
    api.patch<AIDecisionSettings>(`/servers/${serverId}/ai/decisions`, data),

  getConfig: (serverId: string) =>
    api.get<AIConfig>(`/servers/${serverId}/ai-config`),

  updateConfig: (serverId: string, data: { provider: string; model: string; apiKey: string; systemPrompt?: string | null; maxContext?: number }) =>
    api.put<AIConfig>(`/servers/${serverId}/ai-config`, data),

  patchConfig: (serverId: string, data: { enabled?: boolean; systemPrompt?: string | null; maxContext?: number }) =>
    api.patch<{ enabled: boolean; systemPrompt: string | null; maxContext: number }>(`/servers/${serverId}/ai-config`, data),

  createAssistant: (serverId: string) =>
    api.post<{ botId: string }>(`/servers/${serverId}/ai-config/assistant`),

  testConnection: (serverId: string, data: { provider: string; model: string; apiKey: string }) =>
    api.post<AIConnectionResult>(`/servers/${serverId}/ai-config/test`, data),

  getUsage: (serverId: string, days?: number) =>
    api.get<AIUsageStats>(`/servers/${serverId}/ai-config/usage${days ? `?days=${days}` : ''}`),

  // ─── Provider registry ───

  listAdapters: (serverId: string) =>
    api.get<AIAdapter[]>(`/servers/${serverId}/ai/adapters`),

  listProviders: (serverId: string) =>
    api.get<AIProvider[]>(`/servers/${serverId}/ai/providers`),

  createProvider: (serverId: string, data: { adapter: string; label?: string; apiKey?: string; baseUrl?: string | null; accountId?: string }) =>
    api.post<AIProvider>(`/servers/${serverId}/ai/providers`, data),

  updateProvider: (serverId: string, providerId: string, data: { label?: string; apiKey?: string | null; baseUrl?: string | null; accountId?: string; enabled?: boolean }) =>
    api.patch<AIProvider>(`/servers/${serverId}/ai/providers/${providerId}`, data),

  deleteProvider: (serverId: string, providerId: string) =>
    api.delete<{ deleted: true }>(`/servers/${serverId}/ai/providers/${providerId}`),

  testProvider: (serverId: string, providerId: string, model?: string, capability?: AICapability) =>
    api.post<AIConnectionResult>(`/servers/${serverId}/ai/providers/${providerId}/test`, {
      ...(model ? { model } : {}), ...(capability ? { capability } : {}),
    }),

  listRoutes: (serverId: string) =>
    api.get<AIRoute[]>(`/servers/${serverId}/ai/routes`),

  putRoute: (serverId: string, capability: AICapability, data: { providerId: string; model: string; enabled?: boolean } & Partial<AIRouteLimits>) =>
    api.put<AIRoute>(`/servers/${serverId}/ai/routes/${capability}`, data),

  deleteRoute: (serverId: string, capability: AICapability) =>
    api.delete<{ deleted: true }>(`/servers/${serverId}/ai/routes/${capability}`),

  listAgents: (serverId: string) =>
    api.get<ModelAgent[]>(`/servers/${serverId}/ai/agents`),

  createAgent: (serverId: string, data: ModelAgentInput & { name: string; providerId: string; model: string; channelIds?: string[] }) =>
    api.post<ModelAgent>(`/servers/${serverId}/ai/agents`, data),

  updateAgent: (serverId: string, agentId: string, data: ModelAgentInput) =>
    api.patch<ModelAgent>(`/servers/${serverId}/ai/agents/${agentId}`, data),

  deleteAgent: (serverId: string, agentId: string) =>
    api.delete<{ deleted: true }>(`/servers/${serverId}/ai/agents/${agentId}`),

  getAgentBudget: (serverId: string) =>
    api.get<ModelAgentBudget>(`/servers/${serverId}/ai/agent-budget`),

  updateAgentBudget: (serverId: string, data: Partial<Omit<ModelAgentBudget, 'today'>>) =>
    api.patch<ModelAgentBudget>(`/servers/${serverId}/ai/agent-budget`, data),

  listChanges: (serverId: string, limit = 20) =>
    api.get<AIChange[]>(`/servers/${serverId}/ai/changes?limit=${limit}`),

  getCapabilityUsage: (serverId: string, days = 30) =>
    api.get<{ days: number; capabilities: AICapabilityUsage[] }>(`/servers/${serverId}/ai/usage?days=${days}`),

  // Instance-admin setting
  getInstanceAISettings: () =>
    api.get<{ allowPrivateBaseUrls: boolean }>('/admin/settings/ai'),

  setAllowPrivateBaseUrls: (allowPrivateBaseUrls: boolean) =>
    api.patch<{ allowPrivateBaseUrls: boolean }>('/admin/settings/ai', { allowPrivateBaseUrls }),
};

// ─── Sandboxed runtime API ───

export type RuntimeAccess = 'none' | 'approval' | 'auto';

export interface RuntimeRunInfo {
  id: string;
  status: string;
  capabilities: string[];
  timeProfile: string;
  limits: Record<string, number>;
  gate: { decision: string | null; reason: string | null; source: string | null };
  stdout: string | null;
  stderr: string | null;
  codeExpiresAt: string | null;
  codePrunedAt: string | null;
}

export const runtimeApi = {
  get: (runId: string) => api.get<RuntimeRunInfo>(`/runtime/runs/${runId}`),

  /** Plain-text code download (410 once pruned by retention). */
  code: async (runId: string): Promise<string> => {
    const res = await fetch(`/runtime/runs/${runId}/code`, { headers: getAuthHeaders(), credentials: 'same-origin' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data.error || 'unknown_error');
    }
    return res.text();
  },

  approve: (runId: string) => api.post<{ id: string; status: string }>(`/runtime/runs/${runId}/approve`),
  deny: (runId: string) => api.post<{ id: string; status: string }>(`/runtime/runs/${runId}/deny`),

  setBotAccess: (serverId: string, botId: string, access: RuntimeAccess) =>
    api.patch<{ id: string; runtimeAccess: RuntimeAccess }>(`/servers/${serverId}/bots/${botId}/runtime`, { access }),
};

// ─── Role Management API ───

import type { Role, ChannelOverrides as ChannelOverridesType } from './contracts/roles';

export const roleApi = {
  list: (serverId: string) =>
    api.get<Role[]>(`/servers/${serverId}/roles`),

  create: (serverId: string, data: { name: string; color?: string; hoist?: boolean; permissions?: string; mentionable?: boolean }) =>
    api.post<Role>(`/servers/${serverId}/roles`, data),

  update: (serverId: string, roleId: string, data: Record<string, unknown>) =>
    api.patch<Role>(`/servers/${serverId}/roles/${roleId}`, data),

  remove: (serverId: string, roleId: string) =>
    api.delete<{ deleted: true }>(`/servers/${serverId}/roles/${roleId}`),

  assignRole: (serverId: string, userId: string, roleId: string) =>
    api.put<{ assigned: true }>(`/servers/${serverId}/members/${userId}/roles/${roleId}`),

  removeRole: (serverId: string, userId: string, roleId: string) =>
    api.delete<{ removed: true }>(`/servers/${serverId}/members/${userId}/roles/${roleId}`),

  // Channel overrides
  getOverrides: (channelId: string) =>
    api.get<ChannelOverridesType>(`/channels/${channelId}/overrides`),

  upsertRoleOverride: (channelId: string, roleId: string, data: { allow: string; deny: string }) =>
    api.put(`/channels/${channelId}/overrides/roles/${roleId}`, data),

  removeRoleOverride: (channelId: string, roleId: string) =>
    api.delete(`/channels/${channelId}/overrides/roles/${roleId}`),

  upsertMemberOverride: (channelId: string, userId: string, data: { allow: string; deny: string }) =>
    api.put(`/channels/${channelId}/overrides/members/${userId}`, data),

  removeMemberOverride: (channelId: string, userId: string) =>
    api.delete(`/channels/${channelId}/overrides/members/${userId}`),
};

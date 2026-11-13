import type { Bot, ModelAgent } from '../../lib/api';
import type { Box } from '../boxes/api';
import type { AgentSession } from '../agents/agentSessions';
import type { Host, Profile } from './AgentSessionsSettings';
import type { RosterInput } from './agentRoster';

/** Test fixtures for the agent roster and the pages built on it. */
export const bot = (id: string, username: string, extra: Partial<Bot> = {}): Bot => ({ id, username, ownerId: null, createdAt: '2026-01-01T00:00:00Z', ...extra });
export const host = (id: string, extra: Partial<Host> = {}): Host => ({ id, name: `host-${id}`, createdAt: '', lastSeenAt: '2026-11-01T00:00:00Z', revokedAt: null, ...extra });
export const profile = (name: string, hostId: string, extra: Partial<Profile> = {}): Profile => ({
  id: `p-${name}`, name, botId: `bot-${name}`, hostId, adapter: 'claude', model: null, effort: null, workdirAlias: 'agora',
  wakeBudget: null, tokenBudget: null, runTimeoutSec: null, ...extra,
});
export const box = (name: string, extra: Partial<Box> = {}): Box => ({
  id: `box-${name}`, name, adapter: 'claude', auth: 'api_key', state: 'running', desiredState: 'running', pendingAction: null, generation: 1,
  imageVersion: 1, loginState: 'logged_in', homeChannelId: null, allowedDomains: [], repos: [], cpus: 1, memoryMb: 1024, pids: 256,
  lastError: null, lastSeenAt: null, createdAt: '', deletedAt: null, volumePurgeAfter: null, policies: [], ...extra,
});
export const model = (name: string, extra: Partial<ModelAgent> = {}): ModelAgent => ({ id: `m-${name}`, botId: `bot-${name}`, name, enabled: true, model: 'qwen', providerLabel: 'OpenRouter', ...extra } as ModelAgent);
export const session = (extra: Partial<AgentSession>): AgentSession => ({
  id: 's1', profile: 'x', botUsername: 'x', state: 'live', endReason: null, wakesUsed: 0, tokensUsed: 0, lastActiveAt: '2026-11-02T00:00:00Z', ...extra,
} as AgentSession);

export function input(extra: Partial<RosterInput> = {}): RosterInput {
  return { bots: [], profiles: [], hosts: [], boxes: [], modelAgents: [], assistantBotId: null, sessions: [], now: Date.parse('2026-11-13T00:00:00Z'), ...extra };
}


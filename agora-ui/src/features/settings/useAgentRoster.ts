import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, aiApi, botApi, serverApi, ApiError } from '../../lib/api';
import type { ModelAgent } from '../../lib/api';
import type { Channel } from '../../lib/contracts/server';
import { boxApi, type Box } from '../boxes/api';
import { listSessions, type AgentSession } from '../agents/agentSessions';
import type { PlanConnection } from './ChatGPTPlanConnect';
import type { Host, Profile } from './AgentSessionsSettings';
import { buildRoster, type AgentRow } from './agentRoster';

/** Sessions are read per channel; a very large server shows the first channels' sessions only. */
const SESSION_CHANNELS = 30;

export interface RosterData {
  rows: AgentRow[];
  hosts: Host[];
  boxes: Box[];
  channels: Channel[];
  plans: PlanConnection[];
  modelAgents: ModelAgent[] | null;
  /** The viewer may list and manage accounts (Manage Bots). */
  canManageAccounts: boolean;
}

const settled = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);

/**
 * Loads every source an agent row is built from. A source the viewer may not read (accounts
 * need Manage Bots, model agents need an administrator) just leaves its rows out; the server
 * still decides who may see what.
 */
export function useAgentRoster(serverId: string | null) {
  const [data, setData] = useState<RosterData | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    (async () => {
      const [bots, profiles, hosts, boxes, models, config, chans, plans] = await Promise.allSettled([
        botApi.list(serverId),
        api.get<Profile[]>(`/servers/${serverId}/agent-profiles`),
        api.get<Host[]>(`/servers/${serverId}/agent-hosts`),
        boxApi.list(serverId),
        aiApi.listAgents(serverId),
        aiApi.getConfig(serverId),
        serverApi.getChannels(serverId),
        api.get<PlanConnection[]>(`/servers/${serverId}/agent-plans`),
      ]);
      if (cancelled) return;
      if (profiles.status === 'rejected' && bots.status === 'rejected') {
        const err = profiles.reason;
        setError(err instanceof ApiError ? err.code : 'Failed to load agents');
        return;
      }
      const channels = (settled(chans) ?? []).filter(c => c.channelType === 3);
      const sessionLists = await Promise.allSettled(channels.slice(0, SESSION_CHANNELS).map(c => listSessions(c.id)));
      if (cancelled) return;
      const sessions: AgentSession[] = sessionLists.flatMap(r => settled(r) ?? []);
      const cfg = settled(config);
      const botList = settled(bots);
      const hostList = settled(hosts) ?? [];
      const boxList = settled(boxes)?.boxes;
      const modelList = settled(models);
      const rows = buildRoster({
        bots: botList, profiles: settled(profiles) ?? [], hosts: hostList,
        boxes: Array.isArray(boxList) ? boxList : [], modelAgents: modelList,
        assistantBotId: cfg?.configured && cfg.botId ? cfg.botId : null, sessions,
      });
      setData({
        rows, hosts: hostList, boxes: Array.isArray(boxList) ? boxList : [], channels,
        plans: settled(plans) ?? [], modelAgents: modelList, canManageAccounts: botList !== null,
      });
      setError('');
    })().catch(() => { if (!cancelled) setError('Failed to load agents'); });
    return () => { cancelled = true; };
  }, [serverId, reloadKey]);

  return useMemo(() => ({ data, error, reload }), [data, error, reload]);
}

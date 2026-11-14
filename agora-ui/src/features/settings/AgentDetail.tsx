import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../../components/ui/Avatar';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { STATE_LABEL, sessionState, stopLabel, compactTokens, type AgentSession } from '../agents/agentSessions';
import { BoxCard } from '../boxes/BoxCard';
import { ProfileRow } from './AgentSessionsSettings';
import { AgentRow as ModelAgentRow } from './ai/AgentsSection';
import { BotControls, BotDetailPanel } from './BotManagement';
import { KIND_HELP, KIND_LABEL, findRow, type AgentRow } from './agentRoster';
import { StateLine } from './AgentsHome';
import { useAgentRoster, type RosterData } from './useAgentRoster';
import { aiApi } from '../../lib/api';
import type { AIAdapter, AIProvider } from '../../lib/api';

const H3 = 'mb-1 text-lg font-semibold text-text';
const HELP = 'mb-3 text-xs text-text-muted';

function Section({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  return (
    <section className="mb-8" aria-label={title}>
      <h3 className={H3}>{title}</h3>
      <p className={HELP}>{help}</p>
      {children}
    </section>
  );
}

/** Where the agent runs: one line per fact, in plain words. */
function runsFacts(row: AgentRow): [string, string][] {
  const out: [string, string][] = [];
  if (row.profile) out.push(['Command-line tool', row.profile.adapter]);
  if (row.kind === 'machine' && row.host) out.push(['Machine', row.host.name]);
  if (row.kind === 'box' && row.box) out.push(['Box', `${row.box.name} (${row.box.state})`]);
  if (row.kind === 'model' && row.model) out.push(['Model', `${row.model.model} on ${row.model.providerLabel}`]);
  return out;
}

function SessionsList({ sessions }: { sessions: AgentSession[] }) {
  const mine = [...sessions].sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
  if (mine.length === 0) return <p className="text-sm text-text-muted">No sessions yet. In a channel, type <code>/start {'<agent>'}</code> to begin one.</p>;
  return (
    <ul className="flex flex-col gap-1" aria-label="Sessions">
      {mine.map(s => (
        <li key={s.id} className="rounded border border-border bg-surface px-3 py-2 text-sm">
          <span className="font-medium text-text">{STATE_LABEL[sessionState(s)]}</span>
          <span className="ml-2 text-xs text-text-muted">
            {s.kind === 'terminal' ? 'terminal' : 'hosted'} · {(s.wakesUsed ?? 0).toLocaleString('en-US')} wakes · {compactTokens(s.tokensUsed ?? 0)} tokens
            {s.state === 'shelved' && s.endReason ? ` · stopped: ${stopLabel(s)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Model agents need the provider and adapter lists their edit form offers. */
function ModelSettings({ serverId, row, data, onChanged }: { serverId: string; row: AgentRow; data: RosterData; onChanged: () => void }) {
  const [lists, setLists] = useState<{ providers: AIProvider[]; adapters: AIAdapter[] } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([aiApi.listProviders(serverId), aiApi.listAdapters(serverId)])
      .then(([providers, adapters]) => { if (live) setLists({ providers: providers.filter(p => p.enabled && p.adapter === 'openai'), adapters }); })
      .catch(() => { if (live) setLists({ providers: [], adapters: [] }); });
    return () => { live = false; };
  }, [serverId]);
  if (!row.model || !lists) return <p className="text-sm text-text-muted">Loading...</p>;
  return <ModelAgentRow serverId={serverId} agent={row.model} providers={lists.providers} adapters={lists.adapters} channels={data.channels} onChanged={onChanged} />;
}

/**
 * Settings → Agents → one agent. Gathers what used to be split across Bots, Agents and AI:
 * how it runs, its limits and logins, its sessions, and the account it posts as.
 */
export function AgentDetail() {
  const { agentKey = '' } = useParams();
  const serverId = useServerStore(s => s.instanceServerId);
  const ownerId = useServerStore(s => (serverId ? s.servers.get(serverId)?.ownerId : undefined));
  const userId = useAuthStore(s => s.user?.id);
  const navigate = useNavigate();
  const { data, error, reload } = useAgentRoster(serverId);
  const [message, setMessage] = useState('');
  if (!serverId) return null;
  const isOwner = !!userId && !!ownerId && userId.trim() === ownerId.trim();
  const row = data ? findRow(data.rows, agentKey) : undefined;
  const back = <Link to="/settings/agents" className="mb-3 inline-flex min-h-11 items-center text-sm text-primary-text hover:underline md:min-h-8">All agents</Link>;

  if (error) return <div>{back}<p className="text-sm text-danger" role="alert">{error}</p></div>;
  if (!data) return <div>{back}<p className="text-text-muted">Loading agent...</p></div>;
  if (!row) return <div>{back}<h2 className="text-xl font-bold text-text">Agent not found</h2><p className="text-sm text-text-muted">It may have been deleted. Go back to the list of agents.</p></div>;

  const profileHost = row.profile ? data.hosts.find(h => h.id === row.profile!.hostId && !h.revokedAt) : undefined;
  const plan = row.profile ? data.plans.find(p => p.profileId === row.profile!.id) : undefined;
  const onError = (m: string) => setMessage(m);

  return (
    <div className="max-w-3xl">
      {back}
      <header className="mb-6 flex flex-wrap items-start gap-3">
        <Avatar userId={row.botId} username={row.name} avatarUrl={row.avatarUrl} className="h-14 w-14 text-lg" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold text-text">{row.name}</h2>
          <p className="text-sm text-text-muted">{KIND_LABEL[row.kind]}</p>
          <StateLine state={row.state} className="mt-1" />
        </div>
        {row.bot && (
          <div className="flex flex-wrap items-center gap-2">
            <BotControls bot={row.bot} serverId={serverId} onChanged={reload} onError={onError} />
          </div>
        )}
      </header>
      {message && <p className="mb-4 text-sm text-danger" role="alert">{message}</p>}

      <Section title="How it runs" help={KIND_HELP[row.kind]}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {runsFacts(row).map(([k, v]) => <div key={k} className="contents"><dt className="text-text-muted">{k}</dt><dd className="text-text">{v}</dd></div>)}
        </dl>
        {row.kind === 'terminal' && (
          <p className="mt-2 text-xs text-text-muted">To connect another terminal as this agent, make a token under Account and access, then choose Invite Agent.</p>
        )}
      </Section>

      {row.box && (
        <Section title="Box and login" help="The box's state, its CLI login, and what it may reach. Only the server owner changes these.">
          <ul><BoxCard box={row.box} channels={data.channels} isOwner={isOwner} onChange={reload} /></ul>
        </Section>
      )}

      {row.profile && (
        <Section title={row.kind === 'machine' ? 'Settings, limits and logins' : 'Limits and tools'}
          help="Limits are off unless you set one. The CLI's sign-in and the tools it may use are set here too.">
          <ul>
            <ProfileRow serverId={serverId} profile={row.profile} host={profileHost} plan={plan} onChange={reload} onError={onError} />
          </ul>
        </Section>
      )}

      {row.kind === 'model' && (
        <Section title="Model and limits" help="Which provider key and model answers for this agent, what it may do, and its daily limits.">
          <ModelSettings serverId={serverId} row={row} data={data} onChanged={reload} />
        </Section>
      )}

      <Section title="Sessions" help="Work this agent has started in your channels, newest first. Start or end one with /start and /end in a channel.">
        <SessionsList sessions={row.sessions} />
      </Section>

      {row.botId && (
        <Section title="Account and access" help="The account this agent posts as: its avatar, the channels it can read and post in, and its tokens. Only people who may manage bots see this.">
          {data.canManageAccounts
            ? <div className="overflow-hidden rounded-lg border border-border">
                <BotDetailPanel botId={row.botId} serverId={serverId} deleteLabel="Delete this agent's account"
                  onDeleted={() => { reload(); void navigate('/settings/agents'); }} />
              </div>
            : <p className="text-sm text-text-muted">You need the Manage Bots permission to see this agent&apos;s account, channel access and tokens.</p>}
        </Section>
      )}
    </div>
  );
}

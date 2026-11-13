import { useDeferredValue, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { NotAffiliated } from '../../components/ui/NotAffiliated';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { boxApi, type GithubCredential as Credential } from '../boxes/api';
import { GithubCredential } from '../boxes/GithubCredential';
import { HostsSection, OnceToken, SubscriptionWakesSection } from './AgentSessionsSettings';
import { ChannelLoopGuardSection } from './BotManagement';
import { KIND_LABEL, TONE_DOT, agentPath, type AgentRow, type AgentState } from './agentRoster';
import { useAgentRoster } from './useAgentRoster';

const PAGE = 100;

export function StateLine({ state, className = '' }: { state: AgentState; className?: string }) {
  return (
    <span className={`flex items-start gap-2 text-xs text-text-muted ${className}`} data-testid="agent-state" data-tone={state.tone}>
      <span aria-hidden="true" className={`mt-1 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[state.tone]}`} />
      <span><span className="font-medium text-text">{state.label}</span>{state.why ? <>: {state.why}</> : null}</span>
    </span>
  );
}

function AgentListRow({ row }: { row: AgentRow }) {
  return (
    <li>
      <Link to={agentPath(row)}
        className="flex min-h-14 items-start gap-3 rounded-lg border border-border bg-surface px-3 py-3 hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <Avatar userId={row.botId} username={row.name} avatarUrl={row.avatarUrl} className="h-10 w-10 text-sm" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="font-medium text-text">{row.name}</span>
            <span className="text-xs text-text-muted" data-testid="agent-kind">{KIND_LABEL[row.kind]}</span>
          </span>
          <StateLine state={row.state} className="mt-1" />
        </span>
        <svg aria-hidden="true" className="mt-2 h-4 w-4 shrink-0 text-text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="m8 4 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </Link>
    </li>
  );
}

function BoxGithub({ serverId, isOwner }: { serverId: string; isOwner: boolean }) {
  const [credential, setCredential] = useState<Credential | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    boxApi.getGithub(serverId).then(
      res => { if (live) setCredential(res && typeof res === 'object' && 'set' in res ? res : null); },
      () => { if (live) setCredential(null); },
    );
    return () => { live = false; };
  }, [serverId, version]);
  return <GithubCredential serverId={serverId} credential={credential} isOwner={isOwner} onChange={() => setVersion(v => v + 1)} />;
}

/**
 * Settings → Agents: one list of every agent in the server, however it runs, and one Add an agent
 * button. Each row opens the agent's page. What applies to all agents (who can wake subscription
 * agents, loop guards, the machines that run agents) sits below the list.
 */
export function AgentsHome() {
  const serverId = useServerStore(s => s.instanceServerId);
  const ownerId = useServerStore(s => (serverId ? s.servers.get(serverId)?.ownerId : undefined));
  const userId = useAuthStore(s => s.user?.id);
  const { data, error, reload } = useAgentRoster(serverId);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query).trim().toLowerCase();
  const [shown, setShown] = useState(PAGE);
  const [secret, setSecret] = useState<{ label: string; token: string } | null>(null);
  const [problem, setProblem] = useState('');
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash || !data) return;
    document.getElementById(hash.slice(1))?.scrollIntoView?.();
  }, [hash, data]);

  if (!serverId) return null;
  const isOwner = !!userId && !!ownerId && userId.trim() === ownerId.trim();
  const rows = (data?.rows ?? []).filter(r => !deferred || r.name.toLowerCase().includes(deferred));
  const machineHosts = (data?.hosts ?? []).filter(h => h.kind !== 'box');

  return (
    <div className="max-w-3xl">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold text-text">Agents</h2>
        <Link to="/settings/agents/new" className="inline-flex min-h-11 items-center rounded bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover md:min-h-9">
          Add an agent
        </Link>
      </div>
      <p className="mb-2 text-sm text-text-muted">
        An agent is anything that does work in your channels. Each one is listed here once, whether it runs in a box, on one of
        your machines, from someone&apos;s own terminal, or as a model on an API key. Open an agent to see how it runs, its limits,
        logins, channel access, tokens and sessions.
      </p>
      <p className="mb-6 text-xs text-text-muted">
        An agent posts as an <em>account</em> (called a bot account in the API): that is where its tokens and channel access live.
        Provider keys and the built-in assistant are under <Link to="/settings/models" className="text-primary-text underline">Models and assistant</Link>.
      </p>
      {error && <p className="mb-4 text-sm text-danger" role="alert">{error}</p>}
      {problem && <p className="mb-4 text-sm text-danger" role="alert">{problem}</p>}
      {secret && <OnceToken label={secret.label} token={secret.token} onDone={() => setSecret(null)} />}

      {!data ? (
        !error && <p className="text-text-muted">Loading agents...</p>
      ) : (
        <>
          <section aria-label="All agents" className="mb-10">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <input type="search" value={query} onChange={e => { setQuery(e.target.value); setShown(PAGE); }} placeholder="Search agents" aria-label="Search agents"
                className="min-h-11 w-full max-w-xs rounded border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-muted/70 md:min-h-9" />
              <span className="text-xs text-text-muted" aria-live="polite">
                {rows.length === data.rows.length ? `${rows.length} ${rows.length === 1 ? 'agent' : 'agents'}` : `${rows.length} of ${data.rows.length} agents`}
              </span>
            </div>
            {data.rows.length === 0 ? (
              <p className="text-sm text-text-muted">No agents yet. Choose <b>Add an agent</b> to start one.</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-text-muted">No agents match &ldquo;{query.trim()}&rdquo;.</p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Agents">
                {rows.slice(0, shown).map(r => <AgentListRow key={r.key} row={r} />)}
              </ul>
            )}
            {rows.length > shown && <div className="mt-3"><Button variant="secondary" onClick={() => setShown(n => n + PAGE)}>Show more</Button></div>}
            {!data.canManageAccounts && (
              <p className="mt-3 text-xs text-text-muted">
                Agents that only have an account (connected from a terminal) are listed for people with the Manage Bots permission.
              </p>
            )}
          </section>

          <h3 className="mb-1 text-lg font-semibold text-text">For all agents</h3>
          <p className="mb-4 text-xs text-text-muted">These apply to every agent in the server.</p>
          <SubscriptionWakesSection serverId={serverId} isOwner={isOwner} />
          {data.canManageAccounts && <div id="loop-guard"><ChannelLoopGuardSection serverId={serverId} /></div>}
          <section id="machines" className="mb-8">
            <h3 className="mb-1 text-lg font-semibold text-text">Machines</h3>
            <p className="mb-3 text-xs text-text-muted">
              A machine runs agora-host, which wakes the agents set to run on it. Each agent that runs on a machine
              is made with the Add an agent button above.
            </p>
            <HostsSection serverId={serverId} hosts={machineHosts} onChange={reload} onToken={setSecret} onError={setProblem} title="Registered machines" />
            <h4 className="mb-1 text-sm font-semibold text-text">GitHub access for boxes</h4>
            <BoxGithub serverId={serverId} isOwner={isOwner} />
          </section>
        </>
      )}
      <NotAffiliated className="mt-8" />
    </div>
  );
}

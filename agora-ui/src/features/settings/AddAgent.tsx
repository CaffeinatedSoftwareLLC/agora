import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { useServerAccess } from '../../hooks/useServerAccess';
import { aiApi } from '../../lib/api';
import type { AIAdapter, AIProvider, ModelAgent, ModelAgentBudget } from '../../lib/api';
import type { Box } from '../boxes/api';
import { CreateBoxDialog } from '../boxes/CreateBoxDialog';
import { LoginDialog } from '../boxes/LoginDialog';
import { CreateAgentForm, HostsSection, OnceToken } from './AgentSessionsSettings';
import { AgentsSection as ModelAgentsSection } from './ai/AgentsSection';
import { CreateAgentInviteModal } from './CreateAgentInviteModal';
import { CreateBotModal } from './CreateBotModal';
import { type AgentKind } from './agentRoster';
import { useAgentRoster } from './useAgentRoster';

type How = Exclude<AgentKind, 'assistant'>;

/** The choices, safest first. Each leads into the flow that already existed for it. */
const CHOICES: { how: How; title: string; line: string; who: string }[] = [
  { how: 'box', title: 'In a box', line: 'Its own locked-down container on this server. It reaches only the websites you allow. Recommended.', who: 'Server owner' },
  { how: 'machine', title: 'On one of my machines', line: "Agora wakes a CLI on a machine you run agora-host on. It can read and change that machine's files, and only you can wake it.", who: 'Server owner' },
  { how: 'terminal', title: "From someone's own terminal", line: 'A CLI the person already runs (Claude Code, Codex, Gemini CLI) connects with one command. Agora can listen to it but not start or stop it.', who: 'Anyone who may manage bots' },
  { how: 'model', title: 'A model on an API key', line: 'No CLI and no files: a model from one of your provider keys answers when it is @mentioned.', who: 'Administrator' },
];

function ModelFlow({ serverId, onDone }: { serverId: string; onDone: () => void }) {
  const [state, setState] = useState<{ adapters: AIAdapter[]; providers: AIProvider[]; agents: ModelAgent[]; budget: ModelAgentBudget } | null>(null);
  const [error, setError] = useState('');
  const { data } = useAgentRoster(serverId);
  useEffect(() => {
    let live = true;
    Promise.all([aiApi.listAdapters(serverId), aiApi.listProviders(serverId), aiApi.listAgents(serverId), aiApi.getAgentBudget(serverId)])
      .then(([adapters, providers, agents, budget]) => { if (live) setState({ adapters, providers, agents, budget }); })
      .catch(() => { if (live) setError('Only an administrator can add a model agent.'); });
    return () => { live = false; };
  }, [serverId]);
  if (error) return <p className="text-sm text-danger" role="alert">{error}</p>;
  if (!state || !data) return <p className="text-sm text-text-muted">Loading...</p>;
  const usable = state.providers.some(p => p.enabled && p.adapter === 'openai');
  return (
    <>
      {!usable && <p className="mb-3 text-sm text-warn">A model agent needs a provider key first. <Link to="/settings/models" className="underline">Add one under Models and assistant</Link>.</p>}
      <ModelAgentsSection serverId={serverId} adapters={state.adapters} providers={state.providers} agents={state.agents} budget={state.budget}
        channels={data.channels} onChanged={onDone} startAdding hideList />
    </>
  );
}

/**
 * Settings → Agents → Add an agent: asks how the agent should run, then shows the existing
 * flow for that: Create box, Create agent on a machine, Invite Agent, or Add model agent.
 */
export function AddAgent() {
  const serverId = useServerStore(s => s.instanceServerId);
  const ownerId = useServerStore(s => (serverId ? s.servers.get(serverId)?.ownerId : undefined));
  const userId = useAuthStore(s => s.user?.id);
  const { isInstanceAdmin } = useServerAccess(serverId);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data, reload } = useAgentRoster(serverId);
  const [secret, setSecret] = useState<{ label: string; token: string } | null>(null);
  const [problem, setProblem] = useState('');
  const [boxDialog, setBoxDialog] = useState(false);
  const [loginFor, setLoginFor] = useState<Box | null>(null);
  const [invite, setInvite] = useState(false);
  const [account, setAccount] = useState(false);
  if (!serverId) return null;
  const isOwner = !!userId && !!ownerId && userId.trim() === ownerId.trim();
  const picked = CHOICES.find(c => c.how === params.get('how'))?.how ?? null;
  const channels = data?.channels ?? [];
  const machineHosts = (data?.hosts ?? []).filter(h => h.kind !== 'box');
  const activeHosts = machineHosts.filter(h => !h.revokedAt);
  const allowed: Record<How, boolean> = { box: isOwner, machine: isOwner, terminal: true, model: isInstanceAdmin };
  const finish = () => { reload(); void navigate('/settings/agents'); };

  return (
    <div className="max-w-3xl">
      <Link to="/settings/agents" className="mb-3 inline-flex min-h-11 items-center text-sm text-primary-text hover:underline md:min-h-8">All agents</Link>
      <h2 className="mb-1 text-xl font-bold text-text">Add an agent</h2>
      <p className="mb-5 text-sm text-text-muted">How should it run? You can&apos;t mix these on one agent, so pick the one that fits.</p>

      <div role="radiogroup" aria-label="How should it run?" className="mb-6 flex flex-col gap-2">
        {CHOICES.map(c => (
          <label key={c.how} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 ${picked === c.how ? 'border-primary bg-primary/10' : 'border-border bg-surface hover:bg-surface-hover'}`}>
            <input type="radio" name="how" className="mt-1" checked={picked === c.how} onChange={() => setParams({ how: c.how })} />
            <span>
              <span className="block text-sm font-medium text-text">{c.title}</span>
              <span className="block text-xs text-text-muted">{c.line}</span>
              {!allowed[c.how] && <span className="block text-xs text-text-muted">Needs: {c.who.toLowerCase()}.</span>}
            </span>
          </label>
        ))}
      </div>

      {problem && <p className="mb-3 text-sm text-danger" role="alert">{problem}</p>}
      {secret && <OnceToken label={secret.label} token={secret.token} onDone={() => setSecret(null)} />}

      {picked && !allowed[picked] && (
        <p className="mb-4 text-sm text-text-muted">{picked === 'model' ? 'Only an administrator can add a model agent.' : 'Only the server owner can do this.'}</p>
      )}

      {picked === 'box' && isOwner && (
        <section aria-label="Create a box">
          <p className="mb-3 text-xs text-text-muted">Next you name it, pick its CLI and home channel, and (for a subscription) log it in once.</p>
          <Button onClick={() => setBoxDialog(true)} disabled={channels.length === 0}>Create box</Button>
          {channels.length === 0 && <p className="mt-1 text-xs text-text-muted">Create a channel first: a box needs a home channel.</p>}
        </section>
      )}
      {picked === 'machine' && isOwner && (
        <section aria-label="Create an agent on a machine">
          {activeHosts.length === 0 && <p className="mb-3 text-sm text-text-muted">First register the machine that will run it. Put the token it shows in that machine&apos;s agora-host config.</p>}
          {activeHosts.length === 0
            ? <HostsSection serverId={serverId} hosts={machineHosts} onChange={reload} onToken={setSecret} onError={setProblem} title="Register a machine" />
            : <CreateAgentForm serverId={serverId} hosts={activeHosts} channels={channels} onChange={reload} onToken={setSecret} onError={setProblem} />}
        </section>
      )}
      {picked === 'terminal' && (
        <section aria-label="Invite an agent from a terminal">
          <p className="mb-3 text-xs text-text-muted">Creates the agent&apos;s account and a one-time command to run in the terminal where it works.</p>
          <Button onClick={() => setInvite(true)}>Invite Agent</Button>
        </section>
      )}
      {picked === 'model' && isInstanceAdmin && <ModelFlow serverId={serverId} onDone={finish} />}

      <p className="mt-8 text-xs text-text-muted">
        Only need an account for your own script or integration, with no agent behind it?{' '}
        <button type="button" className="min-h-11 text-primary-text underline md:min-h-0" onClick={() => setAccount(true)}>Create an account only</button>.
      </p>

      {boxDialog && (
        <CreateBoxDialog serverId={serverId} channels={channels} onClose={() => setBoxDialog(false)}
          onCreated={box => { setBoxDialog(false); reload(); if (box?.auth === 'subscription') setLoginFor(box); else finish(); }} />
      )}
      {loginFor && <LoginDialog box={loginFor} onClose={() => { setLoginFor(null); finish(); }} />}
      {invite && <CreateAgentInviteModal serverId={serverId} onClose={() => { setInvite(false); reload(); }} onCreated={reload} />}
      <CreateBotModal serverId={serverId} isOpen={account} onClose={() => setAccount(false)} onCreated={finish} />
    </div>
  );
}

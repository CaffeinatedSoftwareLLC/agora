import { useCallback, useEffect, useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { api, serverApi, ApiError } from '../../lib/api';
import type { Channel } from '../../lib/contracts/server';
import { Button } from '../../components/ui/Button';
import { NotAffiliated } from '../../components/ui/NotAffiliated';
import { authLabel, validLimit } from '../agents/agentSessions';
import { LimitRow } from './LimitRow';
import { ChatGPTPlanConnect, type PlanConnection } from './ChatGPTPlanConnect';
import { useAuthStore } from '../../stores/authStore';
import { BoxesSection } from '../boxes/BoxesSection';
import { BoxModeBadge } from '../boxes/BoxModeBadge';

/**
 * Agent hosts and agents (docs/planning/agent-sessions-wbs.md, S6). The owner registers the
 * machine that runs agents (a host) and creates agents on it; members then use /start in a
 * channel. Tokens are shown once and go into the host's config file, never into a channel.
 */

/** kind 'box': the agora-host inside a box (docs/agent-boxes.md §8.1); listed under Boxes, not here. */
export interface Host { id: string; name: string; createdAt: string; lastSeenAt: string | null; revokedAt: string | null; kind?: 'machine' | 'box' }
export interface Profile {
  id: string; name: string; botId: string; hostId: string; adapter: 'codex' | 'claude' | 'gemini' | 'opencode' | 'omp' | 'devin';
  model: string | null; effort: string | null; workdirAlias: string; workspaceId?: string;
  /** Session limits; null: no limit, the default (docs/agent-limits.md). */
  wakeBudget: number | null; tokenBudget: number | null; runTimeoutSec: number | null;
  toolPresets?: string[]; allowedTools?: string[];
  /** Show the agent's live text and steps in the channel while it runs (docs/live-output.md); on unless false. */
  showLiveOutput?: boolean;
  /** Reported by the host at start (docs/provider-terms.md); subscription until then. */
  authMode?: 'subscription' | 'api_key' | 'siwc'; apiKeyEnv?: string | null; runApproval?: boolean; authReportedAt?: string | null;
  /** 'siwc' only: whose ChatGPT plan it runs on (docs/codex-chatgpt-plan.md). */
  planOwnerId?: string | null;
  /** Its host is a box (docs/agent-boxes.md §10); otherwise it runs unboxed on a machine. */
  boxed?: boolean; hostMode?: boolean;
}

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'];

/** Built-in tool presets (agora-host/src/presets.ts); the host config can redefine them. */
const PRESETS: { name: string; label: string; detail: string }[] = [
  { name: 'readonly', label: 'Read-only', detail: 'read files and git history' },
  { name: 'dev', label: 'Dev', detail: 'edit files, git, gh, npm' },
  { name: 'research', label: 'Research', detail: 'web search and fetch' },
];
/** Same rule shape the server accepts: a Claude permission rule or a Codex word (write, network, web_search). */
const TOOL_RULE = /^[A-Za-z][A-Za-z0-9_]{0,99}(\([^(),\r\n]{1,200}\))?$/;
const input = 'min-h-11 md:min-h-9 bg-bg border border-border rounded px-3 py-1.5 text-sm text-text placeholder:text-text-muted/70 focus:outline-none focus:ring-2 focus:ring-primary';

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.status === 403 ? 'Only the server owner can do this.' : err.code;
  return 'Request failed';
}

export function OnceToken({ label, token, onDone }: { label: string; token: string; onDone: () => void }) {
  return (
    <div className="mb-4 rounded border border-primary/50 bg-primary/10 p-3 text-sm">
      <p className="mb-2 text-text">{label} It is shown only now; put it in the host's config file.</p>
      <code className="block break-all rounded bg-bg p-2 font-mono text-xs text-text select-all">{token}</code>
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(token); }}>Copy</Button>
        <Button variant="secondary" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

export function AgentSessionsSettings() {
  const serverId = useServerStore(s => s.instanceServerId);
  const ownerId = useServerStore(s => (serverId ? s.servers.get(serverId)?.ownerId : undefined));
  const userId = useAuthStore(s => s.user?.id);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [plans, setPlans] = useState<PlanConnection[]>([]);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<{ label: string; token: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    Promise.all([
      api.get<Host[]>(`/servers/${serverId}/agent-hosts`),
      api.get<Profile[]>(`/servers/${serverId}/agent-profiles`),
      serverApi.getChannels(serverId),
      // ChatGPT plan connections; an older server without them just shows none
      api.get<PlanConnection[]>(`/servers/${serverId}/agent-plans`).catch(() => [] as PlanConnection[]),
    ]).then(([h, p, c, pl]) => {
      if (cancelled) return;
      setHosts(h);
      setProfiles(p);
      setPlans(pl);
      setChannels(c.filter(ch => ch.channelType === 3));
      setError('');
    }).catch(err => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [serverId, reloadKey]);

  if (!serverId) return null;
  // Box hosts are managed with their box; agents are created on machine hosts here
  const machineHosts = hosts.filter(h => h.kind !== 'box');
  const activeHosts = machineHosts.filter(h => !h.revokedAt);
  const isOwner = !!userId && !!ownerId && userId.trim() === ownerId.trim();

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold text-text mb-2">Agents</h2>
      <p className="text-text-muted text-sm mb-6">
        An agent host runs on the machine with your agent CLIs and wakes agents when they are addressed. Create a host,
        put its token in the host's config, then create agents on it. In a channel, <code>/start &lt;agent&gt;</code> starts a session.
      </p>
      {error && <p className="text-danger text-sm mb-4">{error}</p>}
      {secret && <OnceToken label={secret.label} token={secret.token} onDone={() => setSecret(null)} />}

      <p className="text-text-muted text-xs mb-6">
        Each agent runs its CLI on your own login (<em>subscription</em>) or on an API key, as set in the host's config.
        Personal subscriptions are for one person, so only you and your own agents can wake a subscription agent; give
        agents that other members wake an API key. A Codex agent can also run on a ChatGPT plan through Sign in with
        ChatGPT; only the person who connected their plan, and their own agents, can wake it. See docs/provider-terms.md
        and docs/codex-chatgpt-plan.md.
      </p>

      <SubscriptionWakesSection serverId={serverId} isOwner={isOwner} />
      <BoxesSection serverId={serverId} channels={channels} isOwner={isOwner} />
      <HostsSection serverId={serverId} hosts={machineHosts} onChange={load} onToken={setSecret} onError={setError} />
      <AgentsSection serverId={serverId} hosts={activeHosts} allHosts={hosts} profiles={profiles} channels={channels} plans={plans}
        onChange={load} onToken={setSecret} onError={setError} />
      <NotAffiliated className="mt-8" />
    </div>
  );
}

export type SubscriptionWakes = 'owner_bots' | 'owner_only';

const WAKE_OPTIONS: { value: SubscriptionWakes; label: string; detail: string }[] = [
  { value: 'owner_bots', label: 'You and your own agents',
    detail: "Your own bots wake your subscription agents as you would, like several CLIs you opened yourself: your terminals on your own tokens, and runs only you can wake. Other people, their bots, model agents and API-key agents' runs never do." },
  { value: 'owner_only', label: 'Only you',
    detail: 'Stricter: agents only answer you, not your other agents.' },
];

/**
 * Who besides the plan owner wakes subscription and ChatGPT-plan agents (servers.subscription_wakes,
 * docs/provider-terms.md "Owner bots"). Everyone sees it; only the server owner changes it.
 */
export function SubscriptionWakesSection({ serverId, isOwner }: { serverId: string; isOwner: boolean }) {
  const [value, setValue] = useState<SubscriptionWakes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    // An older server without the setting: the section stays hidden
    api.get<{ subscriptionWakes: SubscriptionWakes }>(`/servers/${serverId}/agent-settings`)
      .then(r => { if (!cancelled) setValue(r.subscriptionWakes); })
      .catch(() => { if (!cancelled) setValue(null); });
    return () => { cancelled = true; };
  }, [serverId]);

  if (!value) return null;
  const choose = async (next: SubscriptionWakes) => {
    if (next === value) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.patch<{ subscriptionWakes: SubscriptionWakes }>(`/servers/${serverId}/agent-settings`, { subscriptionWakes: next });
      setValue(r.subscriptionWakes);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <section className="mb-8">
      <h3 className="text-lg font-semibold text-text mb-1">Who can wake subscription agents</h3>
      <p className="text-text-muted text-xs mb-2">Other people and their bots never can: a personal subscription is for one person.</p>
      <div role="radiogroup" aria-label="Who can wake subscription agents" className="flex flex-col gap-1">
        {WAKE_OPTIONS.map(o => (
          <label key={o.value} className="flex min-h-11 md:min-h-8 items-start gap-2 text-sm text-text">
            <input type="radio" name="subscription-wakes" className="mt-1" value={o.value} checked={value === o.value}
              disabled={!isOwner || busy} onChange={() => void choose(o.value)} />
            <span>{o.label} <span className="text-xs text-text-muted">{o.detail}</span></span>
          </label>
        ))}
      </div>
      {!isOwner && <p className="mt-1 text-xs text-text-muted">Only the server owner can change this.</p>}
      {error && <p className="mt-1 text-danger text-sm">{error}</p>}
    </section>
  );
}

export function HostsSection({ serverId, hosts, onChange, onToken, onError, title = 'Hosts' }: {
  serverId: string; hosts: Host[]; title?: string; onChange: () => void;
  onToken: (s: { label: string; token: string }) => void; onError: (e: string) => void;
}) {
  const [name, setName] = useState('');
  const create = async () => {
    try {
      const res = await api.post<{ host: Host; token: string }>(`/servers/${serverId}/agent-hosts`, { name: name.trim() });
      setName('');
      onToken({ label: `Host token for "${res.host.name}".`, token: res.token });
      onChange();
    } catch (err) { onError(errorText(err)); }
  };
  const revoke = async (h: Host) => {
    if (!confirm(`Revoke host "${h.name}"? Its token stops working at once and its agents stop waking.`)) return;
    try { await api.delete(`/servers/${serverId}/agent-hosts/${h.id}`); onChange(); } catch (err) { onError(errorText(err)); }
  };
  return (
    <section className="mb-8">
      <h3 className="text-sm font-semibold text-text mb-2">{title}</h3>
      <ul className="mb-3 flex flex-col gap-1">
        {hosts.length === 0 && <li className="text-text-muted text-sm">No hosts yet.</li>}
        {hosts.map(h => (
          <li key={h.id} className="flex items-center justify-between rounded border border-border bg-surface px-3 py-2 text-sm">
            <span className={h.revokedAt ? 'text-text-muted line-through' : 'text-text'}>
              {h.name}
              <span className="ml-2 text-xs text-text-muted">
                {h.revokedAt ? 'revoked' : h.lastSeenAt ? `last seen ${new Date(h.lastSeenAt).toLocaleString()}` : 'never connected'}
              </span>
            </span>
            {!h.revokedAt && <button className="min-h-11 md:min-h-8 px-2 text-xs text-danger hover:underline" onClick={() => void revoke(h)}>Revoke</button>}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input className={input} placeholder="Host name, e.g. my-pc" value={name} maxLength={64} onChange={e => setName(e.target.value)} />
        <Button onClick={() => void create()} disabled={!name.trim()}>Create host</Button>
      </div>
    </section>
  );
}

/** The Create agent form: an agent on one of the owner's machines (unboxed). Shown on Add an agent. */
export function CreateAgentForm({ serverId, hosts, channels, onChange, onToken, onError }: {
  serverId: string; hosts: Host[]; channels: Channel[]; onChange: () => void;
  onToken: (s: { label: string; token: string }) => void; onError: (e: string) => void;
}) {
  const [form, setForm] = useState({ name: '', adapter: 'codex', hostId: '', workdirAlias: 'agora', workspaceId: 'primary', model: '', effort: 'high', channelId: '' });
  // A profile on a machine host runs unboxed; the owner confirms that (docs/agent-boxes.md §10)
  const [unboxedAck, setUnboxedAck] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  const hostId = form.hostId || hosts[0]?.id || '';
  // opencode and omp run on an OpenRouter key, with a named model
  const opencode = form.adapter === 'opencode' || form.adapter === 'omp';

  const create = async () => {
    try {
      const res = await api.post<{ bot: { username: string }; token: string }>(`/servers/${serverId}/agents`, {
        name: form.name.trim().toLowerCase(), adapter: form.adapter, hostId, workdirAlias: form.workdirAlias.trim(),
        workspaceId: form.workspaceId.trim().toLowerCase(), hostModeAck: true,
        ...(form.model.trim() ? { model: form.model.trim() } : {}),
        ...(form.effort ? { effort: form.effort } : {}),
        ...(form.channelId ? { channelId: form.channelId } : {}),
      });
      setForm(f => ({ ...f, name: '' }));
      setUnboxedAck(false);
      onToken({ label: `Bot token for agent "${res.bot.username}".`, token: res.token });
      onChange();
    } catch (err) { onError(errorText(err)); }
  };

  return (
      <div className="rounded border border-border bg-surface p-3">
        <h4 className="mb-2 text-sm font-semibold text-text">Create agent</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <label className="flex flex-col gap-1 text-text-muted">Name (what you type after /start)
            <input className={input} value={form.name} maxLength={32} placeholder="codex" onChange={set('name')} />
          </label>
          <label className="flex flex-col gap-1 text-text-muted">CLI
            <select className={input} value={form.adapter} onChange={set('adapter')}>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
              {/* The host runs it over ACP (gemini --acp) and only with an API key */}
              <option value="gemini">Gemini CLI (ACP, API key)</option>
              {/* opencode acp on an OpenRouter key: any OpenRouter model, one model per agent */}
              <option value="opencode">opencode (ACP, OpenRouter key)</option>
              {/* omp acp on an OpenRouter key only; every write, command and Agora tool asks on a machine */}
              <option value="omp">oh-my-pi (ACP, OpenRouter key)</option>
              {/* devin acp on the owner's own Devin login; only the owner can wake it */}
              <option value="devin">Devin (ACP, your Devin login)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-text-muted">Host
            <select className={input} value={hostId} onChange={set('hostId')}>
              {hosts.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-text-muted">Workdir alias (mapped to a folder in the host config)
            <input className={input} value={form.workdirAlias} maxLength={64} onChange={set('workdirAlias')} />
          </label>
          <label className="flex flex-col gap-1 text-text-muted">{opencode ? 'OpenRouter model ID (required)' : 'Model (optional)'}
            <input className={input} value={form.model} maxLength={64} placeholder={opencode ? 'qwen/qwen3-coder' : 'gpt-6.1-sol'} onChange={set('model')} />
          </label>
          <label className="flex flex-col gap-1 text-text-muted">Workspace ID (same repository = same ID across hosts)
            <input className={input} value={form.workspaceId} maxLength={64} onChange={set('workspaceId')} />
          </label>
          <label className="flex flex-col gap-1 text-text-muted">Effort
            <select className={input} value={form.effort} onChange={set('effort')}>
              {EFFORTS.map(e => <option key={e} value={e}>{e || 'CLI default'}</option>)}
            </select>
          </label>
          <label className="sm:col-span-2 flex flex-col gap-1 text-text-muted">Add to channel (optional)
            <select className={input} value={form.channelId} onChange={set('channelId')}>
              <option value="">None</option>
              {channels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
          </label>
        </div>
        <label className="mt-3 flex min-h-11 md:min-h-8 items-start gap-2 text-sm text-text">
          <input type="checkbox" className="mt-1" checked={unboxedAck} onChange={e => setUnboxedAck(e.target.checked)} />
          <span>Run unboxed on this machine (it can read and change your files). <span className="text-text-muted">Only you can wake an unboxed agent. For anything that doesn&apos;t need this machine, create a box instead.</span></span>
        </label>
        <div className="mt-3">
          <Button onClick={() => void create()} disabled={!unboxedAck || !/^[a-z0-9][a-z0-9_-]*$/i.test(form.name.trim()) || !form.workdirAlias.trim() || (opencode && !form.model.trim())}>
            Create agent
          </Button>
        </div>
      </div>
  );
}

function AgentsSection({ serverId, hosts, allHosts, profiles, channels, plans, onChange, onToken, onError }: {
  serverId: string; hosts: Host[]; allHosts: Host[]; profiles: Profile[]; channels: Channel[]; plans: PlanConnection[]; onChange: () => void;
  onToken: (s: { label: string; token: string }) => void; onError: (e: string) => void;
}) {
  return (
    <section>
      <h3 className="text-lg font-semibold text-text mb-3">Agents</h3>
      <ul className="mb-4 flex flex-col gap-2">
        {profiles.length === 0 && <li className="text-text-muted text-sm">No agents yet.</li>}
        {profiles.map(p => (
          <ProfileRow key={p.id} serverId={serverId} profile={p} host={allHosts.find(h => h.id === p.hostId && !h.revokedAt)} plan={plans.find(x => x.profileId === p.id)}
            onChange={onChange} onError={onError} />
        ))}
      </ul>

      {hosts.length === 0 ? (
        <p className="text-text-muted text-sm">Create a host first.</p>
      ) : (
        <CreateAgentForm serverId={serverId} hosts={hosts} channels={channels} onChange={onChange} onToken={onToken} onError={onError} />
      )}
    </section>
  );
}

/** A limit as its field's text: null stays null ("no limit"). */
const limitText = (n: number | null) => n === null ? null : String(n);
/** A limit field is fine when it is "no limit" or a positive whole number; nothing caps the number. */
const limitOk = (text: string | null) => text === null || validLimit(text);
/** The limits a profile has, for its summary line. */
function limitSummary(p: Pick<Profile, 'wakeBudget' | 'tokenBudget' | 'runTimeoutSec'>): string {
  const set = [
    p.wakeBudget !== null ? `${p.wakeBudget.toLocaleString('en-US')} wakes per session` : null,
    p.tokenBudget !== null ? `${p.tokenBudget.toLocaleString('en-US')} tokens per session` : null,
    p.runTimeoutSec !== null ? `${Math.round(p.runTimeoutSec / 60).toLocaleString('en-US')} min per run` : null,
  ].filter(Boolean);
  return set.length ? set.join(' · ') : 'no limits';
}

export function ProfileRow({ serverId, profile, host, plan, onChange, onError }: {
  serverId: string; profile: Profile; host: Host | undefined; plan?: PlanConnection; onChange: () => void; onError: (e: string) => void;
}) {
  const [model, setModel] = useState(profile.model ?? '');
  const [effort, setEffort] = useState(profile.effort ?? '');
  const [workspaceId, setWorkspaceId] = useState(profile.workspaceId ?? 'primary');
  // Each limit: null is "no limit", else the field's text
  const [wakeBudget, setWakeBudget] = useState(limitText(profile.wakeBudget));
  const validWakeBudget = limitOk(wakeBudget);
  const [tokenBudget, setTokenBudget] = useState(limitText(profile.tokenBudget));
  const validTokenBudget = limitOk(tokenBudget);
  // The host stops a run after this long (agent_profiles.run_timeout_sec, in seconds); shown in minutes
  const savedMinutes = profile.runTimeoutSec === null ? null : String(Math.round(profile.runTimeoutSec / 60));
  const [runMinutes, setRunMinutes] = useState(savedMinutes);
  const validRunMinutes = limitOk(runMinutes) && (runMinutes === null || Number.isSafeInteger(Number(runMinutes) * 60));
  const dirty = model !== (profile.model ?? '') || effort !== (profile.effort ?? '') || workspaceId !== (profile.workspaceId ?? 'primary')
    || wakeBudget !== limitText(profile.wakeBudget) || tokenBudget !== limitText(profile.tokenBudget) || runMinutes !== savedMinutes;
  // opencode's own default is an OpenCode Zen model, so an opencode (or omp) agent always names one
  const opencode = profile.adapter === 'opencode' || profile.adapter === 'omp';
  const boxed = !!profile.boxed;
  const validModel = boxed || !opencode || !!model.trim();

  const save = async () => {
    try {
      if (!validWakeBudget || !validTokenBudget || !validRunMinutes || !validModel) return;
      // A box's profile takes only its session limits here; the rest is in the box's settings
      await api.patch(`/servers/${serverId}/agent-profiles/${profile.id}`, {
        ...(boxed ? {} : { model: model.trim() || null, effort: effort || null, workspaceId: workspaceId.trim().toLowerCase() }),
        wakeBudget: wakeBudget === null ? null : Number(wakeBudget), tokenBudget: tokenBudget === null ? null : Number(tokenBudget),
        // Only when changed: a limit that isn't whole minutes stays as it is
        ...(runMinutes !== savedMinutes ? { runTimeoutSec: runMinutes === null ? null : Number(runMinutes) * 60 } : {}) });
      onChange();
    } catch (err) { onError(errorText(err)); }
  };
  const remove = async () => {
    if (!confirm(`Delete agent profile "${profile.name}"? Its bot stays; end its sessions first.`)) return;
    try { await api.delete(`/servers/${serverId}/agent-profiles/${profile.id}`); onChange(); } catch (err) { onError(errorText(err)); }
  };

  return (
    <li className="rounded border border-border bg-surface px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-text">
          <span className="font-medium">{profile.name}</span>
          <BoxModeBadge profile={profile} className="ml-2" />
          <span className="ml-2 text-xs text-text-muted">
            {profile.adapter} · {host?.name ?? 'revoked host'} · workdir {profile.workdirAlias} · {limitSummary(profile)}
          </span>
          <AuthBadge profile={profile} />
        </span>
        <button className="min-h-11 md:min-h-8 px-2 text-xs text-danger hover:underline" onClick={() => void remove()}>Delete</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!boxed && <>
          <label className="flex flex-col text-xs text-text-muted">Workspace ID (end sessions before changing)
            <input className={input} value={workspaceId} maxLength={64} onChange={e => setWorkspaceId(e.target.value)} />
          </label>
          <input className={input} value={model} placeholder={opencode ? 'OpenRouter model ID (required)' : 'model (CLI default)'} maxLength={64}
            aria-label={`Model for ${profile.name}`} onChange={e => setModel(e.target.value)} />
          <select className={input} value={effort} onChange={e => setEffort(e.target.value)}>
            {EFFORTS.map(e => <option key={e} value={e}>{e || 'CLI default'}</option>)}
          </select>
        </>}
      </div>
      <section className="mt-2" aria-label={`Limits for ${profile.name}`}>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Limits (optional)</h4>
        <LimitRow label="Wakes per session" unit="wakes" name={`Wakes per session for ${profile.name}`} value={wakeBudget} onChange={setWakeBudget} invalid={!validWakeBudget}
          hint="Shelves a session after this many wakes. A wake is one run the agent starts to handle new messages." />
        <LimitRow label="Tokens per session" unit="tokens" name={`Tokens per session for ${profile.name}`} value={tokenBudget} onChange={setTokenBudget} invalid={!validTokenBudget}
          hint="Shelves a session once it and its subtasks have used this many tokens. Claude counts cached context, so long runs use millions." />
        <LimitRow label="Time per run" unit="minutes" name={`Time per run for ${profile.name}`} value={runMinutes} onChange={setRunMinutes} invalid={!validRunMinutes}
          hint="Stops a single run after this long. With no limit a run ends when the agent finishes or you end its session." />
        <p className="mt-1 text-xs text-text-muted">
          A change applies to this agent's existing sessions at once. A session a limit already stopped stays shelved until you resume it.
        </p>
      </section>
      <label className="mt-2 flex min-h-11 items-start gap-2 text-sm text-text" data-testid={`live-output-${profile.name}`}>
        <input type="checkbox" className="mt-1" aria-label={`Show live output for ${profile.name}`} checked={profile.showLiveOutput !== false}
          onChange={e => void (async () => {
            try { await api.patch(`/servers/${serverId}/agent-profiles/${profile.id}`, { showLiveOutput: e.target.checked }); onChange(); }
            catch (err) { onError(errorText(err)); }
          })()} />
        <span>Show live output
          <span className="block text-xs text-text-muted">While this agent works, people in the channel see its text as it is written and its steps (reading a file, running a command). Its reasoning, file contents and command output are never shown. Turn it off to see nothing until its final post.</span>
        </span>
      </label>
      {dirty && (
        <div className="mt-2">
          <Button variant="secondary" disabled={!validWakeBudget || !validTokenBudget || !validRunMinutes || !validModel} onClick={() => void save()}>Save</Button>
        </div>
      )}
      {/* A box logs its CLI in from its Boxes entry instead */}
      {profile.adapter === 'codex' && host && host.kind !== 'box' && !profile.boxed && (
        <ChatGPTPlanConnect serverId={serverId} profileId={profile.id} hostName={host.name} plan={plan}
          siwcMode={profile.authMode === 'siwc'} onChange={onChange} />
      )}
      <ToolPermissions serverId={serverId} profile={profile} onChange={onChange} onError={onError} />
    </li>
  );
}

/** How the agent's CLI signs in, as its host reported it (docs/provider-terms.md). */
function AuthBadge({ profile }: { profile: Profile }) {
  const mode = profile.authMode ?? 'subscription';
  const tone = mode === 'api_key' ? 'bg-online/20 text-online' : 'bg-warn/20 text-warn';
  const detail = !profile.authReportedAt
    ? 'not reported by its host yet, so treated as a subscription'
    : mode === 'api_key' ? `key from ${profile.apiKeyEnv}`
    : mode === 'siwc' ? (profile.planOwnerId ? 'only the person who connected their plan can wake it' : 'no ChatGPT plan connected yet')
    : 'only you can wake it';
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted" data-testid={`auth-${profile.name}`}>
      <span className={`rounded px-1.5 py-0.5 font-semibold leading-none ${tone}`}>{authLabel(mode, profile.runApproval)}</span>
      {detail}
    </span>
  );
}

/**
 * Tool presets and always-allowed tools (#73). Saved on the server; the host reads them at
 * its next claim, so no host restart. Approving "always" on a tool card adds to the list.
 */
function ToolPermissions({ serverId, profile, onChange, onError }: {
  serverId: string; profile: Profile; onChange: () => void; onError: (e: string) => void;
}) {
  const presets = profile.toolPresets ?? [];
  const allowed = profile.allowedTools ?? [];
  const [rule, setRule] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = TOOL_RULE.test(rule.trim()) && !allowed.includes(rule.trim());

  const patch = async (body: { toolPresets?: string[]; allowedTools?: string[] }) => {
    setBusy(true);
    try { await api.patch(`/servers/${serverId}/agent-profiles/${profile.id}`, body); onChange(); }
    catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  };
  const toggle = (name: string) => void patch({ toolPresets: presets.includes(name) ? presets.filter(p => p !== name) : [...presets, name] });

  return (
    <div className="mt-3 border-t border-border pt-2">
      <div className="mb-1 text-xs font-semibold text-text-muted">Tools</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1" role="group" aria-label={`Tool presets for ${profile.name}`}>
        {PRESETS.map(p => (
          <label key={p.name} className="flex min-h-11 md:min-h-8 items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={presets.includes(p.name)} disabled={busy} onChange={() => toggle(p.name)} />
            {p.label} <span className="text-xs text-text-muted">{p.detail}</span>
          </label>
        ))}
        {presets.filter(n => !PRESETS.some(p => p.name === n)).map(n => (
          <label key={n} className="flex min-h-11 md:min-h-8 items-center gap-2 text-sm text-text">
            <input type="checkbox" checked disabled={busy} onChange={() => toggle(n)} /> {n} <span className="text-xs text-text-muted">from host config</span>
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-text-muted">
        {presets.length === 0 ? 'No preset: the host config alone decides.' : 'Changes apply from the next wake; no host restart.'}
      </p>
      {allowed.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label={`Always allowed tools for ${profile.name}`}>
          {allowed.map(t => (
            <li key={t} className="flex items-center gap-1 rounded border border-border bg-bg px-2 font-mono text-xs text-text">
              <span className="break-all">{t}</span>
              <button className="min-h-11 min-w-11 md:min-h-7 md:min-w-7 text-danger" disabled={busy} aria-label={`Remove ${t}`}
                onClick={() => void patch({ allowedTools: allowed.filter(a => a !== t) })}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-2">
        <input className={`${input} flex-1 font-mono`} value={rule} placeholder="Always allow, e.g. Bash(cargo:*)" maxLength={310}
          aria-label={`Add an always-allowed tool for ${profile.name}`} onChange={e => setRule(e.target.value)} />
        <Button variant="secondary" disabled={!valid || busy} onClick={() => { const t = rule.trim(); setRule(''); void patch({ allowedTools: [...allowed, t] }); }}>Add</Button>
      </div>
    </div>
  );
}

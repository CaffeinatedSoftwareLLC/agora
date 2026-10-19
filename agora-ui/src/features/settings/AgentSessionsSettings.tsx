import { useCallback, useEffect, useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { api, serverApi, ApiError } from '../../lib/api';
import type { Channel } from '../../lib/contracts/server';
import { Button } from '../../components/ui/Button';

/**
 * Agent hosts and agents (docs/planning/agent-sessions-wbs.md, S6). The owner registers the
 * machine that runs agents (a host) and creates agents on it; members then use /start in a
 * channel. Tokens are shown once and go into the host's config file, never into a channel.
 */

interface Host { id: string; name: string; createdAt: string; lastSeenAt: string | null; revokedAt: string | null }
interface Profile {
  id: string; name: string; botId: string; hostId: string; adapter: 'codex' | 'claude';
  model: string | null; effort: string | null; workdirAlias: string; workspaceId?: string;
  wakeBudget: number; tokenBudget: number; runTimeoutSec: number;
  toolPresets?: string[]; allowedTools?: string[];
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

function OnceToken({ label, token, onDone }: { label: string; token: string; onDone: () => void }) {
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
  const [hosts, setHosts] = useState<Host[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
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
    ]).then(([h, p, c]) => {
      if (cancelled) return;
      setHosts(h);
      setProfiles(p);
      setChannels(c.filter(ch => ch.channelType === 3));
      setError('');
    }).catch(err => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [serverId, reloadKey]);

  if (!serverId) return null;
  const activeHosts = hosts.filter(h => !h.revokedAt);

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold text-text mb-2">Agents</h2>
      <p className="text-text-muted text-sm mb-6">
        An agent host runs on the machine with your agent CLIs and wakes agents when they are addressed. Create a host,
        put its token in the host's config, then create agents on it. In a channel, <code>/start &lt;agent&gt;</code> starts a session.
      </p>
      {error && <p className="text-danger text-sm mb-4">{error}</p>}
      {secret && <OnceToken label={secret.label} token={secret.token} onDone={() => setSecret(null)} />}

      <HostsSection serverId={serverId} hosts={hosts} onChange={load} onToken={setSecret} onError={setError} />
      <AgentsSection serverId={serverId} hosts={activeHosts} profiles={profiles} channels={channels}
        onChange={load} onToken={setSecret} onError={setError} />
    </div>
  );
}

function HostsSection({ serverId, hosts, onChange, onToken, onError }: {
  serverId: string; hosts: Host[]; onChange: () => void;
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
      <h3 className="text-lg font-semibold text-text mb-3">Hosts</h3>
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

function AgentsSection({ serverId, hosts, profiles, channels, onChange, onToken, onError }: {
  serverId: string; hosts: Host[]; profiles: Profile[]; channels: Channel[]; onChange: () => void;
  onToken: (s: { label: string; token: string }) => void; onError: (e: string) => void;
}) {
  const [form, setForm] = useState({ name: '', adapter: 'codex', hostId: '', workdirAlias: 'agora', workspaceId: 'primary', model: '', effort: 'high', channelId: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  const hostId = form.hostId || hosts[0]?.id || '';

  const create = async () => {
    try {
      const res = await api.post<{ bot: { username: string }; token: string }>(`/servers/${serverId}/agents`, {
        name: form.name.trim().toLowerCase(), adapter: form.adapter, hostId, workdirAlias: form.workdirAlias.trim(),
        workspaceId: form.workspaceId.trim().toLowerCase(),
        ...(form.model.trim() ? { model: form.model.trim() } : {}),
        ...(form.effort ? { effort: form.effort } : {}),
        ...(form.channelId ? { channelId: form.channelId } : {}),
      });
      setForm(f => ({ ...f, name: '' }));
      onToken({ label: `Bot token for agent "${res.bot.username}".`, token: res.token });
      onChange();
    } catch (err) { onError(errorText(err)); }
  };

  return (
    <section>
      <h3 className="text-lg font-semibold text-text mb-3">Agents</h3>
      <ul className="mb-4 flex flex-col gap-2">
        {profiles.length === 0 && <li className="text-text-muted text-sm">No agents yet.</li>}
        {profiles.map(p => (
          <ProfileRow key={p.id} serverId={serverId} profile={p} host={hosts.find(h => h.id === p.hostId)} onChange={onChange} onError={onError} />
        ))}
      </ul>

      {hosts.length === 0 ? (
        <p className="text-text-muted text-sm">Create a host first.</p>
      ) : (
        <div className="rounded border border-border bg-surface p-3">
          <h4 className="mb-2 text-sm font-semibold text-text">Create agent</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <label className="flex flex-col gap-1 text-text-muted">Name (bot and /start name)
              <input className={input} value={form.name} maxLength={32} placeholder="codex" onChange={set('name')} />
            </label>
            <label className="flex flex-col gap-1 text-text-muted">CLI
              <select className={input} value={form.adapter} onChange={set('adapter')}>
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
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
            <label className="flex flex-col gap-1 text-text-muted">Model (optional)
              <input className={input} value={form.model} maxLength={64} placeholder="gpt-6.1-sol" onChange={set('model')} />
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
          <div className="mt-3">
            <Button onClick={() => void create()} disabled={!/^[a-z0-9][a-z0-9_-]*$/i.test(form.name.trim()) || !form.workdirAlias.trim()}>
              Create agent
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function ProfileRow({ serverId, profile, host, onChange, onError }: {
  serverId: string; profile: Profile; host: Host | undefined; onChange: () => void; onError: (e: string) => void;
}) {
  const [model, setModel] = useState(profile.model ?? '');
  const [effort, setEffort] = useState(profile.effort ?? '');
  const [workspaceId, setWorkspaceId] = useState(profile.workspaceId ?? 'primary');
  const dirty = model !== (profile.model ?? '') || effort !== (profile.effort ?? '') || workspaceId !== (profile.workspaceId ?? 'primary');

  const save = async () => {
    try {
      await api.patch(`/servers/${serverId}/agent-profiles/${profile.id}`, { model: model.trim() || null, effort: effort || null, workspaceId: workspaceId.trim().toLowerCase() });
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
          <span className="ml-2 text-xs text-text-muted">
            {profile.adapter} · {host?.name ?? 'revoked host'} · workdir {profile.workdirAlias} · {profile.wakeBudget} wakes · {profile.tokenBudget.toLocaleString()} tokens per session
          </span>
        </span>
        <button className="min-h-11 md:min-h-8 px-2 text-xs text-danger hover:underline" onClick={() => void remove()}>Delete</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex flex-col text-xs text-text-muted">Workspace ID (end sessions before changing)
          <input className={input} value={workspaceId} maxLength={64} onChange={e => setWorkspaceId(e.target.value)} />
        </label>
        <input className={input} value={model} placeholder="model (CLI default)" maxLength={64} onChange={e => setModel(e.target.value)} />
        <select className={input} value={effort} onChange={e => setEffort(e.target.value)}>
          {EFFORTS.map(e => <option key={e} value={e}>{e || 'CLI default'}</option>)}
        </select>
        {dirty && <Button variant="secondary" onClick={() => void save()}>Save</Button>}
      </div>
      <ToolPermissions serverId={serverId} profile={profile} onChange={onChange} onError={onError} />
    </li>
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

import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { api, ApiError } from '../../lib/api';
import { AGORA_MCP_INSTALL_COMMAND, clientHasProjectScope, inviteCommand, type InviteClient, type InviteScope } from './inviteCommand';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
/** Where an agent can reach this instance: on the same computer (plain HTTP on the API port), or from elsewhere (HTTPS). */
type AgentAddresses = { local: string; remote: string[] };

/** The page's own origin, when another computer could use it too. */
function pageRemoteOrigin(): string | null {
  return location.protocol === 'https:' && !LOCAL_HOSTS.includes(location.hostname) ? location.origin : null;
}
function isLocalAddress(value: string): boolean {
  try { return LOCAL_HOSTS.includes(new URL(value).hostname); } catch { return false; }
}

export function CreateAgentInviteModal({ serverId, botId, onClose, onCreated }: {
  serverId: string; botId?: string; onClose: () => void; onCreated: () => void;
}) {
  const [username, setUsername] = useState('');
  const [client, setClient] = useState<InviteClient>('claude');
  // Until the server answers (or if it cannot): the page's origin, or the default API port on a localhost page.
  const [addresses, setAddresses] = useState<AgentAddresses>(() => {
    const page = pageRemoteOrigin();
    return { local: 'http://localhost:3000', remote: page ? [page] : [] };
  });
  const [instance, setInstance] = useState(() => pageRemoteOrigin() ?? 'http://localhost:3000');
  const instanceTouched = useRef(false);
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'' | 'install' | 'setup'>('');
  const [scope, setScope] = useState<InviteScope>('project');
  const command = invite ? inviteCommand(client, instance, invite.code, scope) : '';

  // The server knows its real API port and the HTTPS names it is served at (CORS_ORIGIN).
  useEffect(() => {
    let cancelled = false;
    api.get<AgentAddresses>(`/servers/${serverId}/agent-invites/addresses`).then(res => {
      if (cancelled || typeof res?.local !== 'string' || !Array.isArray(res.remote)) return;
      const page = pageRemoteOrigin();
      const remote = [...new Set([...(page ? [page] : []), ...res.remote.filter(r => typeof r === 'string')])];
      setAddresses({ local: res.local, remote });
      // An agent on another computer is the case a localhost address silently breaks, so prefer the remote one.
      if (!instanceTouched.current) setInstance(remote[0] ?? res.local);
    }).catch(() => { /* older server or no permission: keep the defaults above */ });
    return () => { cancelled = true; };
  }, [serverId]);

  const choices = [...addresses.remote, addresses.local];
  function chooseInstance(value: string) { instanceTouched.current = true; setInstance(value); }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    let origin: string;
    try {
      const url = new URL(instance);
      // This origin goes into a shell command; accept only canonical host/port characters.
      if (!/^https?:\/\/[a-z0-9.:[\]-]+$/i.test(url.origin) || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
          (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname)))) throw new Error();
      origin = url.origin;
    } catch { setError('Use an HTTPS instance URL, or HTTP on localhost.'); return; }
    instanceTouched.current = true;
    setInstance(origin);
    setLoading(true);
    try {
      setInvite(await api.post(`/servers/${serverId}/agent-invites`, botId ? { botId } : { username: username.trim() }));
      onCreated();
    } catch (err) { setError(err instanceof ApiError ? err.code : 'Failed to create invite'); }
    finally { setLoading(false); }
  }

  async function copy(what: 'install' | 'setup', text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); }
    catch { setError('Clipboard unavailable. Select and copy the command above.'); }
  }

  const selectClass = 'ml-2 bg-surface border border-border rounded p-2';
  const preClass = 'bg-bg border border-border rounded p-3 text-text text-xs whitespace-pre-wrap break-all select-all';

  return <Modal isOpen onClose={onClose} title="Invite Agent">
    {error && <p role="alert" className="text-danger text-sm mb-3">{error}</p>}
    {!invite ? <form onSubmit={create} className="flex flex-col gap-4">
      {!botId && <Input label="New bot username" value={username} onChange={e => setUsername(e.target.value)} maxLength={32} />}
      {addresses.remote.length > 0 && <label className="text-text text-sm">Where will this agent run?
        <select aria-label="Where will this agent run?" value={choices.includes(instance) ? instance : ''}
          onChange={e => { if (e.target.value) chooseInstance(e.target.value); }} className={`${selectClass} max-w-full`}>
          {addresses.remote.map(r => <option key={r} value={r}>On another computer ({r})</option>)}
          <option value={addresses.local}>On the same computer as Agora ({addresses.local})</option>
          {!choices.includes(instance) && <option value="">Another address (typed below)</option>}
        </select>
      </label>}
      <Input label="Instance URL reachable by the agent" value={instance} onChange={e => chooseInstance(e.target.value)} />
      {isLocalAddress(instance) && <p className="text-text-muted text-sm">A localhost address only works for an agent on the same computer as Agora.{addresses.remote.length === 0 && ' For an agent on another computer, type the HTTPS address that computer reaches Agora at.'}</p>}
      {!botId && <p className="text-text-muted text-sm">Creates a new bot with access to #general.</p>}
      <Button type="submit" loading={loading} disabled={!botId && !username.trim()}>Create Invite</Button>
    </form> : <div className="flex flex-col gap-3">
      <p className="text-text-muted text-sm">Single use. Expires {new Date(invite.expiresAt).toLocaleTimeString()}. Start the agent before it expires.</p>
      <label className="text-text text-sm">Agent
        <select aria-label="Agent" value={client} onChange={e => { setClient(e.target.value as InviteClient); setCopied(''); }} className={selectClass}>
          <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option>
        </select>
      </label>
      {clientHasProjectScope(client) ? <>
        <label className="text-text text-sm">Connect in
          <select aria-label="Connect in" value={scope} onChange={e => { setScope(e.target.value as InviteScope); setCopied(''); }} className={selectClass}>
            <option value="project">This project only</option><option value="user">All projects on this computer</option>
          </select>
        </label>
        <p className="text-text-muted text-xs">{scope === 'project'
          ? 'Run the command in the project’s folder. Only that project’s sessions become this bot, so another project can have its own.'
          : 'Every project on this computer becomes this bot. Two sessions that should talk to each other need different bots, so prefer one project each.'}</p>
      </> : <p className="text-text-muted text-xs">{client === 'codex' ? 'Codex' : 'Gemini CLI'} registers the server for all projects on this computer.</p>}

      <h3 className="text-text text-sm font-semibold mt-2">1. Install agora-mcp (once per computer)</h3>
      <p className="text-text-muted text-xs">Run this on the computer where the agent runs (it needs Node.js). Skip it if <code>agora-mcp --version</code> already prints a version there. agora-mcp is not on the npm registry; the agora-mcp package there is old and must not be used.</p>
      <pre aria-label="Install command" className={preClass}>{AGORA_MCP_INSTALL_COMMAND}</pre>
      <Button variant="secondary" onClick={() => copy('install', AGORA_MCP_INSTALL_COMMAND)}>{copied === 'install' ? 'Copied!' : 'Copy Install Command'}</Button>

      <h3 className="text-text text-sm font-semibold mt-2">2. Connect</h3>
      <p className="text-text-muted text-xs">Run this on the same computer, then restart the agent.</p>
      <pre aria-label="Setup command" className={preClass}>{command}</pre>
      <Button onClick={() => copy('setup', command)}>{copied === 'setup' ? 'Copied!' : 'Copy Setup Command'}</Button>
      <p className="text-text-muted text-xs">If the agent reports <code>ENOENT</code> for agora (for example “Failed to reconnect to agora: ENOENT”), agora-mcp is not installed on that computer. Do step 1 there, then reconnect.</p>

      <p className="text-text-muted text-xs break-all">Invite link (use with --invite): {instance}/#agora-invite={invite.code}</p>
      <p className="text-text-muted text-xs">The agent saves its token locally. Use a separate invite for each agent identity. Revoke issued tokens in this bot’s Tokens section.</p>
      <Button variant="secondary" onClick={onClose}>Done</Button>
    </div>}
  </Modal>;
}

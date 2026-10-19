import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { api, ApiError } from '../../lib/api';

export type InviteClient = 'claude' | 'codex' | 'gemini';
export function inviteCommand(client: InviteClient, instance: string, code: string): string {
  const args = `--instance "${instance}" --channel general --invite ${code}`;
  if (client === 'claude') return `claude mcp add --transport stdio --scope user agora -- agora-mcp ${args}`;
  if (client === 'codex') return `codex mcp add agora -- agora-mcp ${args}`;
  return `gemini mcp add --scope user agora agora-mcp -- ${args}`;
}

export function CreateAgentInviteModal({ serverId, botId, onClose, onCreated }: {
  serverId: string; botId?: string; onClose: () => void; onCreated: () => void;
}) {
  const [username, setUsername] = useState('');
  const [client, setClient] = useState<InviteClient>('claude');
  const [instance, setInstance] = useState(['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
    ? 'http://localhost:3000' : location.origin);
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const command = invite ? inviteCommand(client, instance, invite.code) : '';

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    let origin: string;
    try {
      const url = new URL(instance);
      // This origin goes into a shell command; accept only canonical host/port characters.
      if (!/^https?:\/\/[a-z0-9.:[\]-]+$/i.test(url.origin) || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
          (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error();
      origin = url.origin;
    } catch { setError('Use an HTTPS instance URL, or HTTP on localhost.'); return; }
    setInstance(origin);
    setLoading(true);
    try {
      setInvite(await api.post(`/servers/${serverId}/agent-invites`, botId ? { botId } : { username: username.trim() }));
      onCreated();
    } catch (err) { setError(err instanceof ApiError ? err.code : 'Failed to create invite'); }
    finally { setLoading(false); }
  }

  return <Modal isOpen onClose={onClose} title="Invite Agent">
    {error && <p role="alert" className="text-danger text-sm mb-3">{error}</p>}
    {!invite ? <form onSubmit={create} className="flex flex-col gap-4">
      {!botId && <Input label="New bot username" value={username} onChange={e => setUsername(e.target.value)} maxLength={32} />}
      <Input label="Instance URL reachable by the agent" value={instance} onChange={e => setInstance(e.target.value)} />
      {!botId && <p className="text-text-muted text-sm">Creates a new bot with access to #general.</p>}
      <Button type="submit" loading={loading} disabled={!botId && !username.trim()}>Create Invite</Button>
    </form> : <div className="flex flex-col gap-3">
      <p className="text-text-muted text-sm">Single use. Expires {new Date(invite.expiresAt).toLocaleTimeString()}. Start the agent before it expires.</p>
      <label className="text-text text-sm">Agent
        <select aria-label="Agent" value={client} onChange={e => { setClient(e.target.value as InviteClient); setCopied(false); }} className="ml-2 bg-surface border border-border rounded p-2">
          <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option>
        </select>
      </label>
      <p className="text-text-muted text-sm">Install the MCP server first: npm install -g @caffeinated-software/agora-mcp (not the old unscoped agora-mcp package). Copy this command to the agent, then restart it to connect.</p>
      <pre aria-label="Setup command" className="bg-bg border border-border rounded p-3 text-text text-xs whitespace-pre-wrap break-all select-all">{command}</pre>
      <Button onClick={async () => {
        try { await navigator.clipboard.writeText(command); setCopied(true); }
        catch { setError('Clipboard unavailable. Select and copy the command above.'); }
      }}>{copied ? 'Copied!' : 'Copy Setup Command'}</Button>
      <p className="text-text-muted text-xs break-all">Invite link (use with --invite): {instance}/#agora-invite={invite.code}</p>
      <p className="text-text-muted text-xs">The agent saves its token locally. Use a separate invite for each agent identity. Revoke issued tokens in this bot’s Tokens section.</p>
      <Button variant="secondary" onClick={onClose}>Done</Button>
    </div>}
  </Modal>;
}

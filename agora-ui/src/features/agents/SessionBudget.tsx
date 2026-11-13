import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';
import { type AgentSession, limitStopText, limitValue, runAgentCommand, validLimit } from './agentSessions';

const count = (n: number) => n.toLocaleString('en-US');
const usage = (used: number, limit: number | null | undefined, unit: string) =>
  limit == null ? `${count(used)} ${unit} · no limit` : `${count(used)} / ${count(limit)} ${unit}`;
const SETTINGS = <Link to="/settings/agents" className="underline">Settings → Agents</Link>;

/** limitStopText with its "Settings → Agents" as a link. */
function Stop({ session }: { session: AgentSession }) {
  const [before, after] = limitStopText(session).split('Settings → Agents');
  return after === undefined ? <>{before}</> : <>{before}{SETTINGS}{after}</>;
}

/** A hosted session's usage against its limits (none unless the owner set one), and what stopped it. */
export function SessionBudget({ session, channelId, onChanged }: { session: AgentSession; channelId: string; onChanged: () => void }) {
  const userId = useAuthStore(s => s.user?.id);
  const serverId = useChannelStore(s => s.channels.get(channelId)?.serverId);
  const ownerId = useServerStore(s => serverId ? s.servers.get(serverId)?.ownerId : null);
  const [limit, setLimit] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // A terminal session is the user's own CLI: Agora can't limit it
  if (session.kind === 'terminal') return null;
  const save = async () => {
    setBusy(true);
    try {
      await runAgentCommand(channelId, { command: 'budget', sessionId: session.id, tokenBudget: limitValue(limit) });
      setNotice(limit.trim() ? 'Limit saved.' : "This session now follows its agent's setting."); onChanged();
    } catch { setNotice('Could not save the limit. Check your permissions and try again.'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-2 text-sm">
    <p className="text-text-muted">
      <span>{usage(session.wakesUsed, session.wakeBudget, 'wakes')}</span>{' · '}<span>{usage(session.tokensUsed, session.tokenBudget, 'tokens')}</span>
    </p>
    {session.state === 'shelved' && session.endReason === 'budget' && (
      <p role="alert" className="rounded-lg border border-border bg-bg/60 p-3"><Stop session={session} /></p>
    )}
    {userId && userId === ownerId && session.state !== 'ended' && <details>
      <summary className="min-h-[44px] cursor-pointer py-2 md:min-h-0">Give this session its own token limit</summary>
      <label className="block text-text-muted">This session's own token limit
        <input aria-label="This session's own token limit" type="number" min="1" step="1" inputMode="numeric" placeholder="None: follows the agent's setting"
          value={limit} onChange={e => setLimit(e.target.value)} className="block min-h-[44px] w-full rounded border border-border bg-bg px-2 text-text" />
      </label>
      <p className="py-1 text-xs text-text-muted">Optional. Leave empty to follow "Tokens per session" in {SETTINGS}, which has no limit unless you set one.</p>
      <button type="button" disabled={busy || !validLimit(limit, true)} onClick={() => void save()} className="min-h-[44px] underline disabled:opacity-50">Save limit</button>
    </details>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}

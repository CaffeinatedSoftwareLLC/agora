import { useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';
import { type AgentSession, runAgentCommand } from './agentSessions';

export function SessionBudget({ session, channelId, onChanged }: { session: AgentSession; channelId: string; onChanged: () => void }) {
  const userId = useAuthStore(s => s.user?.id);
  const serverId = useChannelStore(s => s.channels.get(channelId)?.serverId);
  const ownerId = useServerStore(s => serverId ? s.servers.get(serverId)?.ownerId : null);
  const [budget, setBudget] = useState(String(session.tokenBudget ?? ''));
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  if (!session.tokenBudget) return null;
  const save = async () => {
    setBusy(true);
    try {
      await runAgentCommand(channelId, { command: 'budget', sessionId: session.id, tokenBudget: Number(budget) });
      setNotice('Budget saved. Resume the session when ready.'); onChanged();
    } catch { setNotice('Could not save the budget. Check your permissions and try again.'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-2 text-sm">
    <p>{session.tokensUsed.toLocaleString()} / {session.tokenBudget.toLocaleString()} tokens used</p>
    {session.endReason === 'budget' && <p>Paused: session budget used up.</p>}
    {userId && userId === ownerId && session.state !== 'ended' && <label className="block">Session token budget
      <input aria-label="Session token budget" type="number" min="1" step="1" value={budget} onChange={e => setBudget(e.target.value)} className="block min-h-[44px] w-full rounded border border-border bg-bg px-2" />
      <button type="button" disabled={busy || !Number.isSafeInteger(Number(budget)) || Number(budget) < 1} onClick={() => void save()} className="min-h-[44px] underline">Save budget</button>
    </label>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}

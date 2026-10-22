import { useEffect, useState } from 'react';
import { ApiError, botApi, serverApi, type BotDetail } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';

// Match the existing channel bot endpoints: Administrator or ManageBots.
const MANAGE_BOTS = (1n << 0n) | (1n << 27n);

export function ChannelAgentsControl({ channelId, serverId }: { channelId: string; serverId: string | null }) {
  const userId = useAuthStore(s => s.user?.id);
  const ownerId = useServerStore(s => serverId ? s.servers.get(serverId)?.ownerId : undefined);
  const [access, setAccess] = useState<{ key: string; allowed: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [hasAgents, setHasAgents] = useState<boolean | null>(null);
  const key = `${serverId}:${userId}`;
  const owner = !!userId && userId === ownerId;
  useEffect(() => {
    if (!serverId || !userId || owner) return;
    let active = true;
    serverApi.getAccess(serverId).then(data => {
      if (active) setAccess({ key, allowed: (BigInt(data.permissions) & MANAGE_BOTS) !== 0n });
    }).catch(() => { if (active) setAccess({ key, allowed: false }); });
    return () => { active = false; };
  }, [serverId, userId, owner, key]);

  if (!serverId || !(owner || (access?.key === key && access.allowed))) return null;
  return <>
    <span className="flex shrink-0 items-center gap-2">
      {hasAgents === false && <span className="text-xs text-text-muted">No agents in this channel ·</span>}
      <button type="button" aria-label="Add agent to channel" aria-haspopup="dialog"
        className="flex shrink-0 items-center gap-2 min-h-11 rounded-lg border border-primary/40 bg-primary/15 px-3 text-[13px] font-semibold text-primary-text hover:bg-primary/25 focus-visible:outline-accent"
        onClick={() => setOpen(true)}>
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="7" r="4" /><path d="M2 21v-2a6 6 0 0 1 12 0v2M19 8v8M15 12h8" />
        </svg>
        ＋ Add agent
      </button>
    </span>
    <ChannelAgentsDialog key={channelId} channelId={channelId} serverId={serverId} isOpen={open}
      onMembershipChange={setHasAgents} onClose={() => setOpen(false)} />
  </>;
}

export function ChannelAgentsDialog({ channelId, serverId, isOpen = true, onMembershipChange, onClose }: {
  channelId: string; serverId: string; isOpen?: boolean; onMembershipChange?: (value: boolean | null) => void; onClose: () => void;
}) {
  const [bots, setBots] = useState<BotDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  // The closed dialog preloads membership for the empty state; opening refreshes
  // it so changes made elsewhere are reflected in the management controls.
  useEffect(() => { if (isOpen) setReload(n => n + 1); }, [isOpen]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    botApi.list(serverId)
      .then(list => Promise.all(list.map(bot => botApi.get(serverId, bot.id))))
      .then(list => { if (active) setBots(list); })
      .catch(() => { if (active) setError('Could not load channel agents. Try again.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [serverId, reload]);
  useEffect(() => {
    onMembershipChange?.(loading || error ? null : bots.some(bot => bot.channels.some(c => c.id === channelId)));
  }, [bots, channelId, loading, error, onMembershipChange]);

  async function toggle(bot: BotDetail) {
    if (saving) return;
    const present = bot.channels.some(c => c.id === channelId);
    setSaving(bot.id);
    setError('');
    setNotice('');
    try {
      if (present) await botApi.revokeChannel(channelId, bot.id);
      else await botApi.grantChannel(channelId, bot.id);
      setBots(list => list.map(b => b.id !== bot.id ? b : {
        ...b, channels: present ? b.channels.filter(c => c.id !== channelId)
          : [...b.channels, { id: channelId, name: '', channelType: 3 }],
      }));
      setNotice(present ? `${bot.username} removed from this channel.` : `${bot.username} added. You can now use /start with its agent profile.`);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You no longer have permission to manage channel agents.'
        : 'Could not change agent access. Refresh the list and try again.');
    } finally { setSaving(null); }
  }

  return <Modal isOpen={isOpen} onClose={onClose} title="Channel agents">
    <p className="text-sm text-text-muted mb-3">Add agents here before starting them. People join the server; this list controls agents in this channel.</p>
    {error && <div role="alert" className="text-sm text-danger mb-3">{error} <button type="button" className="min-h-11 underline" disabled={loading || !!saving} onClick={() => setReload(n => n + 1)}>Refresh list</button></div>}
    {loading ? <p className="text-text-muted">Loading agents…</p> : <>
      {!bots.length && !error && <p className="text-sm text-text-muted">No agents on this server yet. Create or invite one in Settings → Bots.</p>}
      <ul className="max-h-[50dvh] overflow-y-auto divide-y divide-border">
        {bots.map(bot => {
          const present = bot.channels.some(c => c.id === channelId);
          return <li key={bot.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1"><p className="truncate text-text">{bot.username}</p><p className="text-xs text-text-muted">{present ? 'In this channel' : 'Not added'}</p></div>
            <Button variant="secondary" aria-label={`${present ? 'Remove' : 'Add'} ${bot.username}`} disabled={!!saving} loading={saving === bot.id} onClick={() => void toggle(bot)}>{present ? 'Remove' : 'Add'}</Button>
          </li>;
        })}
      </ul>
    </>}
    <p role="status" className="text-sm text-text-muted mt-2">{notice}</p>
    <div className="flex justify-end mt-3"><Button variant="secondary" onClick={onClose}>Done</Button></div>
  </Modal>;
}

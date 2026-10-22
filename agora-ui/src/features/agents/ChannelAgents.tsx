import { useEffect, useRef, useState } from 'react';
import { ApiError, botApi, serverApi, type ChannelAgent } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useMemberStore } from '../../stores/memberStore';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';

// Match the existing channel bot endpoints: Administrator or ManageBots.
const MANAGE_BOTS = (1n << 0n) | (1n << 27n);

export function ChannelAgentsControl({ channelId, serverId }: { channelId: string; serverId: string | null }) {
  const userId = useAuthStore(s => s.user?.id);
  const ownerId = useServerStore(s => serverId ? s.servers.get(serverId)?.ownerId : undefined);
  const [access, setAccess] = useState<{ key: string; allowed: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [membership, setMembership] = useState<{ scope: string; ids: string[]; hasMore: boolean } | null>(null);
  const membershipChanges = useRef<{ scope: string; values: Map<string, boolean> }>({ scope: '', values: new Map() });
  const key = `${serverId}:${userId}`;
  const owner = !!userId && userId === ownerId;
  const allowed = !!serverId && (owner || (access?.key === key && access.allowed));
  const scope = `${key}:${channelId}`;
  useEffect(() => {
    if (!serverId || !userId || owner) return;
    let active = true;
    serverApi.getAccess(serverId).then(data => {
      if (active) setAccess({ key, allowed: (BigInt(data.permissions) & MANAGE_BOTS) !== 0n });
    }).catch(() => { if (active) setAccess({ key, allowed: false }); });
    return () => { active = false; };
  }, [serverId, userId, owner, key]);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    membershipChanges.current = { scope, values: new Map() };
    // Only this channel's membership, never every server bot's detail.
    botApi.channelAgents(channelId, { limit: 100 }).then(page => {
      if (active) {
        const ids = new Set(page.bots.map(bot => bot.id));
        for (const [id, added] of membershipChanges.current.values) added ? ids.add(id) : ids.delete(id);
        setMembership({ scope, ids: [...ids], hasMore: page.hasMore });
      }
    }).catch(() => { if (active) setMembership(null); });
    return () => { active = false; };
  }, [allowed, channelId, scope]);
  useEffect(() => {
    if (membership?.scope === scope) useMemberStore.getState().setChannelAgents(channelId, membership.ids);
  }, [membership, scope, channelId]);
  const hasAgents = membership?.scope === scope ? membership.ids.length > 0 || membership.hasMore : null;

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
    {open && <ChannelAgentsDialog key={channelId} channelId={channelId}
      onMembershipChange={(id, added) => {
        if (membershipChanges.current.scope === scope) membershipChanges.current.values.set(id, added);
        setMembership(previous => previous?.scope === scope ? {
          ...previous, ids: added ? [...new Set([...previous.ids, id])] : previous.ids.filter(held => held !== id),
        } : { scope, ids: added ? [id] : [], hasMore: true });
      }} onClose={() => setOpen(false)} />}
  </>;
}

export function ChannelAgentsDialog({ channelId, onMembershipChange, onClose }: {
  channelId: string; onMembershipChange?: (id: string, added: boolean) => void; onClose: () => void;
}) {
  const [bots, setBots] = useState<ChannelAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [request, setRequest] = useState<{ query: string; after?: string }>({ query: '' });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    botApi.channelAgents(channelId, { all: true, query: request.query, after: request.after, limit: 50 })
      .then(page => { if (active) {
        setBots(previous => request.after ? [...previous, ...page.bots.filter(bot => !previous.some(held => held.id === bot.id))] : page.bots);
        setNextCursor(page.hasMore ? page.nextCursor : null);
      } })
      .catch(() => { if (active) setError('Could not load channel agents. Try again.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [channelId, request]);

  async function toggle(bot: ChannelAgent) {
    if (saving) return;
    const present = bot.inChannel;
    setSaving(bot.id);
    setError('');
    setNotice('');
    try {
      if (present) await botApi.revokeChannel(channelId, bot.id);
      else await botApi.grantChannel(channelId, bot.id);
      setBots(list => list.map(b => b.id !== bot.id ? b : { ...b, inChannel: !present }));
      onMembershipChange?.(bot.id, !present);
      setNotice(present ? `${bot.username} removed from this channel.` : `${bot.username} added. You can now use /start with its agent profile.`);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You no longer have permission to manage channel agents.'
        : 'Could not change agent access. Refresh the list and try again.');
    } finally { setSaving(null); }
  }

  return <Modal isOpen onClose={onClose} title="Channel agents">
    <p className="text-sm text-text-muted mb-3">Add agents here before starting them. People join the server; this list controls agents in this channel.</p>
    <form className="mb-3 flex gap-2" onSubmit={event => { event.preventDefault(); setRequest({ query: search.trim() }); }}>
      <input aria-label="Search agents" placeholder="Search agents" maxLength={100} value={search} onChange={event => setSearch(event.target.value)}
        className="min-h-11 min-w-0 flex-1 rounded border border-border bg-bg px-3 text-text" />
      <Button type="submit" disabled={loading || !!saving}>Search</Button>
    </form>
    {error && <div role="alert" className="text-sm text-danger mb-3">{error} <button type="button" className="min-h-11 underline" disabled={loading || !!saving} onClick={() => setRequest({ query: request.query })}>Refresh list</button></div>}
    {loading ? <p className="text-text-muted">Loading agents…</p> : <>
      {!bots.length && !error && <p className="text-sm text-text-muted">{request.query ? 'No matching agents.' : 'No agents on this server yet. Create or invite one in Settings → Bots.'}</p>}
      <ul className="max-h-[50dvh] overflow-y-auto divide-y divide-border">
        {bots.map(bot => {
          const present = bot.inChannel;
          return <li key={bot.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1"><p className="truncate text-text">{bot.username}</p><p className="text-xs text-text-muted">{present ? 'In this channel' : 'Not added'}</p></div>
            <Button variant="secondary" aria-label={`${present ? 'Remove' : 'Add'} ${bot.username}`} disabled={!!saving} loading={saving === bot.id} onClick={() => void toggle(bot)}>{present ? 'Remove' : 'Add'}</Button>
          </li>;
        })}
      </ul>
      {nextCursor && <Button className="mt-2 min-h-11" disabled={loading || !!saving}
        onClick={() => setRequest({ query: request.query, after: nextCursor })}>Load more agents</Button>}
    </>}
    <p role="status" className="text-sm text-text-muted mt-2">{notice}</p>
    <div className="flex justify-end mt-3"><Button variant="secondary" onClick={onClose}>Done</Button></div>
  </Modal>;
}

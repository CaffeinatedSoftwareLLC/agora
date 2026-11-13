import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { Avatar } from '../../components/ui/Avatar';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { botApi, serverApi, runtimeApi, ApiError } from '../../lib/api';
import type { Bot, BotDetail, BotToken, RuntimeAccess } from '../../lib/api';
import type { Channel } from '../../lib/contracts/server';
import { Button } from '../../components/ui/Button';
import { CreateBotModal } from './CreateBotModal';
import { CreateTokenModal } from './CreateTokenModal';
import { CreateAgentInviteModal } from './CreateAgentInviteModal';
import { useAuthStore } from '../../stores/authStore';
import { tokenBadge, type TokenBadgeTone } from './tokenBadge';

const BADGE_TONE: Record<TokenBadgeTone, string> = {
  counts: 'border-online text-online',
  owner: 'border-border text-text-muted',
  never: 'border-border text-text-muted',
};

export function BotManagement() {
  const instanceServerId = useServerStore(s => s.instanceServerId);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [showCreateBot, setShowCreateBot] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [expandedBotId, setExpandedBotId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const fetchBots = useCallback(async (showLoading = true) => {
    if (!instanceServerId) return;
    if (showLoading) setLoading(true);
    setError('');
    try {
      const data = await botApi.list(instanceServerId);
      setBots(data);
      setPermissionDenied(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setPermissionDenied(true);
      } else {
        setError(err instanceof ApiError ? err.code : 'Failed to load bots');
      }
    } finally {
      setLoading(false);
    }
  }, [instanceServerId]);

  useEffect(() => { fetchBots(); }, [fetchBots]);

  // A refresh after a change keeps the list (and its scroll position) on screen
  const refresh = useCallback(() => { void fetchBots(false); }, [fetchBots]);
  const toggle = useCallback((botId: string) => setExpandedBotId(cur => (cur === botId ? null : botId)), []);

  // Newest first, so a bot you just created is at the top of a long list
  const sorted = useMemo(() => [...bots].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [bots]);
  const shown = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return q ? sorted.filter(b => b.username.toLowerCase().includes(q)) : sorted;
  }, [sorted, deferredQuery]);

  if (!instanceServerId) return null;

  if (permissionDenied) {
    return (
      <div>
        <h2 className="text-xl font-bold text-text mb-4">Bot Management</h2>
        <p className="text-text-muted mb-4">You don't have permission to manage bots.</p>
        <Link to="/app" className="hidden min-h-11 items-center text-primary-text hover:underline sm:inline-flex md:min-h-8">Back to chat</Link>
      </div>
    );
  }

  if (loading) {
    return <p className="text-text-muted">Loading bots...</p>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h2 className="text-xl font-bold text-text">Bot Management</h2>
        <div className="flex gap-2">
          <Button onClick={() => setShowInvite(true)}>Invite Agent</Button>
          <Button variant="secondary" onClick={() => setShowCreateBot(true)}>Create Bot</Button>
        </div>
      </div>

      {error && <p className="text-danger text-sm mb-4">{error}</p>}

      <ChannelLoopGuardSection serverId={instanceServerId} />

      {bots.length === 0 ? (
        <p className="text-text-muted">No bots yet. Create one to get started.</p>
      ) : (
        <section>
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search bots"
              aria-label="Search bots"
              className="min-h-11 md:min-h-9 w-full max-w-xs px-3 py-1.5 rounded border border-border bg-surface text-text placeholder:text-text-muted/70 text-sm"
            />
            <span className="text-text-muted text-xs" aria-live="polite">
              {shown.length === bots.length ? `${bots.length} bots` : `${shown.length} of ${bots.length} bots`}
            </span>
          </div>
          {shown.length === 0 ? (
            <p className="text-text-muted text-sm">No bots match “{deferredQuery.trim()}”.</p>
          ) : (
            <BotList
              bots={shown}
              serverId={instanceServerId}
              expandedBotId={expandedBotId}
              onToggle={toggle}
              onChanged={refresh}
            />
          )}
        </section>
      )}

      <CreateBotModal
        serverId={instanceServerId}
        isOpen={showCreateBot}
        onClose={() => setShowCreateBot(false)}
        onCreated={refresh}
      />
      {showInvite && <CreateAgentInviteModal serverId={instanceServerId} onClose={() => setShowInvite(false)} onCreated={refresh} />}
    </div>
  );
}

// ─── Bot List (virtualized) ───────────────────────────────────────────────

/** Rendering every bot stalled the page at about 1,800 bots (#241): only the rows in view are mounted. */
function BotList({
  bots,
  serverId,
  expandedBotId,
  onToggle,
  onChanged,
}: {
  bots: Bot[];
  serverId: string;
  expandedBotId: string | null;
  onToggle: (botId: string) => void;
  onChanged: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const expandedIndex = expandedBotId ? bots.findIndex(b => b.id === expandedBotId) : -1;
  // This component is not compiled by the React Compiler; the virtualizer is read during render only
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: bots.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 8,
    getItemKey: index => bots[index].id,
    // The open bot stays mounted while scrolled away, so its panel (a half-made token, an error) survives
    rangeExtractor: range => {
      const indexes = defaultRangeExtractor(range);
      return expandedIndex < 0 || indexes.includes(expandedIndex) ? indexes : [...indexes, expandedIndex].sort((a, b) => a - b);
    },
  });

  return (
    <div ref={scrollRef} data-testid="bot-list" className="max-h-[70vh] overflow-y-auto overscroll-contain">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => {
          const bot = bots[item.index];
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full pb-2"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <BotRow
                bot={bot}
                serverId={serverId}
                isExpanded={expandedBotId === bot.id}
                onToggle={onToggle}
                onChanged={onChanged}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Channel Loop Guard Settings ──────────────────────────────────────────

type GuardField = 'maxBotHops' | 'maxThreadBotHops';
type Limits = Record<GuardField, number>;
/** The limit a guard gets when it is switched on with no earlier value to restore. */
const GUARD_DEFAULT: Limits = { maxBotHops: 4, maxThreadBotHops: 4 };

/**
 * Both loop guards per channel (#23): the channel guard (top-level bot messages in a row)
 * and the thread guard (bot replies in a row inside one thread). Each has an on/off switch and is
 * off unless someone turns it on. Here off is 0; the API says null ("no limit").
 */
function ChannelLoopGuardSection({ serverId }: { serverId: string }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  // Limits as loaded or last confirmed by a save here
  const [loaded, setLoaded] = useState<Record<string, Limits>>({});
  // Edits not yet confirmed by the server, by `${channelId}:${field}`
  const [dirty, setDirty] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  // A change made elsewhere (a notice's Raise limit or Turn off) arrives as ChannelBotConfig
  const live = useChannelStore(s => s.channels);
  const pending = useRef<Record<string, { timer: ReturnType<typeof setTimeout>; value: number }>>({});
  // Saves of one field go out one at a time, in order, so the last change made wins
  const queues = useRef<Record<string, Promise<void>>>({});
  // The last limit above 0, restored when a guard is switched back on
  const lastOn = useRef<Record<string, number>>({});
  const mounted = useRef(true);

  useEffect(() => {
    serverApi.getChannels(serverId).then((chs) => {
      const textChannels = chs.filter(c => c.channelType === 3);
      setChannels(textChannels);
      const initial: Record<string, Limits> = {};
      for (const ch of textChannels) {
        initial[ch.id] = { maxBotHops: ch.maxBotHops ?? 0, maxThreadBotHops: ch.maxThreadBotHops ?? 0 };
      }
      setLoaded(initial);
    }).catch(() => setError('Failed to load channels'));
  }, [serverId]);

  // enqueue only touches refs and state setters, so the first render's copy stays valid for the unmount flush
  const enqueueOnLeave = useRef(enqueue);

  // Leaving the page sends a change still waiting out its debounce instead of dropping it,
  // behind any save of that field still in flight so the older one cannot land last
  useEffect(() => {
    mounted.current = true;
    const waiting = pending.current;
    const flush = enqueueOnLeave.current;
    return () => {
      mounted.current = false;
      for (const [key, p] of Object.entries(waiting)) {
        clearTimeout(p.timer);
        delete waiting[key];
        const [channelId, field] = key.split(':') as [string, GuardField];
        flush(channelId, field, p.value);
      }
    };
  }, []);

  const shown = (channelId: string, field: GuardField): number => {
    const key = `${channelId}:${field}`;
    if (key in dirty) return dirty[key];
    // undefined: the store has no limits for this channel yet; null: that guard is off
    const now = live.get(channelId)?.[field];
    return now !== undefined ? now ?? 0 : loaded[channelId]?.[field] ?? 0;
  };

  function change(channelId: string, field: GuardField, value: number, delay: number) {
    const key = `${channelId}:${field}`;
    const prev = shown(channelId, field);
    if (prev > 0) lastOn.current[key] = prev;
    setDirty(d => ({ ...d, [key]: value }));
    if (pending.current[key]) clearTimeout(pending.current[key].timer);
    const timer = setTimeout(() => {
      delete pending.current[key];
      enqueue(channelId, field, value);
    }, delay);
    pending.current[key] = { timer, value };
  }

  /** Queues a save behind any earlier save of the same field (save never rejects). */
  function enqueue(channelId: string, field: GuardField, value: number) {
    const key = `${channelId}:${field}`;
    queues.current[key] = (queues.current[key] ?? Promise.resolve()).then(() => save(channelId, field, value));
  }

  function handleNumber(channelId: string, field: GuardField, raw: string) {
    const num = parseInt(raw, 10);
    // 0 would be "off": that is the switch's job, so the box keeps a limit while typing
    if (!Number.isSafeInteger(num) || num < 1) return;
    change(channelId, field, num, 600);
  }

  function handleToggle(channelId: string, field: GuardField, on: boolean) {
    const restore = lastOn.current[`${channelId}:${field}`] ?? GUARD_DEFAULT[field];
    change(channelId, field, on ? restore : 0, 0);
  }

  async function save(channelId: string, field: GuardField, value: number) {
    const key = `${channelId}:${field}`;
    if (mounted.current) { setSaving(s => ({ ...s, [key]: true })); setError(''); }
    // Only the latest edit clears the dirty value; an older save finishing must not
    const settle = (d: Record<string, number>) => {
      if (d[key] !== value || pending.current[key]) return d;
      const next = { ...d };
      delete next[key];
      return next;
    };
    try {
      const config = await botApi.updateChannelBotConfig(channelId, { [field]: value || null });
      useChannelStore.getState().patchChannel(channelId, { maxBotHops: config.maxBotHops, maxThreadBotHops: config.maxThreadBotHops });
      if (!mounted.current) return;
      setLoaded(l => ({ ...l, [channelId]: { maxBotHops: config.maxBotHops ?? 0, maxThreadBotHops: config.maxThreadBotHops ?? 0 } }));
      setDirty(settle);
    } catch (err) {
      if (!mounted.current) return;
      // Show what the server still has, not the value that failed
      setDirty(settle);
      setError(err instanceof ApiError ? err.code : 'Failed to save');
    } finally {
      if (mounted.current) setSaving(s => ({ ...s, [key]: false }));
    }
  }

  if (channels.length === 0) return null;

  const guard = (ch: Channel, field: GuardField, label: string, unit: string) => {
    const value = shown(ch.id, field);
    const on = value > 0;
    const key = `${ch.id}:${field}`;
    return (
      <div className="flex items-center gap-2">
        <label className="min-h-11 md:min-h-8 flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
          <input
            type="checkbox"
            role="switch"
            checked={on}
            onChange={e => handleToggle(ch.id, field, e.target.checked)}
            aria-label={`${label} loop guard in #${ch.name}`}
            className="accent-primary"
          />
          {label}
        </label>
        {on ? (
          <input
            type="number"
            min={1}
            inputMode="numeric"
            value={value}
            onChange={e => handleNumber(ch.id, field, e.target.value)}
            aria-label={`${label} limit in #${ch.name} (${unit})`}
            title={`Pause after this many ${unit} in a row`}
            className="min-h-11 md:min-h-8 w-24 px-2 py-1 rounded border border-border bg-surface text-text text-sm text-right"
          />
        ) : (
          <span className="w-24 text-text-muted text-xs">No limit</span>
        )}
        <span className="w-12 text-text-muted text-xs" aria-live="polite">{saving[key] ? 'Saving…' : ''}</span>
      </div>
    );
  };

  return (
    <section className="mb-6">
      <h3 className="text-sm font-semibold text-text mb-2">Loop Guard</h3>
      <p className="text-text-muted text-xs mb-3">
        Off unless you turn it on. A guard stops bots after the number of bot posts in a row you set, until a person
        posts or presses Continue on its notice. The channel guard counts top-level messages; the thread guard counts
        replies inside each thread.
      </p>
      {error && <p className="text-danger text-xs mb-2" role="alert">{error}</p>}
      <div className="flex flex-col gap-1">
        {channels.map((ch) => (
          <div key={ch.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-2 py-1.5 rounded hover:bg-surface-hover">
            <span className="flex min-w-32 flex-1 items-center gap-1 text-sm">
              <span className="text-text-muted">#</span>
              <span className="text-text">{ch.name}</span>
            </span>
            {guard(ch, 'maxBotHops', 'Channel', 'bot messages')}
            {guard(ch, 'maxThreadBotHops', 'Threads', 'bot replies in one thread')}
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Bot Row (expandable) ─────────────────────────────────────────────────

// Memoized with stable callbacks: opening one bot re-renders that row, not the whole list
const BotRow = memo(function BotRow({
  bot,
  serverId,
  isExpanded,
  onToggle,
  onChanged,
}: {
  bot: Bot;
  serverId: string;
  isExpanded: boolean;
  onToggle: (botId: string) => void;
  onChanged: () => void;
}) {
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState('');
  const [savingAccess, setSavingAccess] = useState(false);
  const isPaused = !!bot.pausedAt;

  async function changeAccess(access: RuntimeAccess) {
    if (access === 'auto' && !confirm(`Let ${bot.username} run code without approval? Runs still execute in the sandbox with its limits.`)) return;
    setSavingAccess(true);
    setPauseError('');
    try {
      await runtimeApi.setBotAccess(serverId, bot.id, access);
      onChanged();
    } catch (err) {
      setPauseError(err instanceof ApiError ? err.code : 'Failed to update code run access');
    } finally {
      setSavingAccess(false);
    }
  }

  async function togglePause() {
    setPausing(true);
    setPauseError('');
    try {
      if (isPaused) {
        await botApi.setPaused(serverId, bot.id, false);
      } else {
        const reason = prompt('Pause this bot? It will be read-only until resumed.\n\nReason (optional):');
        if (reason === null) return;
        await botApi.setPaused(serverId, bot.id, true, reason.trim() || undefined);
      }
      onChanged();
    } catch (err) {
      setPauseError(err instanceof ApiError ? err.code : 'Failed to update pause state');
    } finally {
      setPausing(false);
    }
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center hover:bg-surface-hover">
      <button
        onClick={() => onToggle(bot.id)}
        aria-expanded={isExpanded}
        className="min-h-11 flex-1 flex items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <span className="text-text font-medium">{bot.username}</span>
          {isPaused && (
            <span
              className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none bg-warn/20 text-warn"
              title={bot.pausedReason ? `Paused: ${bot.pausedReason}` : 'Paused'}
            >
              PAUSED
            </span>
          )}
          <span className="text-text-muted text-xs ml-2">
            {new Date(bot.createdAt).toLocaleDateString()}
          </span>
          {pauseError && <span className="text-danger text-xs ml-2">{pauseError}</span>}
        </div>
        <svg
          className="h-4 w-4 text-text-muted transition-transform"
          style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <label className="flex items-center gap-1 pr-3 text-xs text-text-muted" title="Whether this bot may run code in the sandbox">
        Code runs
        <select
          className="min-h-11 md:min-h-8 bg-surface border border-border rounded px-2 py-1 text-xs text-text"
          value={bot.runtimeAccess ?? 'none'}
          disabled={savingAccess}
          onChange={e => changeAccess(e.target.value as RuntimeAccess)}
          aria-label={`Code run access for ${bot.username}`}
        >
          <option value="none">Off</option>
          <option value="approval">Need approval</option>
          <option value="auto">Auto-run</option>
        </select>
      </label>
      <div className="pr-3">
        <Button variant="secondary" onClick={togglePause} loading={pausing}>
          {isPaused ? 'Resume' : 'Pause'}
        </Button>
      </div>
      </div>
      {isExpanded && (
        <BotDetailPanel botId={bot.id} serverId={serverId} onDeleted={onChanged} />
      )}
    </div>
  );
});

// ─── Bot Detail Panel ─────────────────────────────────────────────────────

function BotDetailPanel({
  botId,
  serverId,
  onDeleted,
}: {
  botId: string;
  serverId: string;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<BotDetail | null>(null);
  const [allChannels, setAllChannels] = useState<Channel[]>([]);
  const [tokens, setTokens] = useState<BotToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateToken, setShowCreateToken] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [channelLoading, setChannelLoading] = useState<string | null>(null);
  const [avatarInput, setAvatarInput] = useState('');
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const viewerId = useAuthStore(s => s.user?.id);

  const fetchDetail = useCallback(async () => {
    try {
      const [d, channels] = await Promise.all([
        botApi.get(serverId, botId),
        serverApi.getChannels(serverId),
      ]);
      setDetail(d);
      setAvatarInput(d.avatarUrl || '');
      // Only show text channels (type 3) for bot access
      setAllChannels(channels.filter(c => c.channelType === 3));
      if (d.canManageTokens) {
        const t = await botApi.listTokens(serverId, botId);
        setTokens(t);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to load bot details');
    } finally {
      setLoading(false);
    }
  }, [serverId, botId]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  async function handleDelete() {
    if (!confirm('Delete this bot? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await botApi.remove(serverId, botId);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to delete bot');
      setDeleting(false);
    }
  }

  async function handleRevokeToken(tokenId: string) {
    try {
      await botApi.revokeToken(serverId, botId, tokenId);
      setTokens(prev => prev.map(t => t.id === tokenId ? { ...t, revokedAt: new Date().toISOString() } : t));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        // Permissions changed — refetch detail
        fetchDetail();
      }
      setError(err instanceof ApiError ? err.code : 'Failed to revoke token');
    }
  }

  async function handleClearBinding(tokenId: string) {
    try {
      await botApi.clearTokenBinding(serverId, botId, tokenId);
      setTokens(prev => prev.map(t => t.id === tokenId ? { ...t, boundClient: null, boundAt: null, lastRefused: null } : t));
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to clear the binding');
    }
  }

  async function toggleDirect(channelId: string, canDirect: boolean) {
    setChannelLoading(channelId);
    setError('');
    try {
      await botApi.setCanDirect(channelId, botId, !canDirect);
      setDetail(await botApi.get(serverId, botId));
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to update who may direct');
    } finally {
      setChannelLoading(null);
    }
  }

  async function toggleChannel(channelId: string, hasAccess: boolean) {
    setChannelLoading(channelId);
    try {
      if (hasAccess) {
        await botApi.revokeChannel(channelId, botId);
      } else {
        await botApi.grantChannel(channelId, botId);
      }
      // Refetch detail to get updated channel list
      const d = await botApi.get(serverId, botId);
      setDetail(d);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to update channel access');
    } finally {
      setChannelLoading(null);
    }
  }

  if (loading) {
    return <div className="px-4 py-3 border-t border-border text-text-muted text-sm">Loading...</div>;
  }

  if (error && !detail) {
    return <div className="px-4 py-3 border-t border-border text-danger text-sm">{error}</div>;
  }

  if (!detail) return null;

  const botChannelIds = new Set(detail.channels.map(c => c.id));
  const directChannelIds = new Set(detail.channels.filter(c => c.canDirect).map(c => c.id));
  const activeTokens = tokens.filter(t => !t.revokedAt);
  const revokedTokens = tokens.filter(t => t.revokedAt);

  return (
    <div className="border-t border-border px-4 py-4 flex flex-col gap-5 bg-bg/50">
      {error && <p className="text-danger text-sm">{error}</p>}

      {/* ── Avatar ── */}
      <section>
        <h4 className="text-sm font-semibold text-text mb-2">Avatar</h4>
        <div className="flex items-start gap-3">
          <Avatar userId={botId} username={detail.username} avatarUrl={detail.avatarUrl} className="h-12 w-12 text-sm" />
          <div className="flex-1 min-w-0">
            <input
              type="text"
              value={avatarInput}
              onChange={(e) => { setAvatarInput(e.target.value); setAvatarError(''); }}
              placeholder="data:image/svg+xml;base64,..."
              className="min-h-11 md:min-h-9 w-full px-3 py-1.5 rounded border border-border bg-surface text-text placeholder:text-text-muted/70 text-sm"
            />
            {avatarError && <p className="text-danger text-xs mt-1">{avatarError}</p>}
            <div className="flex gap-2 mt-2">
              <Button
                variant="secondary"
                className="min-h-11 md:min-h-8 !px-3 !py-1 !text-xs"
                loading={avatarSaving}
                onClick={async () => {
                  setAvatarSaving(true);
                  setAvatarError('');
                  try {
                    const res = await botApi.update(serverId, botId, { avatarUrl: avatarInput || null });
                    setDetail(prev => prev ? { ...prev, avatarUrl: res.avatarUrl } : prev);
                  } catch (err) {
                    setAvatarError(err instanceof ApiError ? err.code : 'Failed to save avatar');
                  } finally {
                    setAvatarSaving(false);
                  }
                }}
              >
                Save Avatar
              </Button>
              {detail.avatarUrl && (
                <Button
                  variant="secondary"
                  className="min-h-11 md:min-h-8 !px-3 !py-1 !text-xs"
                  onClick={async () => {
                    setAvatarSaving(true);
                    setAvatarError('');
                    try {
                      const res = await botApi.update(serverId, botId, { avatarUrl: null });
                      setDetail(prev => prev ? { ...prev, avatarUrl: res.avatarUrl } : prev);
                      setAvatarInput('');
                    } catch (err) {
                      setAvatarError(err instanceof ApiError ? err.code : 'Failed to remove avatar');
                    } finally {
                      setAvatarSaving(false);
                    }
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── Channel Access ── */}
      <section>
        <h4 className="text-sm font-semibold text-text mb-2">Channel Access</h4>
        {allChannels.length === 0 ? (
          <p className="text-text-muted text-xs">No text channels found.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {allChannels.map((ch) => {
              const hasAccess = botChannelIds.has(ch.id);
              const isLoading = channelLoading === ch.id;
              return (
                <label
                  key={ch.id}
                  className="min-h-11 md:min-h-9 flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-hover cursor-pointer text-sm"
                >
                  <input
                    type="checkbox"
                    checked={hasAccess}
                    disabled={isLoading}
                    onChange={() => toggleChannel(ch.id, hasAccess)}
                    className="accent-primary"
                  />
                  <span className="text-text-muted">#</span>
                  <span className="text-text">{ch.name}</span>
                  {isLoading && <span className="text-text-muted text-xs ml-auto">...</span>}
                  {hasAccess && (
                    <span
                      className="ml-auto flex items-center gap-1 text-xs text-text-muted"
                      title="Lets this bot give other agents instructions in this channel. Only the server owner can change it."
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={directChannelIds.has(ch.id)}
                        disabled={isLoading}
                        onChange={() => toggleDirect(ch.id, directChannelIds.has(ch.id))}
                        className="accent-primary"
                      />
                      can direct agents
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Tokens (owner / admin only) ── */}
      {detail.canManageTokens && (
        <section>
          <Button onClick={() => setShowInvite(true)}>Invite Agent</Button>
          {showInvite && <CreateAgentInviteModal serverId={serverId} botId={botId} onClose={() => setShowInvite(false)} onCreated={() => {}} />}
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-text">Tokens</h4>
            <Button
              variant="secondary"
              className="min-h-11 md:min-h-8 !px-3 !py-1 !text-xs"
              onClick={() => setShowCreateToken(true)}
            >
              New Token
            </Button>
          </div>
          {activeTokens.length === 0 && revokedTokens.length === 0 ? (
            <p className="text-text-muted text-xs">No tokens yet.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {activeTokens.map((t) => {
                const badge = tokenBadge(t, viewerId, detail.ownerId);
                return (
                <div key={t.id} className="flex items-center justify-between px-2 py-1.5 rounded bg-surface text-sm" data-testid="bot-token">
                  <div>
                    <span className="text-text">{t.name || 'Unnamed'}</span>
                    {badge && (
                      <span
                        className={`ml-2 inline-flex items-center rounded-full border px-2 text-[11px] leading-5 ${BADGE_TONE[badge.tone]}`}
                        title={badge.title}
                        data-testid="token-badge"
                      >
                        {badge.label}
                      </span>
                    )}
                    <span className="text-text-muted text-xs ml-2">
                      Created {new Date(t.createdAt).toLocaleDateString()}
                    </span>
                    {t.lastUsedAt && (
                      <span className="text-text-muted text-xs ml-2">
                        Last used {new Date(t.lastUsedAt).toLocaleDateString()}
                        {t.lastUsedClient ? ` by ${t.lastUsedClient}` : ''}
                        {t.lastUsedIp ? ` from ${t.lastUsedIp}` : ''}
                      </span>
                    )}
                    {t.boundClient && (
                      <span className="text-text-muted text-xs ml-2" title="Requests from any other client are refused">
                        Bound to {t.boundClient}
                      </span>
                    )}
                    {t.lastRefused && (
                      <span className="block text-danger text-xs">
                        Refused {t.lastRefused.client ? `use by ${t.lastRefused.client}` : 'a use with no client name'}
                        {t.lastRefused.ip ? ` from ${t.lastRefused.ip}` : ''} on {new Date(t.lastRefused.at).toLocaleString()}.
                        If that wasn't you moving this agent, revoke the token.
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0">
                    {t.boundClient && (
                      <button
                        onClick={() => handleClearBinding(t.id)}
                        className="min-h-11 md:min-h-8 px-2 text-text-muted text-xs hover:underline"
                        title="The next client that uses the token binds it again"
                      >
                        Clear binding
                      </button>
                    )}
                    <button
                      onClick={() => handleRevokeToken(t.id)}
                      className="min-h-11 md:min-h-8 px-2 text-danger text-xs hover:underline"
                    >
                      Revoke
                    </button>
                  </div>
                </div>
                );
              })}
              {revokedTokens.map((t) => (
                <div key={t.id} className="flex items-center px-2 py-1.5 rounded bg-surface text-sm opacity-50">
                  <span className="text-text line-through">{t.name || 'Unnamed'}</span>
                  <span className="text-text-muted text-xs ml-2">Revoked</span>
                </div>
              ))}
            </div>
          )}

          <CreateTokenModal
            serverId={serverId}
            botId={botId}
            isOpen={showCreateToken}
            onClose={() => setShowCreateToken(false)}
            onCreated={async () => {
              const t = await botApi.listTokens(serverId, botId);
              setTokens(t);
            }}
          />
        </section>
      )}

      {/* ── Delete Bot ── */}
      <div className="pt-2 border-t border-border">
        <Button variant="danger" onClick={handleDelete} loading={deleting}>
          Delete Bot
        </Button>
      </div>
    </div>
  );
}

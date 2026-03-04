import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { botApi, serverApi, ApiError } from '../../lib/api';
import type { Bot, BotDetail, BotToken } from '../../lib/api';
import type { Channel } from '../../lib/contracts/server';
import { Button } from '../../components/ui/Button';
import { CreateBotModal } from './CreateBotModal';
import { CreateTokenModal } from './CreateTokenModal';

export function BotManagement() {
  const instanceServerId = useServerStore(s => s.instanceServerId);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [showCreateBot, setShowCreateBot] = useState(false);
  const [expandedBotId, setExpandedBotId] = useState<string | null>(null);

  const fetchBots = useCallback(async () => {
    if (!instanceServerId) return;
    setLoading(true);
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

  if (!instanceServerId) return null;

  if (permissionDenied) {
    return (
      <div>
        <h2 className="text-xl font-bold text-text mb-4">Bot Management</h2>
        <p className="text-text-muted mb-4">You don't have permission to manage bots.</p>
        <Link to="/app" className="text-primary hover:underline">Back to chat</Link>
      </div>
    );
  }

  if (loading) {
    return <p className="text-text-muted">Loading bots...</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-text">Bot Management</h2>
        <Button onClick={() => setShowCreateBot(true)}>Create Bot</Button>
      </div>

      {error && <p className="text-danger text-sm mb-4">{error}</p>}

      {bots.length === 0 ? (
        <p className="text-text-muted">No bots yet. Create one to get started.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {bots.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              serverId={instanceServerId}
              isExpanded={expandedBotId === bot.id}
              onToggle={() => setExpandedBotId(expandedBotId === bot.id ? null : bot.id)}
              onDeleted={fetchBots}
            />
          ))}
        </div>
      )}

      <CreateBotModal
        serverId={instanceServerId}
        isOpen={showCreateBot}
        onClose={() => setShowCreateBot(false)}
        onCreated={fetchBots}
      />
    </div>
  );
}

// ─── Bot Row (expandable) ─────────────────────────────────────────────────

function BotRow({
  bot,
  serverId,
  isExpanded,
  onToggle,
  onDeleted,
}: {
  bot: Bot;
  serverId: string;
  isExpanded: boolean;
  onToggle: () => void;
  onDeleted: () => void;
}) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-hover text-left"
      >
        <div>
          <span className="text-text font-medium">{bot.username}</span>
          <span className="text-text-muted text-xs ml-2">
            {new Date(bot.createdAt).toLocaleDateString()}
          </span>
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
      {isExpanded && (
        <BotDetailPanel botId={bot.id} serverId={serverId} onDeleted={onDeleted} />
      )}
    </div>
  );
}

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
  const [deleting, setDeleting] = useState(false);
  const [channelLoading, setChannelLoading] = useState<string | null>(null);
  const [avatarInput, setAvatarInput] = useState('');
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState('');

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
  const activeTokens = tokens.filter(t => !t.revokedAt);
  const revokedTokens = tokens.filter(t => t.revokedAt);

  return (
    <div className="border-t border-border px-4 py-4 flex flex-col gap-5 bg-bg/50">
      {error && <p className="text-danger text-sm">{error}</p>}

      {/* ── Avatar ── */}
      <section>
        <h4 className="text-sm font-semibold text-text mb-2">Avatar</h4>
        <div className="flex items-start gap-3">
          {detail.avatarUrl ? (
            <img
              src={detail.avatarUrl}
              alt={detail.username}
              className="w-12 h-12 rounded-full object-cover shrink-0"
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center text-sm font-bold text-white shrink-0">
              {(detail.username || '?')[0].toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <input
              type="text"
              value={avatarInput}
              onChange={(e) => { setAvatarInput(e.target.value); setAvatarError(''); }}
              placeholder="data:image/svg+xml;base64,..."
              className="w-full px-2 py-1.5 rounded border border-border bg-surface text-text text-sm"
            />
            {avatarError && <p className="text-danger text-xs mt-1">{avatarError}</p>}
            <div className="flex gap-2 mt-2">
              <Button
                variant="secondary"
                className="!px-2 !py-1 !text-xs"
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
                  className="!px-2 !py-1 !text-xs"
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
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-hover cursor-pointer text-sm"
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
                  {isLoading && <span className="text-text-dim text-xs ml-auto">...</span>}
                </label>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Tokens (owner / admin only) ── */}
      {detail.canManageTokens && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-text">Tokens</h4>
            <Button
              variant="secondary"
              className="!px-2 !py-1 !text-xs"
              onClick={() => setShowCreateToken(true)}
            >
              New Token
            </Button>
          </div>
          {activeTokens.length === 0 && revokedTokens.length === 0 ? (
            <p className="text-text-muted text-xs">No tokens yet.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {activeTokens.map((t) => (
                <div key={t.id} className="flex items-center justify-between px-2 py-1.5 rounded bg-surface text-sm">
                  <div>
                    <span className="text-text">{t.name || 'Unnamed'}</span>
                    <span className="text-text-muted text-xs ml-2">
                      Created {new Date(t.createdAt).toLocaleDateString()}
                    </span>
                    {t.lastUsedAt && (
                      <span className="text-text-dim text-xs ml-2">
                        Last used {new Date(t.lastUsedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleRevokeToken(t.id)}
                    className="text-danger text-xs hover:underline"
                  >
                    Revoke
                  </button>
                </div>
              ))}
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

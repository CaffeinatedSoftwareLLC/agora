import { useState, useEffect, useCallback } from 'react';
import type { Role, ChannelOverrides as ChannelOverridesData } from '../../lib/contracts/roles';
import type { Channel } from '../../lib/contracts/server';
import { roleApi, serverApi } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';
import { OverrideEditor } from './OverrideEditor';

export function ChannelOverrides() {
  const serverId = useServerStore((s) => s.instanceServerId) ?? '';
  const [channels, setChannels] = useState<Channel[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string>('');
  const [overrides, setOverrides] = useState<ChannelOverridesData | null>(null);
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadInitial = useCallback(async () => {
    if (!serverId) return;
    try {
      const [channelsData, rolesData] = await Promise.all([
        serverApi.getChannels(serverId),
        roleApi.list(serverId),
      ]);
      setChannels(channelsData);
      setRoles(rolesData);
    } catch (e: any) {
      setError(e.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  async function loadOverrides(channelId: string) {
    setSelectedChannel(channelId);
    setError('');
    try {
      const data = await roleApi.getOverrides(channelId);
      setOverrides(data);
    } catch (e: any) {
      setError(e.message || 'Failed to load overrides');
    }
  }

  async function handleSaveRoleOverride(roleId: string, allow: string, deny: string) {
    try {
      await roleApi.upsertRoleOverride(selectedChannel, roleId, { allow, deny });
      await loadOverrides(selectedChannel);
      setEditingRole(null);
    } catch (e: any) {
      setError(e.message || 'Failed to save override');
    }
  }

  async function handleDeleteRoleOverride(roleId: string) {
    try {
      await roleApi.removeRoleOverride(selectedChannel, roleId);
      await loadOverrides(selectedChannel);
    } catch (e: any) {
      setError(e.message || 'Failed to remove override');
    }
  }

  if (editingRole) {
    const existing = overrides?.roles.find((r) => r.roleId === editingRole);
    const role = roles.find((r) => r.id === editingRole);
    return (
      <OverrideEditor
        name={role?.name || 'Unknown Role'}
        allow={existing?.allow || '0'}
        deny={existing?.deny || '0'}
        onSave={(allow, deny) => handleSaveRoleOverride(editingRole, allow, deny)}
        onClose={() => setEditingRole(null)}
      />
    );
  }

  if (loading) {
    return <p className="text-text-muted text-sm">Loading...</p>;
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold text-text mb-4">Channel Overrides</h2>

      {error && (
        <div className="bg-red-500/20 text-red-300 px-3 py-2 rounded text-sm mb-4">
          {error}
        </div>
      )}

      <div className="mb-4">
        <label className="block text-sm text-text-muted mb-1">Select Channel</label>
        <select
          value={selectedChannel}
          onChange={(e) => loadOverrides(e.target.value)}
          className="w-full px-3 py-2 rounded bg-surface border border-border text-text"
        >
          <option value="">Choose a channel...</option>
          {channels.map((ch) => (
            <option key={ch.id} value={ch.id}>
              #{ch.name}
            </option>
          ))}
        </select>
      </div>

      {selectedChannel && overrides && (
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-text-muted">Role Overrides</h3>
            </div>

            {overrides.roles.length > 0 ? (
              <div className="space-y-1">
                {overrides.roles.map((o) => (
                  <div
                    key={o.roleId}
                    className="flex items-center justify-between px-3 py-2 rounded hover:bg-surface-hover group"
                  >
                    <span className="text-sm text-text">{o.roleName}</span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => setEditingRole(o.roleId!)}
                        className="px-2 py-1 rounded text-xs text-text-muted hover:bg-surface hover:text-text"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteRoleOverride(o.roleId!)}
                        className="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-500/20"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-text-muted text-sm">No role overrides set.</p>
            )}

            <div className="mt-2">
              <select
                onChange={(e) => {
                  if (e.target.value) setEditingRole(e.target.value);
                  e.target.value = '';
                }}
                className="w-full px-3 py-2 rounded bg-surface border border-border text-text text-sm"
                defaultValue=""
              >
                <option value="">Add role override...</option>
                {roles
                  .filter((r) => !overrides.roles.some((o) => o.roleId === r.id))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {overrides.members.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-text-muted mb-2">Member Overrides</h3>
              <div className="space-y-1">
                {overrides.members.map((o) => (
                  <div
                    key={o.userId}
                    className="flex items-center justify-between px-3 py-2 rounded hover:bg-surface-hover"
                  >
                    <span className="text-sm text-text">{o.username}</span>
                    <span className="text-xs text-text-muted">
                      allow: {o.allow} / deny: {o.deny}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import type { Role } from '../../lib/contracts/roles';
import { roleApi } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';
import { RoleEditor } from './RoleEditor';

export function RoleManagement() {
  const serverId = useServerStore((s) => s.instanceServerId) ?? '';
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');

  const loadRoles = useCallback(async () => {
    if (!serverId) return;
    try {
      const data = await roleApi.list(serverId);
      setRoles(data);
    } catch (e: any) {
      setError(e.message || 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  async function handleCreate() {
    if (!newRoleName.trim()) return;
    setError('');
    try {
      await roleApi.create(serverId, { name: newRoleName.trim() });
      setNewRoleName('');
      setCreating(false);
      await loadRoles();
    } catch (e: any) {
      setError(e.message || 'Failed to create role');
    }
  }

  async function handleDelete(roleId: string) {
    setError('');
    try {
      await roleApi.remove(serverId, roleId);
      await loadRoles();
    } catch (e: any) {
      setError(e.message || 'Failed to delete role');
    }
  }

  async function handleSave(roleId: string, updates: Record<string, unknown>) {
    await roleApi.update(serverId, roleId, updates);
    await loadRoles();
  }

  if (editing) {
    return (
      <RoleEditor
        role={editing}
        onSave={(updates) => handleSave(editing.id, updates)}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-text">Roles</h2>
        <button
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 rounded text-sm bg-primary text-white hover:bg-primary/80"
        >
          Create Role
        </button>
      </div>

      {error && (
        <div className="bg-red-500/20 text-red-300 px-3 py-2 rounded text-sm mb-4">
          {error}
        </div>
      )}

      {creating && (
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newRoleName}
            onChange={(e) => setNewRoleName(e.target.value)}
            placeholder="Role name"
            maxLength={64}
            className="flex-1 px-3 py-2 rounded bg-surface border border-border text-text"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button
            onClick={handleCreate}
            className="px-3 py-2 rounded text-sm bg-primary text-white hover:bg-primary/80"
          >
            Create
          </button>
          <button
            onClick={() => { setCreating(false); setNewRoleName(''); }}
            className="px-3 py-2 rounded text-sm text-text-muted hover:bg-surface-hover"
          >
            Cancel
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-text-muted text-sm">Loading roles...</p>
      ) : (
        <div className="space-y-1">
          {roles.map((role) => (
            <div
              key={role.id}
              className="flex items-center justify-between px-3 py-2 rounded hover:bg-surface-hover group"
            >
              <div className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: role.color || '#99aab5' }}
                />
                <span className="text-sm text-text">{role.name}</span>
                {role.isEveryone && (
                  <span className="text-xs text-text-muted bg-surface px-1.5 py-0.5 rounded">
                    default
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => setEditing(role)}
                  className="px-2 py-1 rounded text-xs text-text-muted hover:bg-surface hover:text-text"
                >
                  Edit
                </button>
                {!role.isEveryone && (
                  <button
                    onClick={() => handleDelete(role.id)}
                    className="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-500/20"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

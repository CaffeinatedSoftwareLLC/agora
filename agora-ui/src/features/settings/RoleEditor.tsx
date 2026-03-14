import { useState } from 'react';
import type { Role } from '../../lib/contracts/roles';
import { PermissionGrid } from './PermissionGrid';

interface RoleEditorProps {
  role: Role;
  onSave: (updates: { name?: string; color?: string | null; hoist?: boolean; permissions?: string; mentionable?: boolean }) => Promise<void>;
  onClose: () => void;
}

export function RoleEditor({ role, onSave, onClose }: RoleEditorProps) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color || '#99aab5');
  const [hoist, setHoist] = useState(role.hoist);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [permissions, setPermissions] = useState(role.permissions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await onSave({
        ...(!role.isEveryone ? { name } : {}),
        color,
        hoist,
        permissions,
        mentionable,
      });
      onClose();
    } catch (e: any) {
      setError(e.message || 'Failed to save role');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-text">
          Edit Role: {role.name}
        </h3>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text text-sm"
        >
          Back
        </button>
      </div>

      {error && (
        <div className="bg-red-500/20 text-red-300 px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-text-muted mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={role.isEveryone}
            maxLength={64}
            className="w-full px-3 py-2 rounded bg-surface border border-border text-text disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-sm text-text-muted mb-1">Color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-10 h-10 rounded cursor-pointer"
            />
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              maxLength={7}
              className="flex-1 px-3 py-2 rounded bg-surface border border-border text-text font-mono text-sm"
            />
          </div>
        </div>
      </div>

      <div className="flex gap-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={hoist}
            onChange={(e) => setHoist(e.target.checked)}
            className="accent-primary"
          />
          <span className="text-sm text-text">Display separately in member list</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={mentionable}
            onChange={(e) => setMentionable(e.target.checked)}
            className="accent-primary"
          />
          <span className="text-sm text-text">Allow anyone to @mention this role</span>
        </label>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-text mb-2">Permissions</h4>
        <div className="max-h-96 overflow-y-auto border border-border rounded p-3">
          <PermissionGrid permissions={permissions} onChange={setPermissions} />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-4 py-2 rounded text-sm text-text-muted hover:bg-surface-hover"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded text-sm bg-primary text-white hover:bg-primary/80 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

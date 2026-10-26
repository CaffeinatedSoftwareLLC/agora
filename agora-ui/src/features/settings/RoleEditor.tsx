import { useState } from 'react';
import type { Role } from '../../lib/contracts/roles';
import { usePalette } from '../../theme/usePalette';
import { PermissionGrid } from './PermissionGrid';

interface RoleEditorProps {
  role: Role;
  onSave: (updates: { name?: string; color?: string | null; hoist?: boolean; permissions?: string; mentionable?: boolean }) => Promise<void>;
  onClose: () => void;
}

export function RoleEditor({ role, onSave, onClose }: RoleEditorProps) {
  const defaultColor = usePalette().muted;
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color || defaultColor);
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
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Failed to save role');
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
          className="min-h-11 md:min-h-8 px-2 text-text-muted hover:text-text text-sm"
        >
          Back
        </button>
      </div>

      {error && (
        <div className="bg-danger/15 border border-danger/40 text-danger px-3 py-2 rounded text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-text-muted mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={role.isEveryone}
            maxLength={64}
            className="min-h-11 md:min-h-9 w-full px-3 py-2 rounded bg-surface border border-border text-text disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-sm text-text-muted mb-1">Color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-11 h-11 md:w-10 md:h-10 rounded cursor-pointer"
            />
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              maxLength={7}
              className="min-h-11 md:min-h-9 flex-1 px-3 py-2 rounded bg-surface border border-border text-text font-mono text-sm"
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="min-h-11 md:min-h-9 flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={hoist}
            onChange={(e) => setHoist(e.target.checked)}
            className="accent-primary"
          />
          <span className="text-sm text-text">Display separately in member list</span>
        </label>
        <label className="min-h-11 md:min-h-9 flex items-center gap-2 cursor-pointer">
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
          className="min-h-11 md:min-h-9 px-4 py-2 rounded text-sm text-text-muted hover:bg-surface-hover"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="min-h-11 md:min-h-9 px-4 py-2 rounded text-sm font-medium bg-primary text-on-primary hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

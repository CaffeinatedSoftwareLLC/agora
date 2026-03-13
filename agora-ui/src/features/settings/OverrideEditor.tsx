import { useState } from 'react';
import { PermissionGrid } from './PermissionGrid';

interface OverrideEditorProps {
  name: string;
  allow: string;
  deny: string;
  onSave: (allow: string, deny: string) => void;
  onClose: () => void;
}

export function OverrideEditor({ name, allow: initialAllow, deny: initialDeny, onSave, onClose }: OverrideEditorProps) {
  const [allow, setAllow] = useState(initialAllow);
  const [deny, setDeny] = useState(initialDeny);

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-text">
          Override: {name}
        </h3>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text text-sm"
        >
          Back
        </button>
      </div>

      <p className="text-sm text-text-muted">
        Click each permission to cycle: <span className="text-green-400">Allow</span> → <span className="text-red-400">Deny</span> → <span className="text-text-muted">Inherit</span>
      </p>

      <div className="max-h-96 overflow-y-auto border border-border rounded p-3">
        <PermissionGrid
          triState
          allow={allow}
          deny={deny}
          onChange={(a, d) => { setAllow(a); setDeny(d); }}
        />
      </div>

      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-4 py-2 rounded text-sm text-text-muted hover:bg-surface-hover"
        >
          Cancel
        </button>
        <button
          onClick={() => onSave(allow, deny)}
          className="px-4 py-2 rounded text-sm bg-primary text-white hover:bg-primary/80"
        >
          Save Override
        </button>
      </div>
    </div>
  );
}

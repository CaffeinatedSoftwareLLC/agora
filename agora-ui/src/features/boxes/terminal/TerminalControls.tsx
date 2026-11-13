import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { boxApi, type Box, type TerminalSession, type TerminalStatus } from '../api';
import { INPUT, boxError } from '../boxRules';
import { closeText, formatBytes, formatDuration, readiness } from './terminalRules';

/**
 * The terminal's part of a box's card (docs/box-terminal.md): the button that opens it, what is
 * stopping it, who has one open, its limits (the owner's to change; they are not hidden) and the
 * record of earlier terminals. The owner only: the card hides this from members, and the server
 * refuses them anyway.
 *
 * The button opens the terminal page in a new tab. Nothing is started from here: the page asks
 * for the owner's password and takes a ticket of its own.
 */

const LIMIT_FIELDS = [
  { key: 'terminalIdleMinutes', label: 'Close after this many minutes without a keystroke', min: 1, max: 240 },
  { key: 'terminalMaxHours', label: 'Never stay open longer than this many hours', min: 1, max: 24 },
  { key: 'terminalRateKbps', label: 'Most output the shell may send, KiB per second', min: 16, max: 8192 },
] as const;

export function TerminalControls({ box, onChange }: { box: Box; onChange: () => void }) {
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setStatus(await boxApi.terminalStatus(box.id));
      setSessions((await boxApi.terminalSessions(box.id)).sessions);
      setError('');
    } catch {
      setStatus(null);
      setError('Could not read the terminal\'s state.');
    }
  }, [box.id]);
  // The card re-renders when the box changes (restart, rebuild, update): ask again then
  useEffect(() => { void load(); }, [load, box.state, box.generation, box.imageVersion]);

  const r = status ? readiness(status) : null;
  const open = () => window.open(`/terminal/${box.id}`, '_blank', 'noopener,noreferrer');
  const value = (key: typeof LIMIT_FIELDS[number]['key']) => draft[key] ?? String(box[key] ?? '');
  const changed = LIMIT_FIELDS.some(f => draft[f.key] !== undefined && draft[f.key] !== String(box[f.key] ?? ''));
  const problem = LIMIT_FIELDS.find(f => {
    const v = value(f.key);
    const n = Number(v);
    return v !== '' && (!Number.isInteger(n) || n < f.min || n > f.max);
  });

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body: Record<string, number> = {};
      for (const f of LIMIT_FIELDS) if (draft[f.key] !== undefined) body[f.key] = Number(draft[f.key]);
      await boxApi.update(box.id, body);
      setDraft({});
      onChange();
    } catch (err) {
      setError(boxError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 rounded border border-border bg-bg px-3 py-2" data-testid="terminal-controls">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-text-muted">Terminal</span>
        <Button variant="secondary" onClick={open} disabled={!r?.ready} data-testid="open-terminal">Open terminal</Button>
        {r && !r.ready && <span className="text-xs text-warn" data-testid="terminal-hint">{r.text}</span>}
        {status?.open && (
          <span className="text-xs text-text-muted" data-testid="terminal-open-now">
            A terminal is open{status.open.openedByName ? ` (${status.open.openedByName})` : ''}. Opening another closes it.
          </span>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-danger" role="alert">{error}</p>}
      <details className="mt-1">
        <summary className="flex min-h-11 md:min-h-8 cursor-pointer select-none items-center text-xs font-semibold text-text-muted">Terminal limits and history</summary>
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          <p className="text-xs text-text-muted">These limits are part of what keeps a terminal safe to leave open. They are shown on the terminal page and in its notice.</p>
          <div className="grid gap-2 md:grid-cols-3">
            {LIMIT_FIELDS.map(f => (
              <label key={f.key} className="flex flex-col gap-1 text-xs font-semibold text-text-muted">{f.label}
                <input className={INPUT} inputMode="numeric" value={value(f.key)} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))} />
                <span className="font-normal">Between {f.min} and {f.max}</span>
              </label>
            ))}
          </div>
          <div>
            <Button variant="secondary" onClick={() => void save()} loading={saving} disabled={!changed || !!problem}>Save limits</Button>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-text-muted">Recent terminals</div>
            {sessions.length === 0
              ? <p className="text-xs text-text-muted">None yet.</p>
              : (
                <ul className="flex flex-col gap-1 text-xs" data-testid="terminal-history">
                  {sessions.map(s => (
                    <li key={s.id} className="break-words">
                      {new Date(s.openedAt).toLocaleString()} · {s.openedByName ?? 'someone'} · {formatDuration(s.durationSeconds)} · {formatBytes(s.bytesIn)} typed, {formatBytes(s.bytesOut)} printed
                      {s.state === 'closed' ? ` · ${closeText(s.closeReason)}` : ' · open now'}
                    </li>
                  ))}
                </ul>
              )}
          </div>
        </div>
      </details>
    </div>
  );
}

import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { boxApi, type Box } from './api';
import { INPUT, TOUCH, boxError } from './boxRules';

/**
 * Reset (docs/agent-boxes.md §9): rebuilt on a new, empty home volume. Typing the box's name
 * confirms it; the server checks the same name (`confirm`).
 */
export function ResetBoxDialog({ box, onClose, onDone }: { box: Box; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matches = typed.trim() === box.name;

  const reset = async () => {
    if (!matches) return;
    setBusy(true);
    setError('');
    try {
      await boxApi.action(box.id, 'reset', box.name);
      onDone();
    } catch (err) {
      setError(boxError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Reset ${box.name}?`}>
      <form className="flex flex-col gap-3 text-sm" onSubmit={e => { e.preventDefault(); void reset(); }}>
        <p className="text-text">
          Reset wipes the box&apos;s home folder: the CLI&apos;s login and every cloned repository are gone, along with
          any work not pushed. The box is rebuilt empty and gets new tokens; you log in again afterwards.
        </p>
        <label className="flex flex-col gap-1 text-text-muted">Type <code className="text-text">{box.name}</code> to confirm
          <input className={`${INPUT} font-mono`} value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off"
            autoCapitalize="none" spellCheck={false} aria-label="Box name to confirm reset" />
        </label>
        {error && <p className="text-danger" role="alert">{error}</p>}
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button type="button" variant="secondary" onClick={onClose} className={TOUCH}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={!matches} loading={busy} className={TOUCH}>Reset box</Button>
        </div>
      </form>
    </Modal>
  );
}

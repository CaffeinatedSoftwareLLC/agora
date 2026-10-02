import { useState } from 'react';
import { aiApi, ApiError } from '../../../lib/api';
import type { AIFileTag, AIFileTagInput, AITaggingQueue } from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import { inputClass } from './format';

interface Props {
  serverId: string;
  tags: AIFileTag[];
  max: number;
  queue: AITaggingQueue;
  taggingOn: boolean;
  onChanged: () => void;
}

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.message || err.code) : fallback);

/**
 * The server's file tags. A decision model cannot make up tags: it answers one
 * yes/no question per tag in this list about every uploaded text file. Admins
 * write the question and what counts as yes and as no.
 */
export function TagsSection({ serverId, tags, max, queue, taggingOn, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function retag(includeFailed: boolean) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await aiApi.retagFiles(serverId, includeFailed);
      const queued = res.created + res.requeued + res.retried;
      setMessage(queued === 0 ? 'Every file is already up to date.' : `${queued} file${queued === 1 ? '' : 's'} queued for tagging.`);
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Failed to queue files'));
    } finally {
      setBusy(false);
    }
  }

  const waiting = queue.pending + queue.running;

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold text-text mb-2">File tags</h3>
      <p className="text-sm text-text-muted mb-3">
        When file tagging is on, each uploaded text file or PDF is checked against every tag below, and
        files can then be found by tag. A tag is a yes/no question: say what it means, and what counts as
        yes and as no. Images, audio and video are not tagged.
      </p>

      {!taggingOn && (
        <p className="text-sm text-text-dim mb-3">
          File tagging is off. Turn it on under Decision model above; you can prepare the tags first.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {tags.map(tag => (
          <TagRow key={`${tag.id}:${tag.updatedAt}`} serverId={serverId} tag={tag} onChanged={onChanged} />
        ))}
        {tags.length === 0 && <p className="text-sm text-text-dim">No tags yet.</p>}
      </div>

      {adding ? (
        <div className="border border-border rounded-lg px-4 py-3 mt-2">
          <TagForm
            submitLabel="Add tag"
            onCancel={() => setAdding(false)}
            onSubmit={async data => {
              await aiApi.createTag(serverId, data);
              setAdding(false);
              onChanged();
            }}
          />
        </div>
      ) : (
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <Button variant="secondary" onClick={() => setAdding(true)} disabled={tags.length >= max}>Add a tag</Button>
          {taggingOn && (
            <Button variant="secondary" onClick={() => retag(false)} loading={busy}>Tag files now</Button>
          )}
          {taggingOn && queue.failed > 0 && (
            <button className="text-sm text-primary hover:underline" onClick={() => retag(true)} disabled={busy}>
              Retry {queue.failed} failed
            </button>
          )}
          <span className="text-xs text-text-dim">{tags.length} of {max} tags</span>
        </div>
      )}

      <p className="text-xs text-text-dim mt-3">
        Files: {queue.done} tagged
        {queue.stale > 0 && `, ${queue.stale} out of date (a tag changed since)`}
        {waiting > 0 && `, ${waiting} waiting`}
        {queue.skipped > 0 && `, ${queue.skipped} skipped (no readable text)`}
        {queue.failed > 0 && <span className="text-danger">, {queue.failed} failed</span>}
        . Changing what a tag means makes its results out of date; files are re-checked for that tag in the
        background, or at once with “Tag files now”.
      </p>
      {message && <p className="text-sm text-text-muted mt-2">{message}</p>}
      {error && <p className="text-danger text-sm mt-2">{error}</p>}
    </section>
  );
}

function TagRow({ serverId, tag, onChanged }: { serverId: string; tag: AIFileTag; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError('');
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(errorText(err, fallback));
    }
  }

  if (editing) {
    return (
      <div className="border border-border rounded-lg px-4 py-3">
        <TagForm
          initial={tag}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async data => {
            await aiApi.updateTag(serverId, tag.id, data);
            setEditing(false);
            onChanged();
          }}
        />
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <span className={`font-medium ${tag.enabled ? 'text-text' : 'text-text-dim line-through'}`}>{tag.name}</span>
          {!tag.enabled && <span className="text-xs text-warn ml-2">Off</span>}
          <p className="text-sm text-text-muted break-words">{tag.instructions}</p>
          {(tag.criteriaTrue || tag.criteriaFalse) && (
            <p className="text-xs text-text-dim break-words mt-1">
              {tag.criteriaTrue && <>Yes: {tag.criteriaTrue} </>}
              {tag.criteriaFalse && <>No: {tag.criteriaFalse}</>}
            </p>
          )}
        </div>
        <span className="ml-auto flex items-center gap-3 shrink-0 text-sm">
          <label className="flex items-center gap-1 text-text-muted cursor-pointer">
            <input
              type="checkbox"
              className="accent-primary"
              checked={tag.enabled}
              onChange={e => run(() => aiApi.updateTag(serverId, tag.id, { enabled: e.target.checked }), 'Failed to update')}
            />
            On
          </label>
          <button className="text-primary hover:underline" onClick={() => setEditing(true)}>Edit</button>
          <button
            className="text-danger hover:underline"
            onClick={() => {
              if (window.confirm(`Delete the tag “${tag.name}”? It is removed from every file.`)) {
                void run(() => aiApi.deleteTag(serverId, tag.id), 'Failed to delete');
              }
            }}
          >
            Delete
          </button>
        </span>
      </div>
      {error && <p className="text-danger text-sm mt-2">{error}</p>}
    </div>
  );
}

function TagForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial?: AIFileTag;
  submitLabel: string;
  onSubmit: (data: AIFileTagInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [criteriaTrue, setCriteriaTrue] = useState(initial?.criteriaTrue ?? '');
  const [criteriaFalse, setCriteriaFalse] = useState(initial?.criteriaFalse ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.&+/-]{0,39}$/.test(name.trim())) {
      setError('The name must start with a letter or digit and use only letters, digits, spaces and _ . & + / - (40 characters at most).');
      return;
    }
    if (!instructions.trim()) {
      setError('Say what the tag means.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        name: name.trim(),
        instructions: instructions.trim(),
        criteriaTrue: criteriaTrue.trim() || null,
        criteriaFalse: criteriaFalse.trim() || null,
      });
    } catch (err) {
      setError(errorText(err, 'Failed to save'));
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Name
        <input className={`${inputClass} py-1 text-sm`} value={name} onChange={e => setName(e.target.value)} maxLength={40} placeholder="protocol" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        What the tag means
        <textarea
          className={`${inputClass} py-1 text-sm`}
          rows={2}
          maxLength={500}
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          placeholder="Rules or steps that participants must follow when working together."
        />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Counts as yes (optional)
          <textarea className={`${inputClass} py-1 text-sm`} rows={3} maxLength={500} value={criteriaTrue} onChange={e => setCriteriaTrue(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Counts as no (optional)
          <textarea className={`${inputClass} py-1 text-sm`} rows={3} maxLength={500} value={criteriaFalse} onChange={e => setCriteriaFalse(e.target.value)} />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={submit} loading={saving}>{submitLabel}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
      {error && <p className="text-danger text-sm">{error}</p>}
    </div>
  );
}

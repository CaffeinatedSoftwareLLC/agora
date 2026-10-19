import { AuxPanelControl } from '../shell/AuxPanelControl';
import { useEffect, useRef, useState } from 'react';
import { useChannelStore } from '../../stores/channelStore';
import { useSocket } from '../../hooks/useSocket';
import { fileSearchApi, projectApi, ApiError } from '../../lib/api';
import type { ChannelProject, FileSearchItem } from '../../lib/api';
import { usePalette } from '../../theme';

const MAX_FILES = 10;
const MAX_INSTRUCTIONS = 8000;
/** Plain words separated by single spaces: the host runs it without a shell. */
const VERIFY_PATTERN = /^[A-Za-z0-9_./:@=+,-]+( [A-Za-z0-9_./:@=+,-]+)*$/;

function errorText(err: unknown): string {
  return err instanceof ApiError ? (err.status === 403 ? 'You can\'t change this.' : err.message || err.code) : 'Could not save';
}

/**
 * The channel's project context (docs/project-context.md): instructions and pinned files
 * every agent gets on wake, which the owner and directors edit, and the verify command the
 * server owner may set. Everyone who can see the channel can read it.
 */
export function ProjectPanel() {
  const P = usePalette();
  const socket = useSocket();
  const channelId = useChannelStore(s => s.activeChannelId);

  const [project, setProject] = useState<ChannelProject | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<FileSearchItem[]>([]);
  const [pick, setPick] = useState('');
  const [command, setCommand] = useState('');
  const [retries, setRetries] = useState(2);
  // An edit in progress isn't overwritten by an update from someone else
  const dirty = useRef(false);

  const show = (p: ChannelProject) => {
    setProject(p);
    if (!dirty.current) setDraft(p.instructions);
    setCommand(p.verify?.command ?? '');
    setRetries(p.verify?.maxRetries ?? 2);
  };

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    dirty.current = false;
    setProject(null); setError(''); setNotice('');
    projectApi.get(channelId)
      .then(p => { if (!cancelled) show(p); })
      .catch(err => { if (!cancelled) setError(err instanceof ApiError ? (err.message || err.code) : 'Could not load the project'); });
    return () => { cancelled = true; };
  }, [channelId]);

  // Files shared in the channel, to pin from
  useEffect(() => {
    if (!channelId || !project?.canEdit) return;
    let cancelled = false;
    fileSearchApi.search(channelId, { limit: 25 })
      .then(res => { if (!cancelled) setFiles(res.results); })
      .catch(() => { /* nothing to pick from */ });
    return () => { cancelled = true; };
  }, [channelId, project?.canEdit]);

  useEffect(() => {
    if (!socket || !channelId) return;
    const onUpdate = (p: Omit<ChannelProject, 'canEdit' | 'canEditVerify'>) => {
      if (p.channelId !== channelId) return;
      // The broadcast has no viewer flags: keep this viewer's own
      setProject(prev => prev ? { ...prev, instructions: p.instructions, version: p.version, files: p.files, verify: p.verify,
        updatedAt: p.updatedAt, updatedBy: p.updatedBy } : prev);
      if (!dirty.current) setDraft(p.instructions);
    };
    socket.on('ChannelProjectUpdate', onUpdate);
    return () => { socket.off('ChannelProjectUpdate', onUpdate); };
  }, [socket, channelId]);

  if (!channelId) return null;

  const save = async (fn: () => Promise<ChannelProject>, done: string) => {
    setBusy(true); setError(''); setNotice('');
    try { show(await fn()); setNotice(done); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  const saveInstructions = () => save(async () => {
    const p = await projectApi.update(channelId, { instructions: draft });
    dirty.current = false;
    return p;
  }, 'Instructions saved. Agents get them on their next wake.');
  const pinned = project?.files ?? [];
  const setPinned = (ids: string[], done: string) => save(() => projectApi.update(channelId, { fileIds: ids }), done);
  const unpinned = files.filter(f => !pinned.some(p => p.id === f.id));
  const commandValid = command.trim() === '' || VERIFY_PATTERN.test(command.trim());

  const input = 'min-h-11 md:min-h-9 rounded-lg px-3 py-1.5 text-[16px] md:text-[14px] focus:outline-none';
  const button = 'min-h-11 md:min-h-9 rounded-lg px-3.5 py-1.5 text-[13px] font-semibold transition-colors disabled:opacity-50';
  const section = 'px-4 py-3 flex flex-col gap-2';

  return (
    <div className="w-[340px] shrink-0 flex flex-col border-l" style={{ background: P.bg, borderColor: P.border }}>
      <div className="flex items-center justify-between gap-2 min-h-12 px-4 py-2 shrink-0" style={{ borderBottom: `1px solid ${P.border}` }}>
        <AuxPanelControl label="project" />
        <h2 className="text-[15px] font-semibold flex-1" style={{ color: P.text }}>Project</h2>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!project && !error && <p className="px-4 py-3 text-[13px]" style={{ color: P.muted }}>Loading…</p>}
        {error && <p role="alert" className="px-4 pt-3 text-[13px]" style={{ color: P.danger }}>{error}</p>}
        {notice && <p role="status" className="px-4 pt-3 text-[13px]" style={{ color: P.muted }}>{notice}</p>}

        {project && <>
          <section className={section} style={{ borderBottom: `1px solid ${P.border}` }}>
            <h3 className="text-[13px] font-semibold" style={{ color: P.text }}>Instructions</h3>
            <p className="text-[12px]" style={{ color: P.muted }}>
              Every agent gets these when it wakes in this channel.
              {project.updatedBy && ` Last changed by ${project.updatedBy}.`}
            </p>
            {project.canEdit ? <>
              <textarea
                className={`${input} min-h-40 resize-y`}
                style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.text }}
                value={draft}
                maxLength={MAX_INSTRUCTIONS}
                onChange={e => { dirty.current = true; setDraft(e.target.value); }}
                placeholder="How agents should work here: conventions, commands, what to avoid…"
                aria-label="Project instructions"
              />
              <div className="flex items-center gap-2">
                <span className="text-[11px] flex-1" style={{ color: P.muted }}>{draft.length} / {MAX_INSTRUCTIONS}</span>
                <button type="button" className={button} style={{ background: P.primary, color: P.onPrimary }}
                  disabled={busy || draft === project.instructions} onClick={saveInstructions}>
                  Save instructions
                </button>
              </div>
            </> : (
              <p className="text-[14px] whitespace-pre-wrap break-words" style={{ color: project.instructions ? P.text : P.muted }}>
                {project.instructions || 'No instructions yet.'}
              </p>
            )}
          </section>

          <section className={section} style={{ borderBottom: `1px solid ${P.border}` }}>
            <h3 className="text-[13px] font-semibold" style={{ color: P.text }}>Pinned files ({pinned.length}/{MAX_FILES})</h3>
            <p className="text-[12px]" style={{ color: P.muted }}>Agents get their text on wake and can read them with file_read.</p>
            {pinned.length === 0 && <p className="text-[13px]" style={{ color: P.muted }}>No pinned files.</p>}
            <ul className="flex flex-col gap-1">
              {pinned.map(f => (
                <li key={f.id} className="flex items-center gap-2 min-h-11 md:min-h-9">
                  <span className="text-[14px] flex-1 min-w-0 break-all" style={{ color: P.text }}>{f.name}</span>
                  {project.canEdit && (
                    <button type="button" className={button} style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.text }}
                      disabled={busy} aria-label={`Unpin ${f.name}`}
                      onClick={() => setPinned(pinned.filter(p => p.id !== f.id).map(p => p.id), `Unpinned ${f.name}.`)}>
                      Unpin
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {project.canEdit && pinned.length < MAX_FILES && (
              <div className="flex items-center gap-2">
                <select className={`${input} flex-1 min-w-0`} style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.text }}
                  value={pick} onChange={e => setPick(e.target.value)} aria-label="File to pin">
                  <option value="">{unpinned.length ? 'Pick a file shared here…' : 'No other files shared here'}</option>
                  {unpinned.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <button type="button" className={button} style={{ background: P.primary, color: P.onPrimary }}
                  disabled={busy || !pick}
                  onClick={() => { const f = unpinned.find(x => x.id === pick); setPick(''); void setPinned([...pinned.map(p => p.id), pick], `Pinned ${f?.name ?? 'the file'}.`); }}>
                  Pin
                </button>
              </div>
            )}
          </section>

          <section className={section}>
            <h3 className="text-[13px] font-semibold" style={{ color: P.text }}>Verify before yield</h3>
            <p className="text-[12px]" style={{ color: P.muted }}>
              After a run that changed files, the agent host runs this command in the session's worktree and gives the agent
              any failure to fix, then posts the result here. A host runs it only if its own config lists the same command.
            </p>
            {project.canEditVerify ? <>
              <input className={input} style={{ background: P.surface, border: `1px solid ${commandValid ? P.border : P.danger}`, color: P.text }}
                value={command} onChange={e => setCommand(e.target.value)} placeholder="Off (e.g. npm run verify)"
                maxLength={300} aria-label="Verify command" aria-invalid={!commandValid} />
              {!commandValid && <p className="text-[12px]" style={{ color: P.danger }}>Plain words separated by single spaces; no quotes, pipes or ;.</p>}
              <label className="flex items-center gap-2 text-[13px]" style={{ color: P.text }}>
                Fix turns after a failure
                <select className={input} style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.text }}
                  value={retries} onChange={e => setRetries(Number(e.target.value))}>
                  {[0, 1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <div className="flex items-center gap-2">
                <button type="button" className={button} style={{ background: P.primary, color: P.onPrimary }}
                  disabled={busy || !command.trim() || !commandValid}
                  onClick={() => save(() => projectApi.setVerify(channelId, command.trim(), retries), 'Verify command saved.')}>
                  Save verify
                </button>
                {project.verify && (
                  <button type="button" className={button} style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.text }}
                    disabled={busy} onClick={() => save(() => projectApi.setVerify(channelId, null), 'Verify turned off.')}>
                    Turn off
                  </button>
                )}
              </div>
            </> : (
              <p className="text-[14px]" style={{ color: project.verify ? P.text : P.muted }}>
                {project.verify ? <><code>{project.verify.command}</code>, up to {project.verify.maxRetries} fix turns</> : 'Off. Only the server owner can turn it on.'}
              </p>
            )}
          </section>
        </>}
      </div>
    </div>
  );
}

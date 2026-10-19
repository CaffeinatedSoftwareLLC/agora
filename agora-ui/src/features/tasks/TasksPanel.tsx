import { useCallback, useEffect, useRef, useState } from 'react';
import { AuxPanelControl } from '../shell/AuxPanelControl';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { useSocket } from '../../hooks/useSocket';
import type { AgentSessionUpdatePayload, TaskCardDeletePayload, TaskCardUpdatePayload } from '../../lib/contracts/ws-events';
import { compactTokens, listProfiles, type AgentProfile } from '../agents/agentSessions';
import { SessionWorkspace } from '../agents/SessionWorkspace';
import {
  SESSION_LABEL, STATUSES, STATUS_LABEL, cardSessionState, groupCards, safeUrl, taskApi, taskError, upsertCard,
  type Board, type CardSessionState, type CardStatus, type TaskCard,
} from './taskBoard';

/**
 * Task board (docs/task-board.md): the channel's cards by status. Starting a card starts its
 * assignee in a worktree session in the card's own thread; the card follows that session's
 * branch and pull request. Updates arrive as TaskCardUpdate / TaskCardDelete events, and the
 * board reloads when a session in the channel changes.
 */

const BTN = 'inline-flex min-h-[44px] items-center justify-center rounded-lg border border-border px-3 text-sm text-text hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent';
const BTN_PRIMARY = 'inline-flex min-h-[44px] items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent';
const INPUT = 'min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-[16px] md:text-sm text-text placeholder:text-text-muted/70 focus:outline-none';

const DOT: Record<CardSessionState, string> = {
  working: 'bg-online motion-safe:animate-pulse', idle: 'bg-online', shelved: 'bg-warn', ended: 'bg-text-dim', none: 'bg-text-dim',
};

export function TasksPanel() {
  const channelId = useChannelStore(s => s.activeChannelId);
  const serverId = useChannelStore(s => (channelId ? s.channels.get(channelId)?.serverId : null) ?? null);
  const socket = useSocket();
  const [board, setBoard] = useState<{ channelId: string; data: Board } | null>(null);
  const [error, setError] = useState('');
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const channelRef = useRef(channelId);
  useEffect(() => { channelRef.current = channelId; }, [channelId]);

  const load = useCallback(() => {
    if (!channelId) return;
    const forChannel = channelId;
    taskApi.list(forChannel)
      .then(data => { if (channelRef.current === forChannel) { setBoard({ channelId: forChannel, data }); setError(''); } })
      .catch(err => { if (channelRef.current === forChannel) setError(taskError(err)); });
  }, [channelId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    listProfiles(serverId).then(list => { if (!cancelled) setProfiles(list); }).catch(() => { /* assignee list stays empty */ });
    return () => { cancelled = true; };
  }, [serverId]);

  useEffect(() => {
    if (!socket || !channelId) return;
    const onUpdate = (e: TaskCardUpdatePayload) => {
      if (e.channelId !== channelId) return;
      setBoard(b => b && b.channelId === channelId ? { ...b, data: { ...b.data, cards: upsertCard(b.data.cards, e.card) } } : b);
    };
    const onDelete = (e: TaskCardDeletePayload) => {
      if (e.channelId !== channelId) return;
      setBoard(b => b && b.channelId === channelId ? { ...b, data: { ...b.data, cards: b.data.cards.filter(c => c.id !== e.id) } } : b);
    };
    const onSession = (e: AgentSessionUpdatePayload) => { if (e.channelId === channelId) load(); };
    socket.on('TaskCardUpdate', onUpdate);
    socket.on('TaskCardDelete', onDelete);
    socket.on('AgentSessionUpdate', onSession);
    socket.on('connect', load);
    return () => {
      socket.off('TaskCardUpdate', onUpdate); socket.off('TaskCardDelete', onDelete);
      socket.off('AgentSessionUpdate', onSession); socket.off('connect', load);
    };
  }, [socket, channelId, load]);

  if (!channelId) return null;
  const data = board?.channelId === channelId ? board.data : null;
  const groups = groupCards(data?.cards ?? []);
  const replace = (card: TaskCard) => setBoard(b => b && b.channelId === channelId ? { ...b, data: { ...b.data, cards: upsertCard(b.data.cards, card) } } : b);
  const drop = (id: string) => setBoard(b => b && b.channelId === channelId ? { ...b, data: { ...b.data, cards: b.data.cards.filter(c => c.id !== id) } } : b);

  return (
    <div className="flex w-full shrink-0 flex-col border-l border-border bg-bg md:w-[380px]">
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <AuxPanelControl label="tasks" />
        <h2 className="flex-1 text-[15px] font-semibold text-text">Tasks</h2>
        {data?.canManage && !creating && <button type="button" className={BTN_PRIMARY} onClick={() => setCreating(true)}>New card</button>}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {error && <p className="text-sm text-danger">{error}</p>}
        {!data && !error && <p className="text-sm text-text-muted">Loading…</p>}
        {creating && data && (
          <NewCard channelId={channelId} profiles={profiles} onDone={card => { setCreating(false); if (card) { replace(card); setOpenId(card.id); } }} />
        )}
        {data && data.cards.length === 0 && !creating && (
          <p className="text-sm text-text-muted">
            No cards yet. {data.canManage ? 'Add one, assign an agent and start it: the agent works in its own branch, in the card’s thread.' : 'The owner and directors add cards here.'}
          </p>
        )}
        {data && STATUSES.map(status => {
          const cards = groups[status];
          if (cards.length === 0) return null;
          const collapsed = status === 'done' && !showDone;
          return (
            <section key={status} aria-label={STATUS_LABEL[status]}>
              <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                {STATUS_LABEL[status]} <span className="font-mono">{cards.length}</span>
                {status === 'done' && (
                  <button type="button" className="ml-auto min-h-[44px] px-2 normal-case text-primary" onClick={() => setShowDone(v => !v)}>
                    {showDone ? 'Hide' : 'Show'}
                  </button>
                )}
              </h3>
              {!collapsed && (
                <ul className="space-y-2">
                  {cards.map(card => (
                    <li key={card.id}>
                      <CardItem card={card} board={data} profiles={profiles} open={openId === card.id}
                        onToggle={() => setOpenId(id => id === card.id ? null : card.id)} onChanged={replace} onDeleted={drop} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function NewCard({ channelId, profiles, onDone }: { channelId: string; profiles: AgentProfile[]; onDone: (card?: TaskCard) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [profile, setProfile] = useState('');
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const res = await taskApi.create(channelId, { title: title.trim(), description, ...(profile ? { profile } : {}), start: start && !!profile });
      onDone(res.card);
    } catch (err) { setError(taskError(err)); } finally { setBusy(false); }
  };
  return (
    <form className="space-y-2 rounded-lg border border-border bg-surface p-3" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <input className={INPUT} aria-label="Card title" placeholder="What needs doing?" maxLength={200} value={title} onChange={e => setTitle(e.target.value)} autoFocus />
      <textarea className={`${INPUT} min-h-24`} aria-label="Card description" placeholder="Details for the agent (optional)" maxLength={3000}
        value={description} onChange={e => setDescription(e.target.value)} />
      <AssigneeSelect profiles={profiles} value={profile} onChange={setProfile} />
      <label className="flex min-h-[44px] items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={start && !!profile} disabled={!profile} onChange={e => setStart(e.target.checked)} />
        Start the agent now
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={busy || !title.trim()}>{busy ? 'Adding…' : 'Add card'}</button>
        <button type="button" className={BTN} onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}

function AssigneeSelect({ profiles, value, onChange, disabled }: { profiles: AgentProfile[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <select className={INPUT} aria-label="Assignee agent" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">Unassigned</option>
      {profiles.map(p => <option key={p.id} value={p.name}>{p.name} ({p.adapter})</option>)}
    </select>
  );
}

interface CardItemProps {
  card: TaskCard;
  board: Board;
  profiles: AgentProfile[];
  open: boolean;
  onToggle: () => void;
  onChanged: (card: TaskCard) => void;
  onDeleted: (id: string) => void;
}

function CardItem({ card, board, profiles, open, onToggle, onChanged, onDeleted }: CardItemProps) {
  const openThread = useUIStore(s => s.openThreadView);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { abort.current = new AbortController(); return () => abort.current?.abort(); }, []);

  const state = cardSessionState(card);
  const live = card.session?.state === 'live';
  const pr = safeUrl(card.prUrl);
  const act = async (fn: () => Promise<string | void>) => {
    setBusy(true); setNotice(null);
    try {
      const text = await fn();
      if (!abort.current?.signal.aborted && text) setNotice({ text });
    } catch (err) {
      if (!abort.current?.signal.aborted) setNotice({ text: taskError(err), error: true });
    } finally { if (!abort.current?.signal.aborted) setBusy(false); }
  };
  const update = (body: Parameters<typeof taskApi.update>[2]) => act(async () => { onChanged((await taskApi.update(card.channelId, card.id, body)).card); });

  return (
    <article className="rounded-lg border border-border bg-surface">
      <button type="button" className="flex min-h-[44px] w-full items-start gap-2 px-3 py-2 text-left" aria-expanded={open} onClick={onToggle}>
        <span aria-hidden="true" className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[state]}`} />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium text-text">{card.title}</span>
          <span className="block text-xs text-text-muted">
            {card.profile ? card.profile.name : 'Unassigned'} · {SESSION_LABEL[state]}
            {card.prState ? ` · PR ${card.prState}` : ''}
          </span>
        </span>
      </button>

      {open && (
        <div className="min-w-0 space-y-3 border-t border-border px-3 py-2 text-sm">
          {editing ? (
            <EditCard card={card} onCancel={() => setEditing(false)}
              onSave={body => { setEditing(false); void update(body); }} />
          ) : card.description ? (
            <p className="whitespace-pre-wrap break-words text-text">{card.description}</p>
          ) : <p className="text-text-muted">No description.</p>}

          {card.session && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
              <dt className="text-text-muted">Session</dt>
              <dd className="break-all font-mono">{card.session.id.slice(0, 10)}… · {card.session.state}{card.session.endReason ? ` (${card.session.endReason})` : ''}</dd>
              {card.session.branch && <><dt className="text-text-muted">Branch</dt>
                <dd className="break-all font-mono">{card.session.branch}{card.session.headSha ? ` @ ${card.session.headSha.slice(0, 12)}` : ''}</dd></>}
              <dt className="text-text-muted">Tokens</dt>
              <dd className="font-mono">{compactTokens(card.session.tokensUsed)} / {compactTokens(card.session.tokenBudget)}</dd>
              {card.session.changedPaths.length > 0 && <><dt className="text-text-muted">Last run</dt>
                <dd>{card.session.changedPaths.length} changed {card.session.changedPaths.length === 1 ? 'file' : 'files'}</dd></>}
            </dl>
          )}
          {(pr || card.mergedSha) && (
            <p className="text-xs">
              {pr && <a className="break-all text-primary underline" href={pr} target="_blank" rel="noreferrer">Pull request ({card.prState ?? 'open'})</a>}
              {card.mergedSha && <span className="font-mono"> Squash-merged @ {card.mergedSha.slice(0, 12)}</span>}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {card.threadId && <button type="button" className={BTN} onClick={() => openThread(card.channelId, card.threadId!)}>Open thread</button>}
            {board.canManage && card.profile && !live && (
              <button type="button" className={BTN_PRIMARY} disabled={busy}
                onClick={() => void act(async () => { const r = await taskApi.start(card.channelId, card.id); onChanged(r.card); return r.action === 'resumed' ? 'Session resumed.' : 'Agent started.'; })}>
                {card.session?.state === 'shelved' && card.session.profile === card.profile.name ? 'Resume' : 'Start'}
              </button>
            )}
            {board.canManage && live && (
              <button type="button" className={BTN} disabled={busy}
                onClick={() => void act(async () => { await taskApi.endSession(card.channelId, card.session!.id); return 'Session ended.'; })}>
                End session
              </button>
            )}
            {board.canManage && card.session && (
              <button type="button" className={BTN} disabled={busy || card.session.running}
                onClick={() => void act(() => taskApi.refreshPr(card.channelId, card.session!.id, abort.current?.signal))}>
                Check PR
              </button>
            )}
          </div>

          {board.canManage && (
            <div className="grid grid-cols-2 gap-2">
              <select className={INPUT} aria-label="Status" value={card.status} disabled={busy}
                onChange={e => void update({ status: e.target.value as CardStatus })}>
                {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
              <AssigneeSelect profiles={profiles} value={card.profile?.name ?? ''} disabled={busy || live}
                onChange={v => void update({ profile: v || null })} />
            </div>
          )}

          {card.session && <SessionWorkspace key={card.session.id} channelId={card.channelId} sessionId={card.session.id}
            running={card.session.running} onChanged={() => { /* the card updates from TaskCardUpdate */ }} />}

          {board.canManage && !editing && (
            confirmDelete ? (
              <div role="group" aria-label="Confirm delete" className="space-y-2 rounded border border-danger p-2">
                <p>Delete this card? Its thread{card.session ? ' and session stay; end the session first if it should stop' : ' stays'}.</p>
                <div className="flex gap-2">
                  <button type="button" className={BTN} disabled={busy}
                    onClick={() => void act(async () => { await taskApi.remove(card.channelId, card.id); onDeleted(card.id); })}>Delete</button>
                  <button type="button" className={BTN} onClick={() => setConfirmDelete(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button type="button" className={BTN} onClick={() => setEditing(true)}>Edit</button>
                <button type="button" className={`${BTN} text-danger`} onClick={() => setConfirmDelete(true)}>Delete</button>
              </div>
            )
          )}
          <p aria-live="polite" className={`min-h-[1.25rem] text-sm ${notice?.error ? 'text-danger' : 'text-text-muted'}`}>
            {busy ? 'Working…' : notice?.text ?? ''}
          </p>
        </div>
      )}
    </article>
  );
}

function EditCard({ card, onSave, onCancel }: { card: TaskCard; onSave: (body: { title: string; description: string }) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  return (
    <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (title.trim()) onSave({ title: title.trim(), description }); }}>
      <input className={INPUT} aria-label="Card title" maxLength={200} value={title} onChange={e => setTitle(e.target.value)} />
      <textarea className={`${INPUT} min-h-24`} aria-label="Card description" maxLength={3000} value={description} onChange={e => setDescription(e.target.value)} />
      <div className="flex gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={!title.trim()}>Save</button>
        <button type="button" className={BTN} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

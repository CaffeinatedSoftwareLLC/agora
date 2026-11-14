import { useCallback, useEffect, useRef, useState } from 'react';
import { AuxPanelControl } from '../shell/AuxPanelControl';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { useSocket } from '../../hooks/useSocket';
import type { AgentSessionUpdatePayload, TaskCardDeletePayload, TaskCardUpdatePayload } from '../../lib/contracts/ws-events';
import { compactTokens, limitStopText, limitValue, listProfiles, runAgentCommand, stopLabel, validLimit, type AgentProfile } from '../agents/agentSessions';
import { SessionWorkspace } from '../agents/SessionWorkspace';
import { GithubAutomation } from './GithubAutomation';
import {
  SESSION_LABEL, STATUSES, STATUS_LABEL, cardSessionState, githubApi, groupCards, safeUrl, startError, taskApi, taskError, upsertCard,
  type AgentHost, type Board, type CardSessionState, type CardStatus, type GithubIssue, type GithubState, type TaskCard,
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
  working: 'bg-online motion-safe:animate-pulse', queued: 'bg-warn', idle: 'bg-online', shelved: 'bg-warn', ended: 'bg-text-dim', none: 'bg-text-dim',
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
        {data && <GithubRow key={channelId} channelId={channelId} serverId={serverId} profiles={profiles} onImported={card => replace(card)} />}
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

/**
 * The channel's linked GitHub repository (docs/github-issues.md): the owner links one and
 * picks the host whose `gh` reads it; the owner and directors import its open issues as cards.
 */
function GithubRow({ channelId, serverId, profiles, onImported }: {
  channelId: string; serverId: string | null; profiles: AgentProfile[]; onImported: (card: TaskCard) => void;
}) {
  const [gh, setGh] = useState<GithubState | null>(null);
  const [mode, setMode] = useState<'none' | 'link' | 'import'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    githubApi.get(channelId).then(s => { if (!cancelled) setGh(s); }).catch(() => { /* no bridge on this server: show nothing */ });
    return () => { cancelled = true; };
  }, [channelId]);

  if (!gh || (!gh.link && !gh.canLink)) return null;
  const link = gh.link;
  const unlink = async () => {
    setBusy(true); setError('');
    try { await githubApi.unlink(channelId); setGh({ ...gh, link: null }); setMode('none'); } catch (err) { setError(taskError(err)); } finally { setBusy(false); }
  };

  return (
    <section aria-label="GitHub" className="space-y-2 rounded-lg border border-border bg-surface p-3 text-sm">
      {link ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">
            <span className="block break-all font-mono text-text">{link.repo}</span>
            <span className="block text-xs text-text-muted">
              GitHub via {link.hostName}{link.hostRevoked ? ' (host revoked: link again with another host)' : ''}
            </span>
          </span>
          {gh.canImport && mode !== 'import' && (
            <button type="button" className={BTN} disabled={link.hostRevoked} onClick={() => setMode('import')}>Import issue</button>
          )}
          {gh.canLink && <button type="button" className={BTN} disabled={busy} onClick={() => void unlink()}>Unlink</button>}
        </div>
      ) : mode !== 'link' && (
        <button type="button" className={BTN} onClick={() => setMode('link')}>Link GitHub repo</button>
      )}
      {link && !link.hostRevoked && <GithubAutomation channelId={channelId} canCheck={gh.canImport} />}
      {mode === 'link' && !link && serverId && (
        <LinkRepoForm channelId={channelId} serverId={serverId}
          onDone={next => { setMode('none'); if (next) setGh({ ...gh, link: next }); }} />
      )}
      {mode === 'import' && link && (
        <IssuePicker channelId={channelId} profiles={profiles} onImported={onImported} onClose={() => setMode('none')} />
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}

function LinkRepoForm({ channelId, serverId, onDone }: { channelId: string; serverId: string; onDone: (link?: GithubState['link']) => void }) {
  const [repo, setRepo] = useState('');
  const [hosts, setHosts] = useState<AgentHost[] | null>(null);
  const [hostId, setHostId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    githubApi.hosts(serverId)
      .then(list => { if (!cancelled) { setHosts(list); setHostId(h => h || list[0]?.id || ''); } })
      .catch(err => { if (!cancelled) { setHosts([]); setError(taskError(err)); } });
    return () => { cancelled = true; };
  }, [serverId]);
  const submit = async () => {
    if (!repo.trim() || !hostId || busy) return;
    setBusy(true); setError('');
    try { onDone((await githubApi.link(channelId, repo.trim(), hostId)).link); } catch (err) { setError(taskError(err)); setBusy(false); }
  };
  return (
    <form className="space-y-2" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <input className={INPUT} aria-label="Repository" placeholder="owner/name" maxLength={140} value={repo} onChange={e => setRepo(e.target.value)} autoFocus />
      <select className={INPUT} aria-label="Host" value={hostId} onChange={e => setHostId(e.target.value)}>
        {hosts === null && <option value="">Loading hosts…</option>}
        {hosts?.length === 0 && <option value="">No agent hosts</option>}
        {hosts?.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
      </select>
      <p className="text-xs text-text-muted">The host runs gh with its own GitHub login to list issues and comment on them.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={busy || !repo.trim() || !hostId}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className={BTN} onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}

function IssuePicker({ channelId, profiles, onImported, onClose }: {
  channelId: string; profiles: AgentProfile[]; onImported: (card: TaskCard) => void; onClose: () => void;
}) {
  const [list, setList] = useState<{ commandId: string; issues: GithubIssue[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [profile, setProfile] = useState('');
  const [start, setStart] = useState(false);
  const [importing, setImporting] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  const run = useCallback((ctl: AbortController) => githubApi.listIssues(channelId, ctl.signal)
    .then(res => { if (res && !ctl.signal.aborted) { setList(res); setLoading(false); } })
    .catch(err => { if (!ctl.signal.aborted) { setError(taskError(err)); setLoading(false); } }), [channelId]);
  useEffect(() => { abort.current = new AbortController(); void run(abort.current); return () => abort.current?.abort(); }, [run]);
  const again = () => {
    abort.current?.abort();
    abort.current = new AbortController();
    setLoading(true); setError('');
    void run(abort.current);
  };
  const importIssue = async (issue: GithubIssue) => {
    if (!list || importing !== null) return;
    setImporting(issue.number); setError('');
    try {
      const res = await githubApi.importIssue(channelId, { commandId: list.commandId, number: issue.number, ...(profile ? { profile } : {}), start: start && !!profile });
      onImported(res.card);
      setList(l => l && { ...l, issues: l.issues.map(i => i.number === issue.number ? { ...i, cardId: res.card.id } : i) });
    } catch (err) { setError(taskError(err)); } finally { setImporting(null); }
  };

  return (
    <div className="space-y-2 border-t border-border pt-2">
      <AssigneeSelect profiles={profiles} value={profile} onChange={setProfile} />
      <label className="flex min-h-[44px] items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={start && !!profile} disabled={!profile} onChange={e => setStart(e.target.checked)} />
        Start the agent now
      </label>
      {loading && <p aria-live="polite" className="text-text-muted">Asking the host for open issues…</p>}
      {error && <p className="text-danger">{error}</p>}
      {list && !loading && list.issues.length === 0 && <p className="text-text-muted">No open issues.</p>}
      {list && !loading && list.issues.length > 0 && (
        <ul className="space-y-1" aria-label="Open issues">
          {list.issues.map(issue => (
            <li key={issue.number} className="flex items-start gap-2">
              <span className="min-w-0 flex-1 py-1">
                <span className="block break-words text-text">
                  {safeUrl(issue.url)
                    ? <a className="font-mono text-primary underline" href={safeUrl(issue.url)!} target="_blank" rel="noreferrer">#{issue.number}</a>
                    : <span className="font-mono text-text-muted">#{issue.number}</span>} {issue.title}
                </span>
                <span className="block text-xs text-text-muted">by {issue.author}</span>
              </span>
              {issue.cardId ? <span className="py-3 text-xs text-text-muted">Imported</span> : (
                <button type="button" className={BTN} disabled={importing !== null} aria-label={`Import issue #${issue.number}`} onClick={() => void importIssue(issue)}>
                  {importing === issue.number ? 'Importing…' : 'Import'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <button type="button" className={BTN} disabled={loading} onClick={again}>List again</button>
        <button type="button" className={BTN} onClick={onClose}>Close</button>
      </div>
    </div>
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
  const issueUrl = card.issue ? safeUrl(card.issue.url) : null;
  const issueRef = card.issue ? `${card.issue.repo}#${card.issue.number}` : '';
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
            {card.fromRule && <span className="ml-1 rounded border border-border px-1 text-[11px]" title="Made by this channel's GitHub automation rule">from rule</span>}
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

          {card.issue && (
            <p className="text-xs">
              <span className="text-text-muted">GitHub issue </span>
              {issueUrl ? <a className="break-all text-primary underline" href={issueUrl} target="_blank" rel="noreferrer">{issueRef}</a>
                : <span className="break-all font-mono">{issueRef}</span>}
              {card.issueClosedAt && <span className="ml-2 text-text-muted">· issue closed on GitHub</span>}
            </p>
          )}

          {card.ruleNote && <p className="text-xs text-text-muted">{card.ruleNote}</p>}

          {card.session && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
              <dt className="text-text-muted">Session</dt>
              <dd className="break-all font-mono">{card.session.id.slice(0, 10)}… · {card.session.state}{card.session.endReason ? ` (${stopLabel(card.session)})` : ''}</dd>
              {card.session.branch && <><dt className="text-text-muted">Branch</dt>
                <dd className="break-all font-mono">{card.session.branch}{card.session.headSha ? ` @ ${card.session.headSha.slice(0, 12)}` : ''}</dd></>}
              <dt className="text-text-muted">Tokens</dt>
              <dd className="font-mono">{compactTokens(card.session.tokensUsed)}{card.session.tokenBudget == null ? ' · no limit' : ` / ${compactTokens(card.session.tokenBudget)}`}</dd>
              {card.session.changedPaths.length > 0 && <><dt className="text-text-muted">Last run</dt>
                <dd>{card.session.changedPaths.length} changed {card.session.changedPaths.length === 1 ? 'file' : 'files'}</dd></>}
            </dl>
          )}
          {card.session?.state === 'shelved' && card.session.endReason === 'budget' && (
            <p role="alert" className="rounded-lg border border-border bg-bg/60 p-2 text-xs">{limitStopText(card.session)}</p>
          )}
          {board.isOwner && card.session && card.session.state !== 'ended' && (
            <RaiseBudget key={`budget-${card.session.id}`} card={card} busy={busy}
              onSave={async tokenBudget => {
                let saved = false;
                await act(async () => {
                  const r = await runAgentCommand(card.channelId, { command: 'budget', sessionId: card.session!.id, tokenBudget });
                  onChanged({ ...card, session: { ...card.session!, tokenBudget: r.session ? r.session.tokenBudget ?? null : tokenBudget } });
                  saved = true;
                  return card.session!.state === 'shelved' ? 'Limit saved. Press Resume to continue.' : 'Limit saved.';
                });
                return saved;
              }} />
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
                onClick={() => void act(async () => {
                  try {
                    const r = await taskApi.start(card.channelId, card.id); onChanged(r.card); return r.action === 'resumed' ? 'Session resumed.' : 'Agent started.';
                  } catch (err) { throw new Error(startError(err, card)); }
                })}>
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

/**
 * The owner gives the card's session its own token limit (the agent-commands `budget` command),
 * or clears it (empty) so the agent's "Tokens per session" in Settings → Agents applies, which is
 * no limit unless the owner set one. Any positive whole number is accepted.
 */
function RaiseBudget({ card, busy, onSave }: { card: TaskCard; busy: boolean; onSave: (tokenBudget: number | null) => Promise<boolean> }) {
  const current = card.session!.tokenBudget;
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current == null ? '' : String(current));
  const valid = validLimit(value, true) && limitValue(value) !== current;
  if (!open) {
    return <button type="button" className={BTN} disabled={busy} onClick={() => { setValue(current == null ? '' : String(current)); setOpen(true); }}>Set token limit</button>;
  }
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); if (valid) void onSave(limitValue(value)).then(saved => { if (saved) setOpen(false); }); }}>
      <label className="flex min-w-0 flex-1 flex-col text-xs text-text-muted">This session's token limit (empty: follows the agent's setting)
        <input className={INPUT} type="number" min={1} step={1} inputMode="numeric" value={value} placeholder="No limit of its own" aria-label="Card session token limit"
          onChange={e => setValue(e.target.value)} />
      </label>
      <button type="submit" className={BTN_PRIMARY} disabled={busy || !valid}>Save limit</button>
      <button type="button" className={BTN} onClick={() => setOpen(false)}>Cancel</button>
    </form>
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

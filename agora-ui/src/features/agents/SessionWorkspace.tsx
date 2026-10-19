import { useCallback, useEffect, useRef, useState } from 'react';
import { api, inBackground } from '../../lib/api';

interface Checkpoint { id: string; runId: string; messageId: string | null; sha: string; ref: string; createdAt: string }
interface Checkpoints { checkpoints: Checkpoint[]; next: string | null; canManage: boolean; isOwner: boolean }
interface ReviewResult { files?: string[]; diff?: string; path?: string; revision?: string; next?: number | null; truncated?: boolean; error?: string; message?: string; url?: string }
interface Command { id: string; status: string; result?: ReviewResult }
interface Action { action: 'diff' | 'discard' | 'commit' | 'merge' | 'pr' | 'restore' | 'fork'; path?: string; offset?: number; revision?: string; message?: string; checkpointId?: string }
const button = 'min-h-[44px] rounded border border-border px-3 text-sm disabled:opacity-50';
const descriptions: Record<string,string> = {
  session_busy: 'Wait for the current run or workspace command to finish.',
  diff_changed_refresh: 'The diff changed between pages. Refresh changed files and reopen this file.',
  workspace_not_created_yet: 'This session has no worktree yet. Wait for its first run to start.',
  base_branch_checked_out_use_pr: 'The base branch is checked out. Open a PR, or switch that checkout to another branch before merging.',
  commit_changes_first: 'Commit the session changes first.',
  host_timeout_check_repository_before_retry: 'The host timed out. Check repository state before retrying.',
};
function errorText(e: unknown) { const message = e instanceof Error ? e.message : 'Request failed'; return descriptions[message] ?? message; }
function pollDelay(signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort',done); resolve(); };
    const timer = setTimeout(done,1000);
    if (signal?.aborted) done(); else signal?.addEventListener('abort',done,{once:true});
  });
}
export function SessionWorkspace({ channelId, sessionId, running = false, onChanged }: {
  channelId: string; sessionId: string; running?: boolean; onChanged: () => void;
}) {
  const root = `/channels/${channelId}/sessions/${sessionId}`;
  const [open,setOpen] = useState(false), [busy,setBusy] = useState(false), [notice,setNotice] = useState('');
  const [checkpoints,setCheckpoints] = useState<Checkpoints | null>(null);
  const [files,setFiles] = useState<string[]>([]), [fileNext,setFileNext] = useState<number | null>(null);
  const [patch,setPatch] = useState<ReviewResult | null>(null), [fileTruncated,setFileTruncated] = useState(false);
  const [fileRevision,setFileRevision] = useState<string>();
  const [message,setMessage] = useState(''), [confirm,setConfirm] = useState<Action | null>(null);
  const [url,setUrl] = useState('');
  const abort = useRef<AbortController | null>(null);
  const operation = useRef(false);
  useEffect(() => { abort.current = new AbortController(); return () => abort.current?.abort(); }, []);
  const loadCheckpoints = useCallback(async (before?: string) => {
    const page = await inBackground(() => api.get<Checkpoints>(`${root}/checkpoints${before ? `?before=${before}` : ''}`));
    if (abort.current?.signal.aborted) return;
    setCheckpoints(prev => before && prev ? { ...page, checkpoints: [...prev.checkpoints,...page.checkpoints] } : page);
  },[root]);
  useEffect(()=>{
    if (open) void loadCheckpoints().catch(e=>{if(!abort.current?.signal.aborted)setNotice(errorText(e));});
  },[open,running,loadCheckpoints]);
  async function run(body: Action, existing?: Command) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true); setNotice('Waiting for the host…'); setConfirm(null); setUrl('');
    try {
      const command = existing ?? await api.post<Command>(`${root}/workspace-commands`,body);
      const deadline = Date.now() + 210000;
      let status = command;
      while (status.status === 'queued' || status.status === 'claimed') {
        await pollDelay(abort.current?.signal);
        if (abort.current?.signal.aborted) return;
        if (Date.now() >= deadline) throw new Error('Host has not responded. Reopen review to check its status; do not repeat a mutation until its result is known.');
        status = await inBackground(() => api.get<Command>(`${root}/workspace-commands/${command.id}`));
      }
      if (abort.current?.signal.aborted) return;
      const result = status.result ?? {};
      if (status.status !== 'succeeded') throw new Error(result.error ?? 'Workspace command failed');
      if (body.action === 'diff' && !body.path) {
        setFiles(prev => body.offset ? [...prev,...result.files ?? []] : result.files ?? []);
        setFileNext(result.next ?? null); setFileTruncated(!!result.truncated);
        setFileRevision(result.revision); if (!body.offset) setPatch(null);
      } else if (body.action === 'diff') setPatch(prev => body.offset && prev && prev.path === body.path
        ? {...result,diff:(prev.diff??'')+(result.diff??'')} : result);
      else { setFiles([]); setPatch(null); setFileNext(null); await loadCheckpoints(); onChanged(); }
      setNotice(result.message ?? (body.action === 'diff' ? 'Review loaded.' : 'Done.'));
      if (result.url && /^https:\/\//.test(result.url)) setUrl(result.url);
    } catch (e) { if (!abort.current?.signal.aborted) setNotice(errorText(e)); }
    finally { operation.current=false; if (!abort.current?.signal.aborted) setBusy(false); }
  }
  async function expand() {
    setOpen(v=>!v);
    if (!open && !operation.current) {
      try {
        const latest = await inBackground(()=>api.get<{command: (Command & {action:Action['action'];payload:Action}) | null}>(`${root}/workspace-commands/latest`));
        if (abort.current?.signal.aborted) return;
        if (latest.command && ['queued','claimed'].includes(latest.command.status)) void run({...latest.command.payload,action:latest.command.action},latest.command);
        else if (latest.command?.result?.error) setNotice(errorText(new Error(latest.command.result.error)));
      } catch(e) { setNotice(errorText(e)); }
    }
  }
  const disabled = busy || running;
  return <section className="min-w-0 space-y-2 rounded-lg border border-border p-2">
    <button type="button" className={`${button} w-full`} aria-expanded={open} onClick={()=>void expand()}>Review changes & checkpoints</button>
    {open && <div className="min-w-0 space-y-3">
      {running && <p className="text-sm">Review is available when this run finishes.</p>}
      <button type="button" className={button} disabled={disabled} onClick={()=>void run({action:'diff'})}>Refresh changed files</button>
      <p className="text-xs text-text-muted">Changes compared with the session’s saved base. File lists and patches have a preview cap.</p>
      <ul className="max-h-64 overflow-y-auto">{files.map(file=><li key={file} className="flex min-w-0 items-center gap-1">
        <button type="button" className={`${button} min-w-0 flex-1 break-all text-left font-mono`} disabled={disabled} onClick={()=>void run({action:'diff',path:file})}>{file}</button>
        {checkpoints?.canManage && <button type="button" className={button} disabled={disabled} aria-label={`Discard ${file}`} onClick={()=>setConfirm({action:'discard',path:file})}>Discard</button>}
      </li>)}</ul>
      {fileNext !== null && <button type="button" className={button} disabled={disabled} onClick={()=>void run({action:'diff',offset:fileNext,revision:fileRevision})}>More files</button>}
      {fileTruncated && <p className="text-sm">File list truncated at 1,000 files or 128 KiB. Review remaining files on the host.</p>}
      {patch && <div className="min-w-0 space-y-1"><p className="break-all font-mono text-xs">{patch.path}</p>
        <pre aria-label="Unified diff" className="max-h-[50dvh] max-w-full overflow-auto rounded bg-bg p-2 font-mono text-xs" tabIndex={0}>
          {(patch.diff || 'No changes.').split('\n').map((line,i)=><span key={i} className={`block ${line.startsWith('+')?'text-online':line.startsWith('-')?'text-danger':''}`}>{line || ' '}</span>)}
        </pre>
        {patch.next != null && <button type="button" className={button} disabled={disabled} onClick={()=>void run({action:'diff',path:patch.path,offset:patch.next!,revision:patch.revision})}>More diff</button>}
        {patch.truncated && <p className="text-sm">Patch truncated at 128 KiB. Review the full file on the host.</p>}
      </div>}
      {checkpoints?.canManage && <div className="space-y-2">
        <label className="block text-sm">Commit message<input aria-label="Commit message" maxLength={2000} value={message} onChange={e=>setMessage(e.target.value)} className="mt-1 min-h-[44px] w-full rounded border border-border bg-bg px-2" /></label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={disabled||!message.trim()} onClick={()=>void run({action:'commit',message})}>Commit all</button>
          <button type="button" className={button} disabled={disabled} onClick={()=>setConfirm({action:'merge',message:message||undefined})}>Squash merge</button>
          <button type="button" className={button} disabled={disabled} onClick={()=>void run({action:'pr',message:message||undefined})}>Open GitHub PR</button>
        </div>
      </div>}
      <h4 className="text-sm font-semibold">Checkpoints</h4>
      {checkpoints?.checkpoints.length === 0 && <p className="text-sm text-text-muted">A checkpoint is saved after each run that changes files.</p>}
      <ul className="space-y-2">{checkpoints?.checkpoints.map(cp=><li key={cp.id} className="space-y-1 rounded border border-border p-2 text-xs">
        <p>{new Date(cp.createdAt).toLocaleString()} · {cp.sha.slice(0,12)}</p>
        <details><summary>Run and triggering message</summary><p className="break-all">Run {cp.runId}</p><p className="break-all">Message {cp.messageId ?? 'Unavailable'}</p></details>
        {checkpoints.isOwner && <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={disabled} onClick={()=>setConfirm({action:'restore',checkpointId:cp.id})}>Restore to here</button>
          <button type="button" className={button} disabled={disabled} onClick={()=>void run({action:'fork',checkpointId:cp.id})}>Fork from here</button>
        </div>}
      </li>)}</ul>
      {checkpoints?.next && <button type="button" className={button} disabled={disabled} onClick={()=>void loadCheckpoints(checkpoints.next!).catch(e=>setNotice(errorText(e)))}>Older checkpoints</button>}
      {confirm && <div role="group" aria-label="Confirm workspace action" className="space-y-2 rounded border border-danger p-2 text-sm">
        <p>{confirm.action==='restore'?'Replace tracked and untracked session files with this checkpoint? Later checkpoint refs remain available.':confirm.action==='discard'?`Discard all changes to ${confirm.path} since the session base?`:'Squash the committed session branch into its base branch?'}</p>
        <button type="button" className={button} disabled={disabled} onClick={()=>void run(confirm)}>Confirm {confirm.action}</button>{' '}
        <button type="button" className={button} onClick={()=>setConfirm(null)}>Cancel</button>
      </div>}
      <p role="status" className="break-words text-sm">{notice}</p>
      {url && <a className="block min-h-[44px] break-all text-primary underline" href={url} target="_blank" rel="noreferrer">View pull request</a>}
    </div>}
  </section>;
}

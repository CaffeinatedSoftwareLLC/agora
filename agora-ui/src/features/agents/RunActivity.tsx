import { useCallback, useEffect, useState } from 'react';
import { useSocket } from '../../hooks/useSocket';
import type { AgentRunProgressPayload, AgentSessionUpdatePayload } from '../../lib/contracts/ws-events';
import { elapsedTime, listSessions, type AgentSession } from './agentSessions';

/** Mounted with a channel key so requests and timers cannot leak into another channel. */
export function RunActivity({ channelId }: { channelId: string }) {
  const socket = useSocket();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // Latest progress per session, from ACP agents' heartbeats; kept only for the run it names
  const [progress, setProgress] = useState<Record<string, AgentRunProgressPayload>>({});
  const refresh = useCallback(() => { void listSessions(channelId).then(setSessions).catch(() => {}); }, [channelId]);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const load = () => {
      const requested = ++revision;
      void listSessions(channelId).then(s => { if (active && requested === revision) setSessions(s); }).catch(() => {});
    };
    load();
    const changed = (event: AgentSessionUpdatePayload) => { if (event.channelId === channelId) load(); };
    const progressed = (event: AgentRunProgressPayload) => { if (event.channelId === channelId) setProgress(p => ({ ...p, [event.sessionId]: event })); };
    socket?.on('AgentSessionUpdate', changed);
    socket?.on('AgentRunProgress', progressed);
    socket?.on('connect', load);
    const poll = setInterval(load, 20_000);
    return () => {
      active = false; clearInterval(poll);
      socket?.off('AgentSessionUpdate', changed); socket?.off('AgentRunProgress', progressed); socket?.off('connect', load);
    };
  }, [channelId, socket]);
  const running = sessions.some(s => s.run?.status === 'claimed');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return <div className="shrink-0 px-4 text-sm text-text-muted" aria-label="Agent run activity">
    {sessions.map(s => {
      const run = s.run;
      const paused = s.state === 'shelved' && s.endReason === 'budget';
      if (!run && !paused) return null;
      const blocked = run?.error === 'nothing_posted';
      const failed = run?.status === 'failed' || run?.status === 'expired';
      const working = run?.status === 'claimed' && !paused;
      if (!working && !paused && !blocked && !failed && !run?.changedPaths.length) return null;
      const step = working ? progress[s.id] : undefined;
      return <div key={s.id} className="py-1">
        <p role="status">{s.profile}{paused ? ' paused: session budget used up.' : working ? ` is working\u2026 ${elapsedTime(run.startedAt, now)}` : blocked ? ' finished without posting a reply (possibly blocked).' : failed ? ` run failed: ${run.error ?? 'lease expired'}.` : ' finished.'}</p>
        {step && step.runId === run?.id && <p className="truncate text-xs" aria-label={`${s.profile} progress`}>
          {[step.step, `${step.toolCalls} tool ${step.toolCalls === 1 ? 'call' : 'calls'}`,
            step.planTotal ? `plan ${step.planDone ?? 0}/${step.planTotal}` : null].filter(Boolean).join(' \u00b7 ')}
        </p>}
        {run && run.changedPaths.length > 0 && <details>
          <summary className="cursor-pointer">{run.changedPaths.length} changed {run.changedPaths.length === 1 ? 'file' : 'files'}</summary>
          <ul className="max-h-40 overflow-y-auto font-mono text-xs">{run.changedPaths.map(path => <li className="break-all" key={path}>{path}</li>)}</ul>
        </details>}
        {failed && <button type="button" className="underline" onClick={refresh}>Refresh run status</button>}
      </div>;
    })}
  </div>;
}

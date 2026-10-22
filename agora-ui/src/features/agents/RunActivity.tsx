import { useCallback, useEffect, useState } from 'react';
import { useSocket } from '../../hooks/useSocket';
import type { AgentRunProgressPayload, AgentSessionUpdatePayload } from '../../lib/contracts/ws-events';
import { elapsedTime, listSessions, terminalUsage, type AgentSession } from './agentSessions';
import { useAuthStore } from '../../stores/authStore';
import { useExpandedNoticeRuns } from '../messages/useExpandedNoticeRuns';
import { AgentMessageRunToggle, AgentRunCollapse } from '../messages/AgentMessageRun';

const isWorking = (s: AgentSession) => s.kind === 'terminal' ? s.state === 'live' && !!s.running
  : s.run?.status === 'claimed' && !(s.state === 'shelved' && s.endReason === 'budget');
const isHistorical = (s: AgentSession) => s.kind !== 'terminal' && !isWorking(s)
  && ((s.state === 'shelved' && s.endReason === 'budget') || s.run?.error === 'nothing_posted'
    || s.run?.status === 'failed' || s.run?.status === 'expired' || !!s.run?.changedPaths.length);

/** Mounted with a channel key so requests and timers cannot leak into another channel. */
export function RunActivity({ channelId }: { channelId: string }) {
  const socket = useSocket();
  const userId = useAuthStore(s => s.user?.id);
  const { isExpanded, toggle } = useExpandedNoticeRuns(userId);
  const sectionKey = `activity:${channelId}`;
  const expanded = isExpanded(sectionKey);
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
  const historical = sessions.filter(isHistorical);
  const renderSession = (s: AgentSession) => {
      // A terminal session (#112) has no runs: agora-mcp reports working while the agent calls tools
      if (s.kind === 'terminal') {
        if (s.state !== 'live' || !s.running) return null;
        return <div key={s.id} className="py-1">
          <p role="status">{s.botUsername} is working in its terminal…</p>
          <p className="truncate text-xs" aria-label={`${s.botUsername} terminal usage`}>{terminalUsage(s)} · no budget (own CLI)</p>
        </div>;
      }
      const run = s.run;
      const paused = s.state === 'shelved' && s.endReason === 'budget';
      if (!run && !paused) return null;
      const blocked = run?.error === 'nothing_posted';
      const failed = run?.status === 'failed' || run?.status === 'expired';
      const working = run?.status === 'claimed' && !paused;
      if (!working && !paused && !blocked && !failed && !run?.changedPaths.length) return null;
      const step = working ? progress[s.id] : undefined;
      return <div key={s.id} className={isHistorical(s) ? 'px-3 py-1' : 'py-1'}>
        <p role="status">{s.profile}{paused ? ' paused: session budget used up.' : working ? ` is working\u2026 ${elapsedTime(run.startedAt, now)}` : blocked ? ' finished without posting a reply (possibly blocked).' : failed ? ` run failed: ${run.error ?? 'lease expired'}.` : ' finished.'}</p>
        {step && step.runId === run?.id && <p className="truncate text-xs" aria-label={`${s.profile} progress`}>
          {[step.step, `${step.toolCalls} tool ${step.toolCalls === 1 ? 'call' : 'calls'}`,
            step.planTotal ? `plan ${step.planDone ?? 0}/${step.planTotal}` : null].filter(Boolean).join(' \u00b7 ')}
        </p>}
        {run && run.changedPaths.length > 0 && <details>
          <summary className="min-h-11 cursor-pointer content-center">{run.changedPaths.length} changed {run.changedPaths.length === 1 ? 'file' : 'files'}</summary>
          <ul className="max-h-40 overflow-y-auto font-mono text-xs">{run.changedPaths.map(path => <li className="break-all" key={path}>{path}</li>)}</ul>
        </details>}
        {failed && <button type="button" className="underline" onClick={refresh}>Refresh run status</button>}
      </div>;
    };
  return <div className="shrink-0 text-sm text-text-muted" aria-label="Agent run activity">
    <div className="px-4">{sessions.filter(isWorking).map(renderSession)}</div>
    {historical.length > 0 && <>
      <AgentMessageRunToggle count={historical.length} names={[...new Set(historical.map(s => s.botUsername || s.profile))]}
        expanded={expanded} onToggle={() => toggle(sectionKey)} />
      {expanded && <div className="mx-4 max-h-[25dvh] overflow-y-auto rounded-b-lg border-b border-l-2 border-border border-l-primary/40 bg-surface/30" data-agent-activity-group>
        {historical.map(renderSession)}
        <AgentRunCollapse count={historical.length} onCollapse={() => toggle(sectionKey)} />
      </div>}
    </>}
  </div>;
}

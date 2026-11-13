import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSocket } from '../../hooks/useSocket';
import type { AgentRunStreamEndPayload, AgentRunStreamPayload, RunStreamEvent } from '../../lib/contracts/ws-events';

/**
 * Live output of hosted runs (docs/live-output.md): what an agent writes and the steps it takes
 * while it works. Ephemeral: the socket sends batches to the channel's room, the API keeps a tail
 * of each running run for a person who opens the channel mid-run, and nothing is stored.
 */
export interface StreamStep { step: string; tool: string; label: string; state: 'running' | 'ok' | 'failed' }
export interface RunStreamView {
  runId: string;
  sessionId: string;
  threadId: string | null;
  profile: string | null;
  seq: number;
  /** The agent's visible text of its current message. */
  text: string;
  textTruncated: boolean;
  steps: StreamStep[];
}

const MAX_TEXT = 16000;
const MAX_STEPS = 50;
const MAX_RUNS = 20;
const NONE: Record<string, RunStreamView> = {};

export function emptyView(p: { runId: string; sessionId: string; threadId?: string | null; profile?: string | null }): RunStreamView {
  return { runId: p.runId, sessionId: p.sessionId, threadId: p.threadId ?? null, profile: p.profile ?? null, seq: 0, text: '', textTruncated: false, steps: [] };
}

/** Fold events into a view. Pure: returns a new view. */
export function applyEvents(view: RunStreamView, events: RunStreamEvent[]): RunStreamView {
  let { text, textTruncated } = view;
  const steps = view.steps.slice();
  for (const e of events) {
    if (e.type === 'text') {
      text = e.replace ? e.delta : text + e.delta;
      if (e.replace) textTruncated = false;
      if (text.length > MAX_TEXT) { text = text.slice(-MAX_TEXT); textTruncated = true; }
    } else if (e.state === 'start') {
      if (steps.some(s => s.step === e.step)) continue;
      steps.push({ step: e.step, tool: e.tool ?? 'tool', label: e.label ?? 'Working', state: 'running' });
      if (steps.length > MAX_STEPS) steps.shift();
    } else {
      const i = steps.findIndex(s => s.step === e.step);
      if (i >= 0) steps[i] = { ...steps[i], state: e.state };
    }
  }
  return { ...view, text, textTruncated, steps };
}

/**
 * The live streams of one channel's running runs, by run id. A person who opens the channel
 * mid-run gets the API's tail first; batches that arrived before it are replayed after it, and a
 * batch whose number the tail already covers is skipped.
 */
export function useRunStreams(channelId: string | null, enabled = true): Record<string, RunStreamView> {
  const socket = useSocket();
  // Keyed by channel: another channel's streams are never shown, and no reset is needed on a change
  const [state, setState] = useState<{ key: string | null; views: Record<string, RunStreamView> }>({ key: null, views: {} });
  useEffect(() => {
    if (!channelId || !enabled) return;
    const setViews = (fn: (prev: Record<string, RunStreamView>) => Record<string, RunStreamView>) =>
      setState(prev => ({ key: channelId, views: fn(prev.key === channelId ? prev.views : {}) }));
    let active = true;
    let loaded = false;
    const pending: AgentRunStreamPayload[] = [];
    const ended = new Set<string>();
    const apply = (prev: Record<string, RunStreamView>, p: AgentRunStreamPayload) => {
      if (ended.has(p.runId)) return prev;
      const base = prev[p.runId] ?? emptyView(p);
      if (p.seq <= base.seq) return prev;
      const next = { ...prev, [p.runId]: { ...applyEvents(base, p.events), seq: p.seq, profile: p.profile ?? base.profile, threadId: p.threadId } };
      const ids = Object.keys(next);
      if (ids.length > MAX_RUNS) delete next[ids[0]];
      return next;
    };
    const onStream = (p: AgentRunStreamPayload) => {
      if (p.channelId !== channelId) return;
      if (!loaded) { pending.push(p); return; }
      setViews(prev => apply(prev, p));
    };
    const onEnd = (p: AgentRunStreamEndPayload) => {
      if (p.channelId !== channelId) return;
      ended.add(p.runId);
      setViews(prev => { if (!(p.runId in prev)) return prev; const rest = { ...prev }; delete rest[p.runId]; return rest; });
    };
    const load = async () => {
      let streams: RunStreamView[] = [];
      try { streams = (await api.get<{ streams: RunStreamView[] }>(`/channels/${channelId}/agent-run-streams`)).streams ?? []; } catch { /* no tail: live batches still arrive */ }
      if (!active) return;
      loaded = true;
      setViews(prev => {
        // The tail is the truth for what it covers; a live batch already applied stays when it is newer
        const next: Record<string, RunStreamView> = {};
        for (const s of streams) if (!ended.has(s.runId)) next[s.runId] = prev[s.runId] && prev[s.runId].seq > s.seq ? prev[s.runId] : s;
        let merged = next;
        for (const p of pending.splice(0)) merged = apply(merged, p);
        return merged;
      });
    };
    const reconnect = () => { loaded = false; void load(); };
    socket?.on('AgentRunStream', onStream);
    socket?.on('AgentRunStreamEnd', onEnd);
    socket?.on('connect', reconnect);
    void load();
    return () => {
      active = false;
      socket?.off('AgentRunStream', onStream); socket?.off('AgentRunStreamEnd', onEnd); socket?.off('connect', reconnect);
    };
  }, [channelId, socket, enabled]);
  return enabled && state.key === channelId ? state.views : NONE;
}

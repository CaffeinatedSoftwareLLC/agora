import { cleanStep } from './agent-runs';
import { sanitizeMessageText } from './sanitize-text';

/**
 * Live output of a hosted agent run (docs/live-output.md): the text an agent writes and the
 * steps it takes (reading a file, running a command), relayed to the channel while the run goes.
 *
 * Ephemeral by design: the host posts batches, the API keeps a bounded tail per run in memory so
 * a person who opens the channel mid-run sees what came before, and everything is dropped when the
 * run ends. Nothing here is written to the database; the agent's real posts still arrive through
 * agora-mcp. One API process holds the tails, as it does the Socket.IO rooms.
 */

/** Limits that protect the API from a chatty host. The host's own batching stays well inside them. */
export const STREAM_LIMITS = {
    /** Events in one batch. */
    maxEvents: 200,
    /** Characters in one text delta. */
    maxDelta: 8000,
    /** Characters of a step label (the host writes 120 at most). */
    maxLabel: 200,
    /** Characters of one message the API keeps and relays; later text of that message is dropped. */
    maxMessageChars: 64 * 1024,
    /** Characters of that message a late joiner is given (its end). */
    tailChars: 16000,
    /** Steps kept per run (the oldest drop first). */
    maxSteps: 50,
    /** Runs held at once (the least recently updated drops first). */
    maxRuns: 500,
    /** A run's tail with no update for this long is dropped (its run is over or lost). */
    staleMs: 30 * 60 * 1000,
} as const;

export interface WireTextEvent { type: 'text'; message: string; delta: string }
export interface WireStepEvent { type: 'step'; step: string; state: 'start' | 'ok' | 'failed'; tool?: string; label?: string }
export type WireEvent = WireTextEvent | WireStepEvent;

/** What the channel receives: a text event may replace the text so far (cleaning changed it). */
export type OutEvent = { type: 'text'; message: string; delta: string; replace?: boolean } | WireStepEvent;

export interface StreamStep { step: string; tool: string; label: string; state: 'running' | 'ok' | 'failed' }
export interface RunStreamMeta { channelId: string; sessionId: string; threadId: string | null; profile: string | null }
interface RunTail extends RunStreamMeta {
    runId: string; seq: number; updatedAt: number;
    message: string | null; raw: string; clean: string; truncated: boolean;
    steps: StreamStep[];
}
export interface RunStreamSnapshot {
    sessionId: string; runId: string; threadId: string | null; profile: string | null; seq: number;
    text: string; textTruncated: boolean; steps: StreamStep[];
}

const tails = new Map<string, RunTail>();

function collect(now: number) {
    for (const [id, t] of tails) if (now - t.updatedAt > STREAM_LIMITS.staleMs) tails.delete(id);
    while (tails.size > STREAM_LIMITS.maxRuns) {
        const oldest = [...tails.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
        tails.delete(oldest.runId);
    }
}

const label = (text: string | undefined) => cleanStep(text)?.slice(0, STREAM_LIMITS.maxLabel) ?? '';
const idOf = (text: string) => text.replace(/[^\w.:-]/g, '').slice(0, 64);

/**
 * Fold a host's batch into the run's tail and return what to emit. The text is cleaned as a
 * message is (escape sequences and private keys, sanitizeMessageText) over everything received so
 * far, so a key split across two batches is still caught; the channel gets the cleaned difference.
 */
export function applyBatch(runId: string, meta: RunStreamMeta, events: WireEvent[], now = Date.now()): { seq: number; events: OutEvent[] } {
    collect(now);
    let t = tails.get(runId);
    if (!t) { t = { ...meta, runId, seq: 0, updatedAt: now, message: null, raw: '', clean: '', truncated: false, steps: [] }; tails.set(runId, t); }
    t.updatedAt = now; t.profile = meta.profile; t.threadId = meta.threadId;
    const out: OutEvent[] = [];
    for (const e of events) {
        if (e.type === 'text') {
            const message = idOf(e.message) || 'm';
            let replace = false;
            if (t.message !== message) { t.message = message; t.raw = ''; t.clean = ''; t.truncated = false; replace = true; }
            const room = STREAM_LIMITS.maxMessageChars - t.raw.length;
            if (e.delta.length > room) t.truncated = true;
            if (room <= 0) continue;
            t.raw += e.delta.slice(0, room);
            const clean = sanitizeMessageText(t.raw);
            const grows = clean.startsWith(t.clean);
            const delta = grows ? clean.slice(t.clean.length) : clean;
            t.clean = clean;
            if (delta || replace) out.push({ type: 'text', message, delta, ...(!grows || replace ? { replace: true } : {}) });
        } else {
            const step = idOf(e.step);
            if (!step) continue;
            const existing = t.steps.find(s => s.step === step);
            if (e.state === 'start') {
                if (existing) continue;
                const entry: StreamStep = { step, tool: cleanStep(e.tool)?.slice(0, 40) ?? 'tool', label: label(e.label) || 'Working', state: 'running' };
                t.steps.push(entry);
                if (t.steps.length > STREAM_LIMITS.maxSteps) t.steps.shift();
                out.push({ type: 'step', step, state: 'start', tool: entry.tool, label: entry.label });
            } else if (existing) {
                existing.state = e.state;
                out.push({ type: 'step', step, state: e.state });
            }
        }
    }
    if (out.length) t.seq++;
    return { seq: t.seq, events: out };
}

/** The tails of these runs, for a person opening the channel mid-run. */
export function snapshots(runIds: string[]): RunStreamSnapshot[] {
    collect(Date.now());
    const out: RunStreamSnapshot[] = [];
    for (const id of runIds) {
        const t = tails.get(id);
        if (!t) continue;
        out.push({ sessionId: t.sessionId, runId: t.runId, threadId: t.threadId, profile: t.profile, seq: t.seq,
            text: t.clean.slice(-STREAM_LIMITS.tailChars), textTruncated: t.truncated || t.clean.length > STREAM_LIMITS.tailChars,
            steps: t.steps.map(s => ({ ...s })) });
    }
    return out;
}

/** The run is over (completed, failed, cancelled or lost): drop its tail. */
export function endRunStream(runId: string): void { tails.delete(runId); }

/** Tests only. */
export function resetRunStreams(): void { tails.clear(); }

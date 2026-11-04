import type { ProtocolInfo } from '../../lib/contracts/ws-events';

export interface ThreadWaiting {
  /** The agent that owes the thread's next step. */
  on: string;
  /** What it is waiting for, when a WAIT said. */
  for: string | null;
  /** When the waiting started: the latest protocol message's time. */
  since: string;
  messageId: string;
}

type WaitingSource = { id: string; protocol?: ProtocolInfo; deletedAt?: string; authorUsername?: string | null; createdAt: string };

/**
 * Who a thread waits on (#327), the same rule as the server's `threadWaiting`
 * (src/lib/protocol.ts): the latest protocol message decides. A WAIT names the agent that owes
 * the next step (its author when it names nobody); any other message that YIELDs waits on the
 * agent it yields to; DONE, BLOCK, CANCEL and DECIDE · BLOCK end the wait.
 */
export function threadWaiting(messages: readonly WaitingSource[]): ThreadWaiting | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.protocol || m.deletedAt) continue;
    const p = m.protocol;
    if (p.state === 'DONE' || p.state === 'BLOCK' || p.state === 'CANCEL' || (p.state === 'DECIDE' && p.decision === 'BLOCK')) return null;
    const on = p.state === 'WAIT' ? (p.waitingOn ?? m.authorUsername ?? null) : (p.yieldTo ?? null);
    if (!on) return null;
    return { on, for: p.state === 'WAIT' ? (p.waitingFor ?? null) : null, since: m.createdAt, messageId: m.id };
  }
  return null;
}

/** "52 min", "3 h 5 min". */
export function waitedFor(since: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}

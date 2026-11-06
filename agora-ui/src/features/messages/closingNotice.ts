export interface ClosingNotice { reason: string | null; successorId: string | null; successorChannelId: string | null }

/**
 * The newest `thread_closed` notice of the current closure: why the thread ended and where its
 * work went (#132). A notice from before the thread was last closed belongs to an earlier
 * closure that was reopened since; the server writes it at or after `closedAt`.
 */
export function closingNotice(
  replies: readonly { systemEvent?: string | null; systemData?: Record<string, unknown>; createdAt?: string }[],
  closedAt?: string | null,
): ClosingNotice | null {
  const since = closedAt ? Date.parse(closedAt) : NaN;
  for (let i = replies.length - 1; i >= 0; i--) {
    const r = replies[i];
    if (r.systemEvent !== 'thread_closed') continue;
    if (!Number.isNaN(since) && r.createdAt && Date.parse(r.createdAt) < since) return null;
    const d = r.systemData ?? {};
    const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return { reason: text(d.reason), successorId: text(d.successorId), successorChannelId: text(d.successorChannelId) };
  }
  return null;
}

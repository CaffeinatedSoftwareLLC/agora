export const GROUP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

type MessageLike = { authorId: string; createdAt: string; deletedAt?: string };

export function shouldGroup(
  prev: MessageLike | undefined,
  curr: MessageLike,
): boolean {
  if (!prev) return false;
  if (prev.deletedAt || curr.deletedAt) return false;
  if (prev.authorId !== curr.authorId) return false;
  const diff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return diff < GROUP_THRESHOLD_MS;
}

/** Estimated pixel height for a single message row (used by virtualizer). */
export function estimateMessageHeight(
  prev: MessageLike | undefined,
  curr: MessageLike,
): number {
  const grouped = shouldGroup(prev, curr);
  if (curr.deletedAt) return grouped ? 28 : 48;
  return grouped ? 28 : 64;
}

/**
 * Total estimated pixel height of the first `prependedCount` items in `messages`.
 * Used to shift scrollTop after older messages are prepended, keeping the
 * viewport anchored to the same visual position.
 */
export function computePrependShift(
  messages: MessageLike[],
  prependedCount: number,
): number {
  let shift = 0;
  for (let i = 0; i < prependedCount; i++) {
    const prev = i > 0 ? messages[i - 1] : undefined;
    shift += estimateMessageHeight(prev, messages[i]);
  }
  return shift;
}

/**
 * Compute how much to adjust scrollTop after the virtualizer re-measures
 * prepended items.  Compares the anchor item's measured DOM position to the
 * estimated offset used for the initial shift.  Returns the delta to add to
 * scrollTop, or 0 if the difference is within a 1px dead-zone.
 */
export function computeScrollCorrection(
  anchorRect: { top: number },
  containerRect: { top: number },
  scrollTop: number,
  estimatedOffset: number,
): number {
  const measuredOffset = anchorRect.top - containerRect.top + scrollTop;
  const delta = measuredOffset - estimatedOffset;
  return Math.abs(delta) > 1 ? delta : 0;
}

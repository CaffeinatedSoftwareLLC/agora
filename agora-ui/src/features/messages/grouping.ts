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

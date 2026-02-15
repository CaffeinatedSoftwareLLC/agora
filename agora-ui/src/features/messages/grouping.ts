export const GROUP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function shouldGroup(
  prev: { authorId: string; createdAt: string; deletedAt?: string } | undefined,
  curr: { authorId: string; createdAt: string; deletedAt?: string },
): boolean {
  if (!prev) return false;
  if (prev.deletedAt || curr.deletedAt) return false;
  if (prev.authorId !== curr.authorId) return false;
  const diff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return diff < GROUP_THRESHOLD_MS;
}

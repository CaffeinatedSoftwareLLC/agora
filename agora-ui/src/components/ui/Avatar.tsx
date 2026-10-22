/** White initials keep at least 4.5:1 contrast on every swatch in either theme. */
export const AVATAR_COLORS = [
  '#1d4ed8', '#4338ca', '#6d28d9', '#7e22ce', '#a21caf', '#be185d', '#be123c', '#b91c1c',
  '#c2410c', '#b45309', '#a16207', '#4d7c0f', '#15803d', '#0f766e', '#0e7490', '#475569',
] as const;

export function avatarColor(userId: string): string {
  let hash = 2166136261;
  for (const character of userId.trim()) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length];
}

export function Avatar({ userId, username, avatarUrl, className = 'h-10 w-10 text-sm' }: {
  userId?: string | null; username?: string | null; avatarUrl?: string | null; className?: string;
}) {
  if (avatarUrl) return <img src={avatarUrl} alt={username || '?'} className={`shrink-0 rounded-full object-cover ${className}`} />;
  return <span role="img" aria-label={`${username || 'Unknown'} avatar`} data-avatar-user={userId || undefined}
    className={`flex shrink-0 items-center justify-center rounded-full font-bold ${className}`}
    style={{ backgroundColor: avatarColor(userId?.trim() || username || '?'), color: '#fff' }}>
    {Array.from(username || '?')[0].toUpperCase()}
  </span>;
}

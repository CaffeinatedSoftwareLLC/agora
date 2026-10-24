import { useContext } from 'react';
import { usePalette } from '../../theme';
import { avatarColor, AvatarColorsContext } from './avatarColors';

export function Avatar({ userId, username, avatarUrl, className = 'h-10 w-10 text-sm' }: {
  userId?: string | null; username?: string | null; avatarUrl?: string | null; className?: string;
}) {
  const colors = useContext(AvatarColorsContext);
  const palette = usePalette();
  const identity = userId?.trim() || username || '?';
  if (avatarUrl) return <img src={avatarUrl} alt={username || '?'} className={`shrink-0 rounded-full object-cover ${className}`} />;
  return <span role="img" aria-label={`${username || 'Unknown'} avatar`} data-avatar-user={userId || undefined}
    className={`flex shrink-0 items-center justify-center rounded-full font-bold ${className}`}
    style={{ backgroundColor: colors.get(identity) ?? avatarColor(identity), color: '#fff',
      boxShadow: `inset 0 0 0 2px ${palette.text}` }}>
    {Array.from(username || '?')[0].toUpperCase()}
  </span>;
}

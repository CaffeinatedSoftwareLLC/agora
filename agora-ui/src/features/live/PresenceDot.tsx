import { usePresenceStore } from '../../stores/presenceStore';

interface PresenceDotProps {
  userId: string;
  size?: 'sm' | 'md';
}

const statusColors = {
  online: 'bg-online',
  idle: 'bg-warn',
  offline: 'bg-text-dim',
} as const;

const sizes = {
  sm: 'w-2 h-2',
  md: 'w-3 h-3',
} as const;

export function PresenceDot({ userId, size = 'sm' }: PresenceDotProps) {
  const status = usePresenceStore((s) => s.getStatus(userId));

  return (
    <span
      className={`${sizes[size]} ${statusColors[status]} rounded-full inline-block border-2 border-surface`}
      title={status}
    />
  );
}

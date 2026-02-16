import { useAuthStore } from '../../stores/authStore';
import { ConnectionIndicator } from './ConnectionIndicator';
import { PresenceDot } from '../live/PresenceDot';

export function UserPanel() {
  const user = useAuthStore(s => s.user);
  if (!user) return null;

  return (
    <div className="p-3 border-t border-border flex items-center gap-3">
      <div className="relative shrink-0">
        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-sm font-bold text-white">
          {user.username[0].toUpperCase()}
        </div>
        <div className="absolute -bottom-0.5 -right-0.5">
          <PresenceDot userId={user.id} size="sm" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-text truncate">{user.username}</div>
      </div>
      <ConnectionIndicator />
    </div>
  );
}

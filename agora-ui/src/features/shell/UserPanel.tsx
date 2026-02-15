import { useAuthStore } from '../../stores/authStore';
import { ConnectionIndicator } from './ConnectionIndicator';

export function UserPanel() {
  const user = useAuthStore(s => s.user);
  if (!user) return null;

  return (
    <div className="p-3 border-t border-border flex items-center gap-3">
      <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-sm font-bold text-white shrink-0">
        {user.username[0].toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-text truncate">{user.username}</div>
      </div>
      <ConnectionIndicator />
    </div>
  );
}

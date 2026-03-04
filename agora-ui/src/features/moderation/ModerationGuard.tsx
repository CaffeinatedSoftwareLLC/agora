import type { ReactNode } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useServerAccess } from '../../hooks/useServerAccess';

export function ModerationGuard({ children }: { children: ReactNode }) {
  const instanceServerId = useServerStore(s => s.instanceServerId);
  const { hasModerationAccess, loading } = useServerAccess(instanceServerId);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <p className="text-text-muted text-lg">Loading...</p>
      </div>
    );
  }

  if (!hasModerationAccess) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <p className="text-text-muted text-lg">
          Access denied. You don't have moderation permissions.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

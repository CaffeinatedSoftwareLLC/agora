import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';

export function AdminGuard({ children }: { children: ReactNode }) {
  const { token, user } = useAuthStore();

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  if (!user?.isInstanceAdmin) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-text-muted text-lg">
          Access denied. You don't have admin permissions.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';

export function AuthGuard({ children }: { children: ReactNode }) {
  const { token, status } = useAuthStore();

  if (!token && status !== 'authenticated') {
    return <Navigate to="/login" replace />;
  }

  if (status === 'pending') {
    return <Navigate to="/pending" replace />;
  }

  return <>{children}</>;
}

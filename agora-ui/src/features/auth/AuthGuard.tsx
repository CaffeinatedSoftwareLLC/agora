import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';

export function AuthGuard({ children }: { children: ReactNode }) {
  const { token, status } = useAuthStore();

  // Pending check MUST come before the token check — pending users have no token
  if (status === 'pending') {
    return <Navigate to="/pending" replace />;
  }

  if (!token && status !== 'authenticated') {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

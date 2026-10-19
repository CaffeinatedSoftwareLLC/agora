import { useEffect, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { PageSpinner } from '../../components/ui/PageSpinner';

// Checked once per page load: the session cookie may have expired or been revoked
// while the tab was closed. Until the answer comes the remembered user is shown.
let sessionChecked = false;

export function AuthGuard({ children }: { children: ReactNode }) {
  const status = useAuthStore(s => s.status);
  const verifySession = useAuthStore(s => s.verifySession);

  useEffect(() => {
    if (status === 'authenticated' && !sessionChecked) {
      sessionChecked = true;
      void verifySession();
    }
  }, [status, verifySession]);

  // No user remembered in this browser; the server is being asked about the cookie
  if (status === 'checking') {
    return <PageSpinner />;
  }

  if (status === 'pending') {
    return <Navigate to="/pending" replace />;
  }

  if (status !== 'authenticated') {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

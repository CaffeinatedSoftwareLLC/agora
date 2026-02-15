import type { ReactNode } from 'react';
import { useInstance } from '../../hooks/useInstance';

export function InstanceGuard({ children }: { children: ReactNode }) {
  const { data, loading, error } = useInstance();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <svg className="animate-spin h-8 w-8 text-text-muted" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <h1 className="text-xl text-danger mb-2">Connection Error</h1>
          <p className="text-text-muted">Could not reach the server. Please try again later.</p>
          <p className="text-text-dim text-sm mt-2">{error}</p>
        </div>
      </div>
    );
  }

  if (!data?.initialized) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <h1 className="text-xl text-text-muted mb-2">Not Set Up</h1>
          <p className="text-text-dim">This instance has not been set up yet.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

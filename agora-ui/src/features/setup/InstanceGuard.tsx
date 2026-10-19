import { type ReactNode, useState, useCallback } from 'react';
import { useInstance } from '../../hooks/useInstance';
import { SetupWizard } from './SetupWizard';
import { PageSpinner } from '../../components/ui/PageSpinner';

export function InstanceGuard({ children }: { children: ReactNode }) {
  const { data, loading, error } = useInstance();
  const [setupDone, setSetupDone] = useState(false);

  const handleSetupComplete = useCallback(() => {
    setSetupDone(true);
  }, []);

  if (loading) {
    return <PageSpinner />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <h1 className="text-xl text-danger mb-2">Connection Error</h1>
          <p className="text-text-muted">Could not reach the server. Please try again later.</p>
          <p className="text-danger text-sm mt-2">{error}</p>
        </div>
      </div>
    );
  }

  if (!data?.initialized && !setupDone) {
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  return <>{children}</>;
}

import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import type { InstanceStatus } from '../lib/contracts/instance';

export function useInstance() {
  const [data, setData] = useState<InstanceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<InstanceStatus>('/instance/status')
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}

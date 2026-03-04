import { useState, useEffect } from 'react';
import { serverApi } from '../lib/api';

interface ServerAccessState {
  hasModerationAccess: boolean;
  hasServerAdminAccess: boolean;
  isInstanceAdmin: boolean;
  loading: boolean;
}

export function useServerAccess(serverId: string | null): ServerAccessState {
  const [state, setState] = useState<ServerAccessState>({
    hasModerationAccess: false,
    hasServerAdminAccess: false,
    isInstanceAdmin: false,
    loading: true,
  });

  useEffect(() => {
    if (!serverId) {
      setState({ hasModerationAccess: false, hasServerAdminAccess: false, isInstanceAdmin: false, loading: false });
      return;
    }

    let cancelled = false;
    setState(prev => ({ ...prev, loading: true }));

    serverApi.getAccess(serverId).then(data => {
      if (cancelled) return;
      setState({
        hasModerationAccess: data.hasModerationAccess,
        hasServerAdminAccess: data.hasServerAdminAccess,
        isInstanceAdmin: data.isInstanceAdmin,
        loading: false,
      });
    }).catch(() => {
      if (cancelled) return;
      // Fail closed — no access on error
      setState({ hasModerationAccess: false, hasServerAdminAccess: false, isInstanceAdmin: false, loading: false });
    });

    return () => { cancelled = true; };
  }, [serverId]);

  return state;
}

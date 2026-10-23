import { useState, useEffect } from 'react';
import { serverApi } from '../lib/api';

interface ServerAccessState {
  hasModerationAccess: boolean;
  hasServerAdminAccess: boolean;
  isInstanceAdmin: boolean;
  /** ManageChannels (or Administrator): may create channels */
  canManageChannels: boolean;
  /** CreateInvites (or Administrator): may mint invite links */
  canCreateInvites: boolean;
  loading: boolean;
}

const Administrator = 1n << 0n;
const ManageChannels = 1n << 2n;
const CreateInvites = 1n << 7n;

const NO_ACCESS = {
  hasModerationAccess: false,
  hasServerAdminAccess: false,
  isInstanceAdmin: false,
  canManageChannels: false,
  canCreateInvites: false,
};

/** Whether a server-level permission string grants `bit` (Administrator grants every bit). */
function holds(permissions: string, bit: bigint): boolean {
  try {
    const perms = BigInt(permissions);
    return (perms & (bit | Administrator)) !== 0n;
  } catch {
    return false;
  }
}

export function useServerAccess(serverId: string | null): ServerAccessState {
  const [state, setState] = useState<ServerAccessState>({ ...NO_ACCESS, loading: true });

  useEffect(() => {
    if (!serverId) {
      setState({ ...NO_ACCESS, loading: false });
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
        canManageChannels: holds(data.permissions, ManageChannels),
        canCreateInvites: holds(data.permissions, CreateInvites),
        loading: false,
      });
    }).catch(() => {
      if (cancelled) return;
      // Fail closed — no access on error
      setState({ ...NO_ACCESS, loading: false });
    });

    return () => { cancelled = true; };
  }, [serverId]);

  return state;
}

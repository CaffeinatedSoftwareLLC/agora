import { useState, useEffect, useMemo } from 'react';
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

type Access = Omit<ServerAccessState, 'loading'>;

export function useServerAccess(serverId: string | null): ServerAccessState {
  // Keyed by server: a switch reads as "loading" until its own answer arrives, with no setState in the effect.
  const [loaded, setLoaded] = useState<{ serverId: string; access: Access } | null>(null);

  useEffect(() => {
    if (!serverId) return;

    let cancelled = false;
    serverApi.getAccess(serverId).then(data => {
      if (cancelled) return;
      setLoaded({ serverId, access: {
        hasModerationAccess: data.hasModerationAccess,
        hasServerAdminAccess: data.hasServerAdminAccess,
        isInstanceAdmin: data.isInstanceAdmin,
        canManageChannels: holds(data.permissions, ManageChannels),
        canCreateInvites: holds(data.permissions, CreateInvites),
      } });
    }).catch(() => {
      if (cancelled) return;
      // Fail closed — no access on error
      setLoaded({ serverId, access: NO_ACCESS });
    });

    return () => { cancelled = true; };
  }, [serverId]);

  return useMemo<ServerAccessState>(() => {
    if (!serverId) return { ...NO_ACCESS, loading: false };
    if (loaded && loaded.serverId === serverId) return { ...loaded.access, loading: false };
    return { ...NO_ACCESS, loading: true };
  }, [serverId, loaded]);
}

import { useState, useEffect } from 'react';
import { voiceApi, type VoicePermissions } from '../../lib/api';

const NO_PERMS: VoicePermissions = {
  canMuteMembers: false,
  canDeafenMembers: false,
  canMoveMembers: false,
};

export function useVoicePermissions(channelId: string): VoicePermissions {
  const [perms, setPerms] = useState<VoicePermissions>(NO_PERMS);

  useEffect(() => {
    let cancelled = false;
    voiceApi.getPermissions(channelId).then(
      (data) => { if (!cancelled) setPerms(data); },
      () => { if (!cancelled) setPerms(NO_PERMS); },
    );
    return () => { cancelled = true; };
  }, [channelId]);

  return perms;
}

import { useState, useEffect, useRef } from 'react';
import { usePalette } from '../../theme';
import { voiceApi, type VoicePermissions } from '../../lib/api';

interface VoiceParticipantContextMenuProps {
  x: number;
  y: number;
  channelId: string;
  targetUserId: string;
  targetName: string;
  permissions: VoicePermissions;
  isSelf: boolean;
  targetCanPublish: boolean;
  targetCanSubscribe: boolean;
  onClose: () => void;
  onActionComplete: () => void;
}

export function VoiceParticipantContextMenu({
  x,
  y,
  channelId,
  targetUserId,
  permissions,
  isSelf,
  targetCanPublish,
  targetCanSubscribe,
  onClose,
  onActionComplete,
}: VoiceParticipantContextMenuProps) {
  const P = usePalette();
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const hasAnyPermission =
    permissions.canMuteMembers || permissions.canDeafenMembers || permissions.canMoveMembers;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  if (isSelf || !hasAnyPermission) return null;

  async function handleAction(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      onActionComplete();
      onClose();
    } catch {
      setError('Action failed');
    }
  }

  const buttonStyle = {
    background: 'none',
    border: 'none',
    color: P.text,
    padding: '6px 12px',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left' as const,
    fontSize: '13px',
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: x,
        top: y,
        background: P.surface,
        border: `1px solid ${P.border}`,
        borderRadius: '6px',
        padding: '4px 0',
        zIndex: 1000,
        minWidth: '140px',
      }}
    >
      {permissions.canMuteMembers && (
        <button
          style={buttonStyle}
          onClick={() =>
            handleAction(() =>
              targetCanPublish
                ? voiceApi.mute(channelId, targetUserId)
                : voiceApi.unmute(channelId, targetUserId),
            )
          }
        >
          {targetCanPublish ? 'Mute' : 'Unmute'}
        </button>
      )}

      {permissions.canDeafenMembers && (
        <button
          style={buttonStyle}
          onClick={() =>
            handleAction(() =>
              targetCanSubscribe
                ? voiceApi.deafen(channelId, targetUserId)
                : voiceApi.undeafen(channelId, targetUserId),
            )
          }
        >
          {targetCanSubscribe ? 'Deafen' : 'Undeafen'}
        </button>
      )}

      {permissions.canMoveMembers && (
        <>
          <div style={{ borderTop: `1px solid ${P.border}`, margin: '4px 0' }} />
          <button
            style={{ ...buttonStyle, color: P.danger, fontWeight: 600 }}
            onClick={() => handleAction(() => voiceApi.kick(channelId, targetUserId))}
          >
            ✕ Disconnect
          </button>
        </>
      )}

      {error && (
        <div style={{ color: P.danger, fontSize: '11px', padding: '4px 12px' }}>
          {error}
        </div>
      )}
    </div>
  );
}

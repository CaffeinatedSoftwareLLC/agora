import { useEffect } from 'react';
import { useMemberStore } from '../../stores/memberStore';
import { useServerStore } from '../../stores/serverStore';
import { PresenceDot } from '../live/PresenceDot';

export function MembersSidebar() {
  const instanceServerId = useServerStore(s => s.instanceServerId);
  const byServer = useMemberStore(s => s.byServer);
  const loadMembers = useMemberStore(s => s.loadMembers);

  useEffect(() => {
    if (instanceServerId) {
      loadMembers(instanceServerId);
    }
  }, [instanceServerId, loadMembers]);

  if (!instanceServerId) return null;

  const members = byServer.get(instanceServerId) || [];

  return (
    <div className="w-60 bg-surface flex flex-col border-l border-border shrink-0">
      <div className="h-12 px-4 flex items-center border-b border-border">
        <span className="font-semibold text-text text-sm">Members — {members.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {members.map((member) => (
          <div
            key={member.id}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-sm text-text-muted rounded-md mx-1"
            style={{ width: 'calc(100% - 8px)' }}
          >
            <div className="relative shrink-0">
              <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-xs font-bold text-white">
                {member.username[0].toUpperCase()}
              </div>
              <div className="absolute -bottom-0.5 -right-0.5">
                <PresenceDot userId={member.id} size="sm" />
              </div>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="truncate">{member.username}</span>
              {member.roles.length > 0 && (
                <span className="text-xs text-text-dim truncate">
                  {member.roles.map(r => r.name).join(', ')}
                </span>
              )}
            </div>
          </div>
        ))}
        {members.length === 0 && (
          <div className="px-4 py-8 text-center text-text-dim text-sm">
            No members
          </div>
        )}
      </div>
    </div>
  );
}

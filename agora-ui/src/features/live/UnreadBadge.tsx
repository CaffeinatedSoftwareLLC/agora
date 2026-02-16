import { useUnreadStore } from '../../stores/unreadStore';

interface UnreadBadgeProps {
  channelId: string;
}

export function UnreadBadge({ channelId }: UnreadBadgeProps) {
  const unread = useUnreadStore((s) => s.getUnread(channelId));

  if (!unread) return null;

  if (unread.mentionCount > 0) {
    return (
      <span className="ml-auto shrink-0 bg-danger text-white text-xs font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
        {unread.mentionCount}
      </span>
    );
  }

  if (unread.unreadCount > 0) {
    return (
      <span className="ml-auto shrink-0 w-2 h-2 bg-text-muted rounded-full" />
    );
  }

  return null;
}

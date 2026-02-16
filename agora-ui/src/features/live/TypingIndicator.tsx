import { useMemo } from 'react';
import { useTypingStore } from '../../stores/typingStore';

interface TypingIndicatorProps {
  channelId: string;
}

function formatTypingText(usernames: string[]): string {
  if (usernames.length === 0) return '';
  if (usernames.length === 1) return `${usernames[0]} is typing`;
  if (usernames.length === 2) return `${usernames[0]} and ${usernames[1]} are typing`;
  return `${usernames[0]}, ${usernames[1]}, and ${usernames.length - 2} other${usernames.length - 2 > 1 ? 's' : ''} are typing`;
}

export function TypingIndicator({ channelId }: TypingIndicatorProps) {
  const channelTyping = useTypingStore((s) => s.byChannel.get(channelId));
  const typingUsers = useMemo(
    () => (channelTyping ? Array.from(channelTyping.values()).map((e) => e.username) : []),
    [channelTyping],
  );

  return (
    <div className="h-6 px-4 flex items-center text-xs text-text-muted shrink-0">
      {typingUsers.length > 0 && (
        <span className="flex items-center gap-1">
          <span className="inline-flex gap-0.5">
            <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce [animation-delay:300ms]" />
          </span>
          <span className="ml-1">{formatTypingText(typingUsers)}</span>
        </span>
      )}
    </div>
  );
}

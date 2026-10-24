import { useMemo, type ReactNode } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useAgentPresenceStore } from '../../stores/agentPresenceStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';
import { useMessageStore } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { AvatarColorsContext, resolveAvatarColors } from './avatarColors';

/** One palette for feed, replies, roster, autocomplete and the signed-in user. */
export function ChannelAvatars({ children }: { children: ReactNode }) {
  const channelId = useChannelStore(s => s.activeChannelId);
  const agents = useMemberStore(s => channelId ? s.channelAgentIds.get(channelId) : undefined);
  const present = useAgentPresenceStore(s => channelId ? s.byChannel.get(channelId) : undefined);
  const messages = useMessageStore(s => channelId ? s.byChannel.get(channelId) : undefined);
  const replies = useThreadStore(s => s.repliesByThread);
  const summaries = useThreadStore(s => channelId ? s.activeThreads.get(channelId) : undefined);
  const userId = useAuthStore(s => s.user?.id);
  const colors = useMemo(() => {
    const ids = new Set<string>();
    if (userId) ids.add(userId);
    // Never include the whole server roster: unrelated members can fill every slot.
    for (const id of agents ?? []) ids.add(id);
    for (const id of present?.keys() ?? []) ids.add(id);
    for (const message of messages ?? []) if (message.authorId) ids.add(message.authorId);
    for (const thread of replies.values()) for (const reply of thread) {
      if (reply.channelId === channelId && reply.authorId) ids.add(reply.authorId);
    }
    for (const summary of summaries ?? []) {
      if (summary.authorId) ids.add(summary.authorId);
      for (const reply of summary.previewReplies) if (reply.authorId) ids.add(reply.authorId);
    }
    return resolveAvatarColors(ids);
  }, [channelId, agents, present, messages, replies, summaries, userId]);
  return <AvatarColorsContext.Provider value={colors}>{children}</AvatarColorsContext.Provider>;
}

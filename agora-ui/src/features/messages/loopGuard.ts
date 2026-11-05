import type { Message } from '../../stores/messageStore';
import type { Channel } from '../../lib/contracts/server';

// Loop guard helpers shared by the notice (LoopGuardNotice) and the header badge (LoopGuardBadge).

/** What a loop_guard notice is about. Older notices have no systemData: read the text. */
export function loopGuardScope(message: Pick<Message, 'content' | 'systemData'>): { scope: 'channel' | 'thread'; threadId: string | null; limit: number | null } {
  const data = message.systemData ?? {};
  const fromText = /in this thread/.test(message.content ?? '') ? 'thread' : 'channel';
  const scope = data.scope === 'thread' || data.scope === 'channel' ? data.scope : fromText;
  const threadId = typeof data.threadId === 'string' ? data.threadId : null;
  const limit = typeof data.limit === 'number' ? data.limit : Number(/^Loop guard: (\d+)/.exec(message.content ?? '')?.[1]) || null;
  return { scope, threadId, limit };
}

/** The channel and thread loop guard limits in words; 0 means off. */
export function loopGuardSummary(channel: Pick<Channel, 'maxBotHops' | 'maxThreadBotHops'>): string {
  const top = channel.maxBotHops ?? 4;
  const thread = channel.maxThreadBotHops ?? 0;
  return `Loop guard: ${top > 0 ? `pauses after ${top} bot messages in a row` : 'off in the channel'}; `
    + `${thread > 0 ? `threads pause after ${thread} bot replies in a row` : 'off in threads'}.`;
}


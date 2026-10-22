import type { Message } from '../../stores/messageStore';
import { isPlainNotice, type NoticeRun } from './systemNotices';

export interface MessageRun extends NoticeRun {
  kind: 'agents';
  names: string[];
  noticeCount: number;
  /** Existing notice/bot drawer keys that were absorbed by this unified section. */
  aliases: string[];
}

const RESOLVED_CARDS: Record<string, readonly string[]> = {
  agent_tool_approval: ['once', 'always', 'approved', 'denied', 'expired'],
  agent_run_approval: ['approved', 'denied', 'expired'],
  agent_handoff: ['accepted', 'declined', 'expired', 'cancelled'],
  agent_permission_relay: ['allow', 'deny'],
  runtime_approval: ['approved', 'denied'],
  runtime_result: ['succeeded', 'failed', 'timeout', 'killed', 'error'],
};

// Interactive cards, files, tombstones and work still streaming stay directly visible.
export function isFoldableAgentMessage(message: Message): boolean {
  return message.authorBot === true && !message.systemEvent && !message.deletedAt
    && !message.pending && !message.failed && !message.streaming
    && !message.artifact && !message.attachments?.length;
}

export function isFoldableAgentUpdate(message: Message): boolean {
  if (message.deletedAt || message.pending || message.failed || message.streaming
    || message.artifact || message.attachments?.length) return false;
  if (isPlainNotice(message) || isFoldableAgentMessage(message)) return true;
  const status = message.systemData?.status;
  return typeof status === 'string' && !!RESOLVED_CARDS[message.systemEvent ?? '']?.includes(status);
}

export function computeMessageRuns(messages: readonly Message[]): (MessageRun | null)[] {
  const runs: (MessageRun | null)[] = new Array(messages.length).fill(null);
  let i = 0;
  while (i < messages.length) {
    if (!isFoldableAgentUpdate(messages[i])) { i++; continue; }
    let end = i + 1;
    while (end < messages.length && isFoldableAgentUpdate(messages[end])) end++;
    if (end - i >= 2) {
      const section = messages.slice(i, end);
      const names = [...new Set(section.filter(message => message.authorBot).map(message => message.authorUsername).filter(Boolean))];
      const noticeCount = section.filter(message => !!message.systemEvent).length;
      const key = isPlainNotice(messages[i]) ? messages[i].id : `agents:${messages[i].id}`;
      const aliases = new Set([key]);
      for (let row = i; row < end; row++) {
        if (isPlainNotice(messages[row]) && (row === i || !isPlainNotice(messages[row - 1]))) aliases.add(messages[row].id);
        if (isFoldableAgentMessage(messages[row]) && (row === i || !isFoldableAgentMessage(messages[row - 1]))) aliases.add(`agents:${messages[row].id}`);
      }
      for (let row = i; row < end; row++) runs[row] = { key, size: end - i, position: row - i, kind: 'agents', names, noticeCount, aliases: [...aliases] };
    }
    i = end;
  }
  return runs;
}

export interface RunRow { id: string; run: MessageRun | null }

/** Invalidate measured heights on toggle AND when a live run forms or breaks. */
export function resizeChangedRunRows(
  list: { resizeItem: (index: number, size: number) => void },
  previous: readonly RunRow[], next: readonly RunRow[], changedKeys: ReadonlySet<string>,
  estimate: (index: number) => number,
): void {
  const previousById = new Map(previous.map(row => [row.id, row.run]));
  next.forEach(({ id, run }, index) => {
    const before = previousById.get(id);
    if (before?.key !== run?.key || before?.position !== run?.position
      || (!!before && before.position === before.size - 1) !== (!!run && run.position === run.size - 1)
      || before?.aliases.join(',') !== run?.aliases.join(',')
      || (run && run.aliases.some(key => changedKeys.has(key)))) list.resizeItem(index, estimate(index));
  });
}

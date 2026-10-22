import type { Message } from '../../stores/messageStore';
import { computeNoticeRuns, type NoticeRun } from './systemNotices';

export interface MessageRun extends NoticeRun {
  kind: 'notices' | 'agents';
  names?: string[];
}

// Interactive cards, files, tombstones and work still streaming stay directly visible.
export function isFoldableAgentMessage(message: Message): boolean {
  return message.authorBot === true && !message.systemEvent && !message.deletedAt
    && !message.pending && !message.failed && !message.streaming
    && !message.artifact && !message.attachments?.length;
}

export function computeMessageRuns(messages: readonly Message[]): (MessageRun | null)[] {
  const runs = computeNoticeRuns(messages).map(run => run ? { ...run, kind: 'notices' as const } : null) as (MessageRun | null)[];
  let i = 0;
  while (i < messages.length) {
    if (!isFoldableAgentMessage(messages[i])) { i++; continue; }
    let end = i + 1;
    while (end < messages.length && isFoldableAgentMessage(messages[end])) end++;
    if (end - i >= 3) {
      const names = [...new Set(messages.slice(i, end).map(message => message.authorUsername))];
      const key = `agents:${messages[i].id}`;
      for (let row = i; row < end; row++) runs[row] = { key, size: end - i, position: row - i, kind: 'agents', names };
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
      || (run && changedKeys.has(run.key))) list.resizeItem(index, estimate(index));
  });
}

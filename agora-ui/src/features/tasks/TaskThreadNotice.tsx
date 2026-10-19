import type { Message } from '../../stores/messageStore';
import { useUIStore } from '../../stores/uiStore';

/**
 * The channel line that opens a task card's or a subtask's thread (docs/task-board.md). The
 * agent works in that thread, so the line is mostly a way into it, and to the board.
 */
export function TaskThreadNotice({ message, channelId }: { message: Message; channelId: string }) {
  const openThread = useUIStore(s => s.openThreadView);
  const openAux = useUIStore(s => s.openAux);
  const replies = message.replyCount ?? 0;
  const task = message.systemEvent === 'task_card';
  return (
    <div className="flex items-start gap-3 px-4 py-1">
      <div className="flex w-10 shrink-0 justify-center pt-[3px]">
        <svg className="h-4 w-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {task
            ? <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 12l3 3 5-6" /></>
            : <path d="M6 3v12a3 3 0 003 3h9M15 15l3 3-3 3" />}
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-5 text-text [overflow-wrap:anywhere]">{message.content}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="min-h-11 rounded-lg px-2 text-[13px] text-accent hover:bg-surface-hover md:min-h-8"
            onClick={() => openThread(channelId, message.id)}>
            {replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'Open thread'}
          </button>
          {task && (
            <button type="button" className="min-h-11 rounded-lg px-2 text-[13px] text-text-muted hover:bg-surface-hover md:min-h-8"
              onClick={() => openAux('tasks')}>
              Task board
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

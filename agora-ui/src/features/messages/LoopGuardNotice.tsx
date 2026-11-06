import { useState } from 'react';
import type { Message } from '../../stores/messageStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMessageStore } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { useCanManageBots } from '../../hooks/useCanManageBots';
import { botApi, ApiError } from '../../lib/api';
import { NoticeText } from './SystemNoticeRun';
import { loopGuardScope, loopGuardSettled } from './loopGuard';

const MAX_LIMIT = 1000;
const DEFAULT_CHANNEL_LIMIT = 4;

type Busy = 'continue' | 'raise' | 'off' | null;

/**
 * The loop guard's system message, with Continue / Raise limit / Turn off for users who
 * may change the guard (ManageBots, #23). Everyone else sees only that it fired.
 */
export function LoopGuardNotice({ message, channelId }: { message: Message; channelId?: string }) {
  const id = channelId ?? message.channelId;
  const channel = useChannelStore(s => s.channels.get(id));
  const canManage = useCanManageBots(channel?.serverId);
  const { scope, threadId, limit: firedAt } = loopGuardScope(message);
  const [busy, setBusy] = useState<Busy>(null);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  // The limit was saved but the resume failed: a retry only resumes, it doesn't raise again
  const [configured, setConfigured] = useState(false);
  const settledInChannel = useMessageStore(s => scope === 'channel' && loopGuardSettled(s.byChannel.get(id), message.id));
  const settledInThread = useThreadStore(s => scope === 'thread' && !!threadId && loopGuardSettled(s.repliesByThread.get(threadId), message.id));
  const settled = settledInChannel || settledInThread;

  const current = scope === 'thread' ? channel?.maxThreadBotHops ?? 0 : channel?.maxBotHops ?? DEFAULT_CHANNEL_LIMIT;
  const raiseTo = Math.min(MAX_LIMIT, Math.max(current, firedAt ?? 0, 1) * 2);
  // A thread notice from before #23 has no thread id: the guard can be changed, not resumed
  const canResume = scope === 'channel' || !!threadId;
  const field = scope === 'thread' ? 'maxThreadBotHops' : 'maxBotHops';

  async function act(kind: Exclude<Busy, null>) {
    setBusy(kind);
    setError('');
    let saved = false;
    try {
      if (kind !== 'continue') {
        const value = kind === 'raise' ? raiseTo : 0;
        const config = await botApi.updateChannelBotConfig(id, { [field]: value });
        useChannelStore.getState().patchChannel(id, { maxBotHops: config.maxBotHops, maxThreadBotHops: config.maxThreadBotHops });
        saved = true;
        setConfigured(true);
      }
      if (canResume) await botApi.resumeLoopGuard(id, scope === 'thread' ? threadId ?? undefined : undefined);
      setDone(kind === 'continue' ? 'Agents may continue.'
        : kind === 'raise' ? `Limit raised to ${raiseTo}.${canResume ? ' Agents may continue.' : ''}`
        : `Loop guard off ${scope === 'thread' ? 'for threads in this channel' : 'in this channel'}.${canResume ? ' Agents may continue.' : ''}`);
    } catch (err) {
      const reason = err instanceof ApiError ? (err.status === 403 ? 'You no longer have permission to change the loop guard.' : err.code) : 'Could not update the loop guard';
      setError(saved ? `The new limit is saved, but the agents were not told to continue: ${reason}` : reason);
    } finally {
      setBusy(null);
    }
  }

  const button = 'min-h-11 md:min-h-8 px-3 rounded-lg border border-border bg-surface text-xs font-medium text-text hover:bg-surface-hover disabled:opacity-50';
  return (
    <div className="flex flex-col items-center gap-2 py-2 px-4" data-loop-guard={scope}>
      <div className="flex items-start justify-center gap-2">
        <svg className="mt-[3px] h-3.5 w-3.5 shrink-0 text-warn" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="M10 9v6M14 9v6" />
        </svg>
        <NoticeText text={message.content} className="text-[13px] leading-5 text-text-muted" />
      </div>
      {canManage && !done && !settled && configured && canResume && (
        <div role="group" aria-label="Loop guard actions" className="flex flex-wrap justify-center gap-2">
          <button type="button" className={button} disabled={busy !== null} onClick={() => act('continue')}
            title="The new limit is saved; tell the agents they may carry on">
            {busy === 'continue' ? 'Continuing…' : 'Continue'}
          </button>
        </div>
      )}
      {canManage && !done && !settled && !configured && (
        <div role="group" aria-label="Loop guard actions" className="flex flex-wrap justify-center gap-2">
          {canResume && (
            <button type="button" className={button} disabled={busy !== null} onClick={() => act('continue')}
              title="Reset the counter and tell the agents they may carry on">
              {busy === 'continue' ? 'Continuing…' : 'Continue'}
            </button>
          )}
          {raiseTo > current && (
            <button type="button" className={button} disabled={busy !== null} onClick={() => act('raise')}
              title={`Allow ${raiseTo} bot ${scope === 'thread' ? 'replies' : 'messages'} in a row${canResume ? ', then continue' : ''}`}>
              {busy === 'raise' ? 'Raising…' : `Raise limit to ${raiseTo}`}
            </button>
          )}
          <button type="button" className={button} disabled={busy !== null} onClick={() => act('off')}
            title={scope === 'thread' ? 'Turn the thread guard off for every thread in this channel' : 'Turn the channel guard off'}>
            {busy === 'off' ? 'Turning off…' : scope === 'thread' ? 'Turn off for threads here' : 'Turn off in this channel'}
          </button>
        </div>
      )}
      {done && <p className="text-xs text-text-muted" role="status">{done}</p>}
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    </div>
  );
}

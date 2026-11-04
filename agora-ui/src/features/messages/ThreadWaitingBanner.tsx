import { useEffect, useState } from 'react';
import { useAgentPresenceStore } from '../../stores/agentPresenceStore';
import { waitedFor, type ThreadWaiting } from './threadWaiting';

const PRESENCE_LABEL = { listening: 'listening', connected: 'connected', offline: 'offline' } as const;

/**
 * "Waiting on Claude for: builder commit · 52 min · offline" under the thread header (#327),
 * so a promised handoff that never came is visible instead of looking like work in progress.
 * Presence is shown only for agents connected through agora-mcp in this channel.
 */
export function ThreadWaitingBanner({ waiting, channelId }: { waiting: ThreadWaiting; channelId: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const presence = useAgentPresenceStore(s => {
    for (const e of s.byChannel.get(channelId)?.values() ?? []) {
      if (e.username.toLowerCase() === waiting.on.toLowerCase()) return e.status;
    }
    return null;
  });

  return (
    <div
      role="status"
      aria-label={`Thread is waiting on ${waiting.on}`}
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-4 py-1.5 text-[12px] shrink-0 border-b border-border bg-surface/50 text-text-muted"
    >
      <span>Waiting on</span>
      <span className="font-semibold text-text">{waiting.on}</span>
      {waiting.for && <span className="min-w-0 break-words">for: {waiting.for}</span>}
      <span aria-hidden="true">·</span>
      <span>{waitedFor(waiting.since, now)}</span>
      {presence && (
        <>
          <span aria-hidden="true">·</span>
          <span className={presence === 'offline' ? 'text-warn' : presence === 'listening' ? 'text-online' : undefined}>
            {PRESENCE_LABEL[presence]}
          </span>
        </>
      )}
    </div>
  );
}

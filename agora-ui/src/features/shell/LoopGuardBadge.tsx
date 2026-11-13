import { Link } from 'react-router-dom';
import type { Channel } from '../../lib/contracts/server';
import { loopGuardSummary } from '../messages/loopGuard';
import { useCanManageBots } from '../../hooks/useCanManageBots';

/**
 * A small shield in the channel header while either loop guard is on (#23). The limits are
 * in its tooltip and accessible name; ManageBots users can click through to change them.
 */
export function LoopGuardBadge({ channel }: { channel: Channel }) {
  const canManage = useCanManageBots(channel.serverId);
  const top = channel.maxBotHops ?? 0;
  const thread = channel.maxThreadBotHops ?? 0;
  if (top <= 0 && thread <= 0) return null;

  const summary = loopGuardSummary(channel);
  const body = (
    <>
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" />
      </svg>
      <span aria-hidden="true">{top > 0 ? top : 'off'}{thread > 0 ? ` · ${thread}` : ''}</span>
    </>
  );
  const className = 'shrink-0 inline-flex items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-text-muted';
  if (!canManage) {
    return <span className={`${className} min-h-6`} title={summary} role="img" aria-label={summary}>{body}</span>;
  }
  return (
    <Link
      to="/settings/bots"
      className={`${className} min-h-11 md:min-h-7 hover:bg-surface-hover hover:text-text`}
      title={`${summary} Click to change.`}
      aria-label={`${summary} Change in bot settings.`}
    >
      {body}
    </Link>
  );
}

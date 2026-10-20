import { useEffect, useState } from 'react';
import { HANDOFF_STATUS, handoffStatus, type HandoffData, type ThreadOwnerInfo } from './handoffs';
import type { Message } from '../../stores/messageStore';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { MessageContent } from '../messages/MessageContent';

/**
 * An ownership handoff offer (#84, docs/agent-sessions.md "Handoffs"): one agent offers a
 * thread's task to another, which accepts or declines through agora-mcp. People see the state;
 * the owner and directors can cancel a pending offer (the server enforces who may).
 */

const ERRORS: Record<string, string> = {
  cannot_cancel: 'Only the agent that made the offer, the owner or a director can cancel it.',
  offer_accepted: 'It was already accepted.',
  offer_declined: 'It was already declined.',
  offer_expired: 'It already expired.',
  offer_cancelled: 'It was already cancelled.',
};

export function HandoffCard({ message }: { message: Message }) {
  const data = (message.systemData ?? {}) as HandoffData;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const status = handoffStatus(data, now);
  const badge = HANDOFF_STATUS[status];

  // Flip a pending card to expired when its time passes
  useEffect(() => {
    if (data.status !== 'pending' || !data.expiresAt) return;
    const left = Date.parse(data.expiresAt) - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(left + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [data.status, data.expiresAt]);

  async function cancel() {
    if (!data.offerId || !message.channelId) return;
    setBusy(true);
    setError('');
    try {
      // The card updates itself through the MessageUpdate the server sends
      await api.post(`/channels/${message.channelId}/handoffs/${data.offerId}`, { action: 'cancel' });
    } catch (err) {
      setError(err instanceof ApiError ? (ERRORS[err.code] ?? err.code) : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-4 my-2 rounded-lg border border-border bg-surface/60 px-4 py-3" data-testid="handoff-card">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <svg className="h-4 w-4 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 17L17 7" /><path d="M8 7h9v9" />
        </svg>
        <span className="text-sm font-semibold text-text">Handoff{data.from && data.to ? `: ${data.from} → ${data.to}` : ''}</span>
        {badge && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${badge.tone}`}>{badge.label}</span>}
      </div>
      {data.branch && data.headSha && (
        <p className="mb-1 font-mono text-xs text-text-muted break-all">
          {data.branch} @ {data.headSha.slice(0, 12)}{data.senderRunning ? ' (last committed head; turn in progress not included)' : ''}
        </p>
      )}
      <div className="text-sm text-text-muted"><MessageContent content={message.content ?? ''} /></div>
      {status === 'pending' && data.offerId && (
        <div className="mt-2 flex flex-col gap-2 md:flex-row md:items-center">
          <Button variant="danger" onClick={() => void cancel()} loading={busy} disabled={busy} className="min-h-[44px] w-full md:min-h-0 md:w-auto">Cancel offer</Button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

export function ThreadOwnerBadge({ owner }: { owner: ThreadOwnerInfo }) {
  const title = owner.from
    ? `${owner.username} owns this thread's task (handed off by ${owner.from}${owner.branch && owner.headSha ? ` @ ${owner.branch}@${owner.headSha.slice(0, 12)}` : ''})`
    : `${owner.username} owns this thread's task`;
  return (
    <span className="ml-2 inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 align-middle text-[11px] font-medium text-accent" title={title} data-testid="thread-owner">
      Owner: {owner.username}{owner.sessionState !== 'live' ? ' (session ended)' : ''}
    </span>
  );
}

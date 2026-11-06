import { useState } from 'react';
import type { Message } from '../../stores/messageStore';
import { Button } from '../../components/ui/Button';
import { MessageContent } from '../messages/MessageContent';
import { useViewerAuthority } from '../agents/viewerAuthority';
import { boxApi, type EdgeDecision } from './api';
import { boxError } from './boxRules';

/**
 * A box wants to reach a domain, push or open a pull request (docs/agent-boxes.md §4.3). The
 * server owner allows or denies it; for pushes and PRs "always" auto-allows them from this box
 * in its home channel. The card re-renders from the MessageUpdate the server sends after a
 * decision (src/lib/boxes/edge-requests.ts refreshCard). Same layout as the tool approval card.
 */

interface EdgeRequestData {
  requestId?: string; boxId?: string; boxName?: string; kind?: 'domain' | 'push' | 'pr';
  status?: string; summary?: string; canAlways?: boolean;
  /** A domain card's bounded wildcard (`*.oaiusercontent.com`), computed by the server; null when none */
  wildcard?: string | null;
}

const EDGE_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'PENDING', tone: 'bg-warn/20 text-warn' },
  allowed: { label: 'ALLOWED', tone: 'bg-online/20 text-online' },
  in_flight: { label: 'ALLOWED', tone: 'bg-online/20 text-online' },
  used: { label: 'DONE', tone: 'bg-online/20 text-online' },
  denied: { label: 'DENIED', tone: 'bg-danger/20 text-danger' },
  expired: { label: 'EXPIRED', tone: 'bg-surface text-text-muted' },
  unknown: { label: 'OUTCOME UNKNOWN', tone: 'bg-warn/20 text-warn' },
  changed: { label: 'DIFFERENT COMMIT', tone: 'bg-warn/20 text-warn' },
};

const KIND_TITLE: Record<string, string> = { domain: 'Domain request', push: 'Push request', pr: 'Pull request' };

const TOUCH = 'min-h-[44px] w-full md:min-h-0 md:w-auto';

export function EdgeRequestCard({ message }: { message: Message }) {
  const data = (message.systemData ?? {}) as EdgeRequestData;
  const [busy, setBusy] = useState<EdgeDecision | null>(null);
  const [error, setError] = useState('');
  const status = EDGE_STATUS[data.status ?? ''];
  const open = data.status === 'pending' && !!data.requestId;
  const authority = useViewerAuthority(message.channelId, open);
  // Only the server owner decides edge requests; a failed lookup shows the buttons and the server is the guard
  const canDecide = authority === 'owner' || authority === 'unknown';

  async function decide(decision: EdgeDecision) {
    if (!data.requestId) return;
    setBusy(decision);
    setError('');
    try {
      await boxApi.decideEdgeRequest(data.requestId, decision);
    } catch (err) {
      setError(boxError(err));
    } finally {
      setBusy(null);
    }
  }

  const title = `${KIND_TITLE[data.kind ?? ''] ?? 'Box request'}${data.boxName ? ` from ${data.boxName}` : ''}`;
  return (
    <div className="mx-4 my-2 rounded-lg border border-border bg-surface/60 px-4 py-3" data-testid="edge-request-card">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <svg className="h-4 w-4 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
          <path d="M3.3 7L12 12l8.7-5M12 22V12" />
        </svg>
        <span className="text-sm font-semibold text-text">{title}</span>
        {status && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${status.tone}`}>{status.label}</span>}
      </div>
      <div className="break-words text-sm text-text-muted">
        <MessageContent content={data.summary ? `Wants to ${data.summary}` : (message.content ?? '')} />
      </div>
      {open && canDecide && (
        <div className="mt-2 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <Button onClick={() => void decide('allow')} loading={busy === 'allow'} disabled={busy !== null} className={TOUCH}>Allow</Button>
          {data.kind === 'domain' && data.wildcard && (
            <Button variant="secondary" onClick={() => void decide('wildcard')} loading={busy === 'wildcard'} disabled={busy !== null} className={TOUCH}>
              Allow {data.wildcard}
            </Button>
          )}
          {data.canAlways && (
            <Button variant="secondary" onClick={() => void decide('always')} loading={busy === 'always'} disabled={busy !== null} className={TOUCH}>
              Always allow from this box here
            </Button>
          )}
          <Button variant="danger" onClick={() => void decide('deny')} loading={busy === 'deny'} disabled={busy !== null} className={TOUCH}>Deny</Button>
        </div>
      )}
      {open && (authority === 'director' || authority === null) && <p className="mt-2 text-xs text-text-muted">The server owner decides.</p>}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

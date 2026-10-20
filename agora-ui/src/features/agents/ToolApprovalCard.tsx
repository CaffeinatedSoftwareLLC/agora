import { useState } from 'react';
import type { Message } from '../../stores/messageStore';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { MessageContent } from '../messages/MessageContent';
import { decisionError } from './agentSessions';

/**
 * A hosted agent was denied a tool (#73). The owner or a director approves it once (the
 * agent's next run may use it, and it is woken to retry) or denies it; the owner can always
 * allow it (added to the agent's profile in Settings → Agents). Same layout as the code-run
 * approval card; the server enforces who may decide.
 */

type Decision = 'once' | 'always' | 'deny';

// live: a running Codex turn waits on this card (#93); detail is the whole command it asked to run
interface ToolApprovalData { kind?: string; requestId?: string; profile?: string; tool?: string; status?: string; live?: boolean; detail?: string | null; cwd?: string | null }
interface RunApprovalData { kind?: string; approvalId?: string; profile?: string; status?: string }

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'PENDING', tone: 'bg-warn/20 text-warn' },
  once: { label: 'APPROVED ONCE', tone: 'bg-online/20 text-online' },
  always: { label: 'ALWAYS ALLOWED', tone: 'bg-online/20 text-online' },
  approved: { label: 'APPROVED', tone: 'bg-online/20 text-online' },
  denied: { label: 'DENIED', tone: 'bg-danger/20 text-danger' },
  expired: { label: 'EXPIRED', tone: 'bg-surface text-text-muted' },
};

// Phone: full-width 44px buttons stacked, so they can't be mis-tapped. Desktop: a row.
const TOUCH = 'min-h-[44px] w-full md:min-h-0 md:w-auto';

export function ToolApprovalCard({ message }: { message: Message }) {
  const data = (message.systemData ?? {}) as ToolApprovalData;
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState('');
  const status = STATUS[data.status ?? ''];

  async function decide(decision: Decision) {
    if (!data.requestId || !message.channelId) return;
    setBusy(decision);
    setError('');
    try {
      // The card updates itself through the MessageUpdate the server sends
      await api.post(`/channels/${message.channelId}/agent-tool-requests/${data.requestId}`, { decision });
    } catch (err) {
      setError(decisionError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-4 my-2 rounded-lg border border-border bg-surface/60 px-4 py-3">
      <div className="mb-1 flex items-center gap-2">
        <svg className="h-4 w-4 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" />
        </svg>
        <span className="whitespace-nowrap text-sm font-semibold text-text">Tool request{data.profile ? ` from ${data.profile}` : ''}</span>
        {status && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${status.tone}`}>{status.label}</span>}
      </div>
      <div className="text-sm text-text-muted"><MessageContent content={message.content ?? ''} /></div>
      {typeof data.detail === 'string' && data.detail && (
        // The whole command, as plain text: read every character before approving it
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer select-none text-text-muted">Full command</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-surface px-2 py-1 font-mono text-xs text-text">{data.detail}</pre>
          {typeof data.cwd === 'string' && data.cwd && <p className="mt-1 break-all text-xs text-text-muted">in <code>{data.cwd}</code></p>}
        </details>
      )}
      {data.status === 'pending' && data.requestId && (
        <div className="mt-2 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <Button onClick={() => void decide('once')} loading={busy === 'once'} disabled={busy !== null} className={TOUCH}>Approve once</Button>
          <Button variant="secondary" onClick={() => void decide('always')} loading={busy === 'always'} disabled={busy !== null} className={TOUCH}>Always allow</Button>
          <Button variant="danger" onClick={() => void decide('deny')} loading={busy === 'deny'} disabled={busy !== null} className={TOUCH}>Deny</Button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

/**
 * A profile with run approval (docs/provider-terms.md) asks before every wake: the server
 * owner approves or denies this run. Same layout as the tool card.
 */
export function RunApprovalCard({ message }: { message: Message }) {
  const data = (message.systemData ?? {}) as RunApprovalData;
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState('');
  const status = STATUS[data.status ?? ''];

  async function decide(decision: 'approve' | 'deny') {
    if (!data.approvalId || !message.channelId) return;
    setBusy(decision);
    setError('');
    try {
      await api.post(`/channels/${message.channelId}/agent-run-approvals/${data.approvalId}`, { decision });
    } catch (err) {
      setError(decisionError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-4 my-2 rounded-lg border border-border bg-surface/60 px-4 py-3">
      <div className="mb-1 flex items-center gap-2">
        <svg className="h-4 w-4 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="6 4 20 12 6 20 6 4" />
        </svg>
        <span className="whitespace-nowrap text-sm font-semibold text-text">Run request{data.profile ? ` from ${data.profile}` : ''}</span>
        {status && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${status.tone}`}>{status.label}</span>}
      </div>
      <div className="text-sm text-text-muted"><MessageContent content={message.content ?? ''} /></div>
      {data.status === 'pending' && data.approvalId && (
        <div className="mt-2 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <Button onClick={() => void decide('approve')} loading={busy === 'approve'} disabled={busy !== null} className={TOUCH}>Approve run</Button>
          <Button variant="danger" onClick={() => void decide('deny')} loading={busy === 'deny'} disabled={busy !== null} className={TOUCH}>Deny</Button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

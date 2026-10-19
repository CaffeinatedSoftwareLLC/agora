import { useState } from 'react';
import type { Message } from '../../stores/messageStore';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { decisionError } from './agentSessions';

/**
 * A Claude Code session the owner runs themselves, with the Agora channel loaded, asks for a
 * tool permission (docs/claude-channel.md). The server owner allows or denies it here; the
 * answer goes back to that session. Claude Code also shows the prompt in its terminal, and
 * whichever answer comes first wins. The description and preview are written by Claude Code
 * from the model's tool call, so they are shown as plain text.
 */

type Decision = 'allow' | 'deny';

interface RelayData { requestId?: string; bot?: string; tool?: string; description?: string; inputPreview?: string; status?: string }

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'PENDING', tone: 'bg-warn/20 text-warn' },
  allow: { label: 'ALLOWED', tone: 'bg-online/20 text-online' },
  deny: { label: 'DENIED', tone: 'bg-danger/20 text-danger' },
};

const TOUCH = 'min-h-[44px] w-full md:min-h-0 md:w-auto';

export function PermissionRelayCard({ message }: { message: Message }) {
  const data = (message.systemData ?? {}) as RelayData;
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState('');
  const status = STATUS[data.status ?? ''];

  async function decide(decision: Decision) {
    if (!data.requestId || !message.channelId) return;
    setBusy(decision);
    setError('');
    try {
      // The card updates itself through the MessageUpdate the server sends
      await api.post(`/channels/${message.channelId}/permission-relays/${data.requestId}`, { decision });
    } catch (err) {
      setError(decisionError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-4 my-2 rounded-lg border border-border bg-surface/60 px-4 py-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <svg className="h-4 w-4 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" />
        </svg>
        <span className="text-sm font-semibold text-text">Permission request{data.bot ? ` from ${data.bot}` : ''}</span>
        <span className="text-xs text-text-muted">own Claude Code session</span>
        {status && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${status.tone}`}>{status.label}</span>}
      </div>
      <p className="text-sm text-text-muted">
        Wants to use <code className="rounded bg-bg px-1 font-mono text-xs text-text">{data.tool ?? 'a tool'}</code>
        {data.description ? <>: {data.description}</> : null}
      </p>
      {data.inputPreview && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-bg p-2 font-mono text-xs text-text">{data.inputPreview}</pre>
      )}
      {data.status === 'pending' && data.requestId && (
        <>
          <div className="mt-2 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
            <Button onClick={() => void decide('allow')} loading={busy === 'allow'} disabled={busy !== null} className={TOUCH}>Allow</Button>
            <Button variant="danger" onClick={() => void decide('deny')} loading={busy === 'deny'} disabled={busy !== null} className={TOUCH}>Deny</Button>
          </div>
          <p className="mt-1 text-xs text-text-dim">Only the server owner can answer. Answering in the terminal works too.</p>
        </>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

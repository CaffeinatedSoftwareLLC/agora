import { useState } from 'react';
import type { Message } from '../../stores/messageStore';
import { runtimeApi, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { MessageContent } from './MessageContent';

/**
 * System messages from the sandboxed runtime: the approval request for a run, and
 * the result summary when it finishes. The server enforces who may approve; the
 * buttons are shown to everyone who can see the thread and fail with a message if
 * the viewer lacks Manage Bots.
 */
export function RuntimeCard({ message }: { message: Message }) {
  const data = (message.systemData ?? {}) as { kind?: string; runId?: string; status?: string; capabilities?: string[] };
  const runId = data.runId;
  const [code, setCode] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'deny' | 'code' | null>(null);
  const [error, setError] = useState('');

  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiError ? err.code : fallback);

  async function toggleCode() {
    if (!runId) return;
    if (showCode) { setShowCode(false); return; }
    if (code === null) {
      setBusy('code');
      try { setCode(await runtimeApi.code(runId)); } catch (err) { fail(err, 'Could not load code'); setBusy(null); return; }
      setBusy(null);
    }
    setShowCode(true);
  }

  async function review(action: 'approve' | 'deny') {
    if (!runId) return;
    setBusy(action);
    setError('');
    try {
      await (action === 'approve' ? runtimeApi.approve(runId) : runtimeApi.deny(runId));
    } catch (err) {
      fail(err, `Could not ${action} the run`);
    } finally {
      setBusy(null);
    }
  }

  const isApproval = data.kind === 'runtime_approval';
  const pending = isApproval && data.status === 'pending';
  const statusTone: Record<string, string> = {
    pending: 'bg-warn/20 text-warn', approved: 'bg-online/20 text-online', denied: 'bg-danger/20 text-danger',
    succeeded: 'bg-online/20 text-online', failed: 'bg-danger/20 text-danger', timeout: 'bg-warn/20 text-warn',
    killed: 'bg-danger/20 text-danger', error: 'bg-danger/20 text-danger',
  };

  return (
    <div className="mx-4 my-2 rounded-lg border border-border bg-surface/60 px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <svg className="h-4 w-4 text-accent shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
        </svg>
        <span className="text-sm font-semibold text-text whitespace-nowrap">{isApproval ? 'Code run request' : 'Code run result'}</span>
        {data.status && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none ${statusTone[data.status] ?? 'bg-surface-hover text-text-muted'}`}>
            {data.status.toUpperCase()}
          </span>
        )}
      </div>
      {runId && <div className="text-[11px] text-text-dim font-mono mb-1 break-all">{runId}</div>}

      <div className="text-sm text-text-muted space-y-1">
        {splitFences(message.content ?? '').map((part, i) => part.code
          ? <pre key={i} className="max-h-60 overflow-auto rounded bg-bg p-2 text-xs text-text font-mono whitespace-pre-wrap break-words">{part.text}</pre>
          : <MessageContent key={i} content={part.text} />)}
      </div>

      {runId && (
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <Button variant="secondary" onClick={toggleCode} loading={busy === 'code'}>
            {showCode ? 'Hide code' : 'View code'}
          </Button>
          {pending && (
            <>
              <Button onClick={() => review('approve')} loading={busy === 'approve'}>Approve</Button>
              <Button variant="danger" onClick={() => review('deny')} loading={busy === 'deny'}>Deny</Button>
            </>
          )}
          {error && <span className="text-danger text-sm">{error}</span>}
        </div>
      )}

      {showCode && code !== null && (
        <pre className="mt-2 max-h-80 overflow-auto rounded bg-bg p-3 text-xs text-text font-mono whitespace-pre-wrap break-all">{code}</pre>
      )}
    </div>
  );
}

/** Split text on ``` fences so run output wraps instead of scrolling sideways. */
function splitFences(text: string): { text: string; code: boolean }[] {
  const parts = text.split(/```\n?/);
  return parts
    .map((t, i) => ({ text: i % 2 === 1 ? t.replace(/\n$/, '') : t.trim(), code: i % 2 === 1 }))
    .filter(p => p.text.length > 0);
}

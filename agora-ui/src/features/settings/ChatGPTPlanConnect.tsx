import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';

/**
 * "Continue with ChatGPT" for a Codex agent (docs/codex-chatgpt-plan.md). The sign-in runs on
 * the agent's host: Agora asks the host, the host opens the browser on that machine, and the
 * person signs in there and allows the agent to use their ChatGPT plan. Tokens stay on the
 * host; this page only sees the connection's state and the account's email.
 */

export interface PlanConnection {
  profileId: string;
  status: 'requested' | 'in_progress' | 'connected' | 'scope_missing' | 'failed' | 'disconnect_requested' | 'disconnected';
  accountLabel: string | null;
  error: string | null;
  planOwnerId: string | null;
}

export const USAGE_URL = 'https://chatgpt.com/settings/usage';
export const PENDING = new Set(['requested', 'in_progress', 'disconnect_requested']);

const ERROR_TEXT: Record<string, string> = {
  consent_declined: 'Sign-in was declined in the browser.',
  sign_in_timeout: 'Sign-in timed out before it finished in the browser.',
  browser_unavailable: 'The host could not open a browser. Run `agora-host siwc login` on that machine instead.',
  callback_port_unavailable: 'The host\'s sign-in port is in use.',
  account_mismatch: 'A different ChatGPT account signed in than the one saved for this agent.',
  invalid_id_token: 'The ChatGPT identity could not be verified. Try again.',
  registration_incomplete: 'ChatGPT did not finish registering Agora. Try again.',
  invalid_grant: 'The sign-in code expired. Try again.',
  siwc_not_configured: 'This agent isn\'t set to "auth": "siwc" in its host\'s config, so the host can\'t sign it in.',
  revocation_unconfirmed: 'Signed out on the host, but OpenAI did not confirm it. Disconnect Agora in ChatGPT settings.',
};

function statusText(plan: PlanConnection | undefined, hostName: string): string {
  switch (plan?.status) {
    case 'requested': return `Waiting for ${hostName} to open the browser…`;
    case 'in_progress': return `Finish signing in in the browser on ${hostName}.`;
    case 'disconnect_requested': return `Waiting for ${hostName} to sign out…`;
    case 'connected': return `Using ChatGPT plan${plan.accountLabel ? ` (${plan.accountLabel})` : ''}. Only its plan owner can wake this agent.`;
    case 'scope_missing': return 'Signed in, but using your ChatGPT plan wasn\'t allowed. Continue with ChatGPT again and allow it, or use an API key profile.';
    case 'failed': return ERROR_TEXT[plan.error ?? ''] ?? `Sign-in failed${plan.error ? ` (${plan.error})` : ''}.`;
    case 'disconnected': return plan.error ? ERROR_TEXT[plan.error] ?? 'Disconnected.' : 'Disconnected.';
    default: return 'Not connected. Run this agent on your own ChatGPT Plus or Pro plan.';
  }
}

export function ChatGPTPlanConnect({ serverId, profileId, hostName, plan, siwcMode, onChange }: {
  serverId: string; profileId: string; hostName: string; plan: PlanConnection | undefined;
  /** The host reported this profile as "auth": "siwc". */
  siwcMode: boolean;
  onChange: () => void;
}) {
  const [error, setError] = useState('');
  const pending = !!plan && PENDING.has(plan.status);
  // While the host works on it, check again every few seconds
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(onChange, 3000);
    return () => clearInterval(t);
  }, [pending, onChange]);

  const send = async (action: 'connect' | 'disconnect') => {
    setError('');
    try {
      await api.post(`/servers/${serverId}/agent-profiles/${profileId}/plan`, { action });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 403 ? 'Only the server owner or the person who registered this host can do this.' : err.code) : 'Request failed');
    }
  };
  const connected = plan?.status === 'connected';

  return (
    <div className="mt-2 rounded border border-border bg-bg/50 p-2 text-xs" data-testid={`plan-${profileId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-text">ChatGPT plan</span>
        <span className="text-text-muted" role="status">{statusText(plan, hostName)}</span>
      </div>
      {!siwcMode && <p className="mt-1 text-text-muted">Set this profile to <code>"auth": "siwc"</code> in the host's config and restart the host first.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!connected && (
          <Button variant="secondary" disabled={pending} onClick={() => void send('connect')}>Continue with ChatGPT</Button>
        )}
        {connected && (
          <>
            <a className="min-h-11 md:min-h-8 inline-flex items-center px-2 text-primary hover:underline" href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
            <Button variant="secondary" onClick={() => void send('disconnect')}>Disconnect</Button>
          </>
        )}
      </div>
      {error && <p className="mt-1 text-danger" role="alert">{error}</p>}
      <p className="mt-1 text-text-muted">Local and self-hosted use only; Agora is open source. Tokens stay on {hostName}.</p>
    </div>
  );
}

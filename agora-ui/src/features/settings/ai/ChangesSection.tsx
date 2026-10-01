import { useEffect, useState } from 'react';
import { aiApi } from '../../../lib/api';
import type { AIChange, AICapability } from '../../../lib/api';
import { CAPABILITY_INFO } from './format';

type Snapshot = { provider?: string | null; model?: string; enabled?: boolean } | null;

const capLabel = (c: string) => CAPABILITY_INFO[c as AICapability]?.label ?? c;
const routeText = (s: Snapshot) => (s ? `${s.provider ?? 'provider'} · ${s.model}${s.enabled === false ? ' (off)' : ''}` : '');

/** What changed, in one line. */
function describe(c: AIChange): string {
  const d = c.changes;
  switch (c.action) {
    case 'ai_route_update':
      if (!d.before) return `${capLabel(d.capability)} set to ${routeText(d.after)}`;
      return `${capLabel(d.capability)}: ${routeText(d.before)} → ${routeText(d.after)}`
        + (d.changed?.length && !d.changed.every((f: string) => ['providerId', 'provider', 'model', 'enabled'].includes(f))
          ? ` (${d.changed.join(', ')})` : '');
    case 'ai_route_delete':
      return `${capLabel(d.capability)} removed (was ${routeText(d.before)})`;
    case 'ai_provider_create':
      return `Provider “${d.after?.label}” added`;
    case 'ai_provider_update': {
      const parts = (d.changed ?? []).filter((f: string) => f !== 'hasApiKey');
      if (d.apiKey) parts.push(`key ${d.apiKey}`);
      return `Provider “${d.after?.label ?? d.before?.label}” updated${parts.length ? `: ${parts.join(', ')}` : ''}`;
    }
    case 'ai_provider_delete':
      return `Provider “${d.before?.label}” deleted${d.routesRemoved?.length ? ` (removed routes: ${d.routesRemoved.map(capLabel).join(', ')})` : ''}`;
    case 'ai_assistant_update':
      return `Assistant settings changed: ${Object.keys(d).filter(k => k !== 'client').join(', ')}`;
    case 'ai_tag_create':
      return `File tag “${d.name}” added`;
    case 'ai_tag_update':
      return `File tag “${d.name}” updated: ${(d.changed ?? []).join(', ')}`;
    case 'ai_tag_delete':
      return `File tag “${d.name}” deleted`;
    case 'ai_tag_retag':
      return `Files queued for tagging: ${d.created ?? 0} new, ${d.requeued ?? 0} to re-tag, ${d.retried ?? 0} retried`;
    case 'ai_decision_update':
      return `Decision model settings: ${(d.changed ?? []).map((f: string) => `${f} → ${JSON.stringify(d.after?.[f])}`).join(', ')}`;
    default:
      return c.action;
  }
}

/** "browser" for web browsers; otherwise the client's own name (a script or agent). */
function clientText(ua: string | null | undefined): string | null {
  if (!ua) return null;
  if (/Mozilla\//.test(ua)) return 'browser';
  return ua.split(' ')[0].slice(0, 40);
}

/**
 * Audit trail of AI settings changes: who changed which provider or route, when,
 * and from which client (browser vs script/agent). Refreshes after each save.
 */
export function ChangesSection({ serverId, version }: { serverId: string; version: number }) {
  const [changes, setChanges] = useState<AIChange[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    aiApi.listChanges(serverId, 20)
      .then(c => { if (!cancelled) setChanges(c); })
      .catch(() => { if (!cancelled) setChanges([]); });
    return () => { cancelled = true; };
  }, [serverId, version]);

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold text-text mb-2">Recent changes</h3>
      <p className="text-sm text-text-muted mb-3">Who changed AI providers and capabilities, and when. Keys are never shown.</p>
      {changes === null ? (
        <p className="text-sm text-text-dim">Loading…</p>
      ) : changes.length === 0 ? (
        <p className="text-sm text-text-dim">No changes recorded yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {changes.map(c => {
            const client = clientText(c.changes.client);
            return (
              <li key={c.id} className="px-3 py-2 text-sm">
                <div className="text-text break-words">{describe(c)}</div>
                <div className="text-xs text-text-dim mt-0.5">
                  {new Date(c.createdAt).toLocaleString()} · {c.actor ? c.actor.username : 'unknown user'}
                  {client && ` · via ${client}`}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

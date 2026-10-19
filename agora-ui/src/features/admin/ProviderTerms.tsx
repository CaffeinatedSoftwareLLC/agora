import { useCallback, useEffect, useState } from 'react';
import { api, inBackground } from '../../lib/api';

interface Document {
  id: string; name: string; provider: string; url: string; allowed_hosts: string[]; enabled: boolean;
  checked_at: string | null; fetched_at: string | null; last_change_at: string | null;
  status: string; error: string | null; consecutive_failures: number; unacknowledged: number;
}
interface Change { id: string; created_at: string; diff: string; summary: string; impact: string; analysis_status: string; acknowledged_at: string | null }
interface Dashboard {
  documents: Document[];
  settings: { intervalHours: number; channelId: string | null; effectiveChannelId: string | null; lastRunAt: string | null; requested: boolean };
  channels: { id: string; name: string; server_name: string }[];
}
const date = (v: string | null) => v ? new Date(v).toLocaleString() : 'Never';
const input = 'rounded border border-border bg-surface p-2';

export function ProviderTerms() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [intervalHours, setIntervalHours] = useState(24); const [channelId, setChannelId] = useState('');
  const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [provider, setProvider] = useState('other');
  const [hosts, setHosts] = useState(''); const [selected, setSelected] = useState<string | null>(null);
  const [changes, setChanges] = useState<Change[]>([]); const [more, setMore] = useState(false);
  const load = useCallback(async (initial = false) => {
    const next = await api.get<Dashboard>('/terms-watch'); setData(next);
    if (initial) { setIntervalHours(next.settings.intervalHours); setChannelId(next.settings.channelId ?? ''); }
  }, []);
  useEffect(() => {
    load(true).catch(e => setError(e.message));
    const timer = setInterval(() => inBackground(() => load()).catch(e => setError(e.message)), 10_000);
    return () => clearInterval(timer);
  }, [load]);
  async function act(fn: () => Promise<unknown>, message = '') {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); await load(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed'); }
    finally { setBusy(false); }
  }
  async function history(id: string, before?: string) {
    const rows = await api.get<Change[]>(`/terms-watch/documents/${id}/changes?limit=20${before ? `&before=${before}` : ''}`);
    setSelected(id); setChanges(old => before ? [...old, ...rows] : rows); setMore(rows.length === 20);
  }
  if (!data) return <div><h1 className="text-xl font-bold">Provider terms</h1>{error ? <p role="alert">{error}</p> : <p>Loading provider terms…</p>}</div>;
  return <div className="space-y-6 max-w-6xl">
    <h1 className="text-2xl font-bold">Provider terms</h1>
    <p>Review changes to provider policies. AI summaries are advisory; fetched text and model output are untrusted.</p>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="flex gap-4 items-center flex-wrap">
      <button className={input} disabled={busy || data.settings.requested} onClick={() => act(() => api.post('/terms-watch/check', {}), 'Check queued. The worker picks it up within 60 seconds.')}>Check now</button>
      <span>{data.settings.requested ? 'Check queued' : `Last run: ${date(data.settings.lastRunAt)}`}</span>
    </div>
    <form className="flex gap-3 items-end flex-wrap" onSubmit={e => { e.preventDefault(); act(() => api.patch('/terms-watch/settings', { intervalHours, channelId: channelId || null }), 'Settings saved.'); }}>
      <label>Check interval (hours)<input className={`${input} block`} type="number" min={1} max={720} required value={intervalHours} onChange={e => setIntervalHours(Number(e.target.value))} /></label>
      <label>Alert channel<select className={`${input} block`} value={channelId} onChange={e => setChannelId(e.target.value)}>
        <option value="">Default: owner’s first server / general</option>
        {data.channels.map(c => <option key={c.id} value={c.id}>{c.server_name} / #{c.name}</option>)}
      </select></label>
      <button disabled={busy} className={input}>Save settings</button>
    </form>
    {!data.settings.effectiveChannelId && <p role="alert">No owner alert channel is available. Changes remain in history until a channel is available.</p>}
    <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>
      <th className="p-2">Document</th><th className="p-2">Last check / last change</th><th className="p-2">Status</th><th className="p-2">Actions</th>
    </tr></thead><tbody>{data.documents.map(d => <tr key={d.id} className="border-t border-border">
      <td className="p-2"><a href={d.url} target="_blank" rel="noreferrer" className="underline">{d.name}</a><p className="text-text-muted">{d.provider}</p></td>
      <td className="p-2">{date(d.checked_at)}<p>{date(d.last_change_at)}</p></td>
      <td className="p-2">{d.enabled ? d.status : 'Disabled'}{d.unacknowledged > 0 && <p>{d.unacknowledged} unacknowledged</p>}
        {d.consecutive_failures >= 3 && <p role="alert">Warning: {d.consecutive_failures} consecutive failures</p>}{d.error && <p>{d.error}</p>}</td>
      <td className="p-2"><div className="flex gap-2 flex-wrap">
        <button disabled={busy} className={input} onClick={() => act(() => api.patch(`/terms-watch/documents/${d.id}`, { enabled: !d.enabled }))}>{d.enabled ? 'Disable' : 'Enable'}</button>
        <button disabled={busy} className={input} onClick={() => act(() => history(d.id))}>History</button>
        <button disabled={busy} className={input} onClick={() => {
          if (window.confirm(`Remove ${d.name} and its entire change history?`)) act(async () => { await api.delete(`/terms-watch/documents/${d.id}`); if (selected === d.id) { setSelected(null); setChanges([]); } });
        }}>Remove</button>
      </div></td>
    </tr>)}</tbody></table></div>
    <form className="border border-border rounded p-4 flex gap-3 flex-wrap items-end" onSubmit={e => { e.preventDefault(); act(async () => {
      await api.post('/terms-watch/documents', { name, url, provider, ...(hosts.trim() ? { allowedHosts: hosts.split(',').map(h => h.trim().toLowerCase()).filter(Boolean) } : {}) });
      setName(''); setUrl(''); setHosts('');
    }, 'Document added. The first successful check establishes its baseline.'); }}>
      <h2 className="w-full font-bold">Watch a document</h2>
      <label>Name<input className={`${input} block`} required maxLength={160} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>HTTPS URL<input className={`${input} block`} type="url" required maxLength={2048} value={url} onChange={e => setUrl(e.target.value)} /></label>
      <label>Provider<select className={`${input} block`} value={provider} onChange={e => setProvider(e.target.value)}>{['other','anthropic','openai','google'].map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Allowed redirect hosts (comma separated)<input className={`${input} block`} placeholder="Defaults to URL host" value={hosts} onChange={e => setHosts(e.target.value)} /></label>
      <button disabled={busy} className={input}>Add document</button>
    </form>
    {selected && <section aria-label="Change history" className="space-y-4">
      <h2 className="text-xl font-bold">History: {data.documents.find(d => d.id === selected)?.name}</h2>
      {!changes.length && <p>No changes recorded. The first fetch establishes a baseline.</p>}
      {changes.map(c => <article key={c.id} className="border border-border rounded p-4 space-y-2">
        <h3>{date(c.created_at)} — {c.impact}</h3><p className="whitespace-pre-line">{c.summary}</p><p className="text-text-muted">{c.analysis_status}</p>
        <details><summary className="cursor-pointer">View diff</summary><pre className="overflow-x-auto whitespace-pre-wrap text-xs p-3 bg-surface">{c.diff}</pre></details>
        {c.acknowledged_at ? <p>Acknowledged {date(c.acknowledged_at)}</p> : <button className={input} disabled={busy} onClick={() => act(async () => {
          await api.post(`/terms-watch/changes/${c.id}/acknowledge`, {}); await history(selected);
        }, 'Change acknowledged.')}>Acknowledge</button>}
      </article>)}
      {more && <button className={input} disabled={busy} onClick={() => act(() => history(selected, changes.at(-1)?.id))}>Load older changes</button>}
    </section>}
  </div>;
}

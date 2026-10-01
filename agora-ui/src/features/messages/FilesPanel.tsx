import { useEffect, useState } from 'react';
import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { fileSearchApi, getAuthHeaders, ApiError } from '../../lib/api';
import type { FileSearchItem, FileSearchResult } from '../../lib/api';
import { FileTags } from './FileAttachment';
import { usePalette } from '../../theme';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function download(file: FileSearchItem) {
  const res = await fetch(file.url, { headers: getAuthHeaders() });
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The files shared in the current channel: newest first, or best match first when
 * something is typed. Tags and ranking come from the server's decision model when
 * it has one; without it, search matches file names.
 */
export function FilesPanel() {
  const P = usePalette();
  const channelId = useChannelStore(s => s.activeChannelId);
  const serverId = useServerStore(s => s.instanceServerId);
  const toggleFiles = useUIStore(s => s.toggleFiles);

  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [result, setResult] = useState<FileSearchResult | null>(null);
  // The request whose answer is on screen; anything else means one is in flight
  const [loadedKey, setLoadedKey] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    fileSearchApi.tagNames(serverId)
      .then(tags => { if (!cancelled) setTagNames(tags.map(t => t.name)); })
      .catch(() => { /* no tags to filter by */ });
    return () => { cancelled = true; };
  }, [serverId]);

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    const key = `${channelId}|${query}|${tag}`;
    fileSearchApi.search(channelId, { q: query || undefined, tag: tag || undefined, limit: 25 })
      .then(res => {
        if (cancelled) return;
        setResult(res);
        setError('');
      })
      .catch(err => { if (!cancelled) setError(err instanceof ApiError ? (err.message || err.code) : 'Could not load files'); })
      .finally(() => { if (!cancelled) setLoadedKey(key); });
    return () => { cancelled = true; };
  }, [channelId, query, tag]);

  if (!channelId) return null;
  const loading = loadedKey !== `${channelId}|${query}|${tag}`;

  return (
    <div className="w-[340px] shrink-0 flex flex-col border-l" style={{ background: P.bg, borderColor: P.border }}>
      <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: `1px solid ${P.border}` }}>
        <h2 className="text-sm font-semibold" style={{ color: P.text }}>Files</h2>
        <button
          onClick={toggleFiles}
          className="h-7 w-7 rounded flex items-center justify-center"
          style={{ color: P.muted }}
          title="Close"
          aria-label="Close files"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <form
        className="px-4 py-3 flex flex-col gap-2 shrink-0"
        style={{ borderBottom: `1px solid ${P.border}` }}
        onSubmit={e => { e.preventDefault(); setQuery(text.trim()); }}
      >
        <input
          className="rounded px-3 py-1.5 text-sm focus:outline-none"
          style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.text }}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="What are you looking for?"
          maxLength={500}
          aria-label="Search files"
        />
        <div className="flex items-center gap-2">
          {tagNames.length > 0 && (
            <select
              className="rounded px-2 py-1 text-xs flex-1 min-w-0"
              style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.text }}
              value={tag}
              onChange={e => setTag(e.target.value)}
              aria-label="Filter by tag"
            >
              <option value="">Any tag</option>
              {tagNames.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
          <button type="submit" className="rounded px-3 py-1 text-xs font-medium" style={{ background: P.primary, color: P.text }}>
            Search
          </button>
        </div>
      </form>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {error && <p className="text-sm" style={{ color: P.danger }}>{error}</p>}
        {!error && !result && loading && <p className="text-sm" style={{ color: P.muted }}>Loading…</p>}
        {result && result.results.length === 0 && (
          <p className="text-sm" style={{ color: P.muted }}>
            {query || tag ? 'No files match.' : 'No files have been shared in this channel yet.'}
          </p>
        )}
        <ul className="flex flex-col gap-3" style={{ opacity: loading ? 0.6 : 1 }}>
          {result?.results.map(file => (
            <li key={file.id}>
              <button
                type="button"
                className="text-sm font-medium text-left break-all hover:underline"
                style={{ color: P.primary }}
                onClick={() => download(file)}
                title={`Download ${file.name}`}
              >
                {file.name}
              </button>
              <div className="text-xs" style={{ color: P.dim }}>
                {formatSize(file.size)} · {new Date(file.uploadedAt).toLocaleDateString()}
                {result.query && ` · match ${Math.round(file.score * 100)}%`}
              </div>
              <FileTags attachment={{
                tags: file.tags.map(t => t.name),
                tagging: file.tagging === 'none' ? undefined : file.tagging,
                partial: file.partial,
                injectionWarning: file.injectionWarning,
              }}
              />
            </li>
          ))}
        </ul>
        {result && result.query && result.results.length > 0 && (
          <p className="text-xs mt-4" style={{ color: P.dim }}>
            {result.ranking.status === 'ranked'
              ? 'Ordered by how well each file answers your search.'
              : `Ordered by file names and tags${result.ranking.reason ? ` (${result.ranking.reason.toLowerCase()})` : ''}.`}
          </p>
        )}
      </div>
    </div>
  );
}

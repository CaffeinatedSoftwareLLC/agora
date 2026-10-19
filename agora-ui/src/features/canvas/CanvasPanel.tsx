import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { canvasApi, ApiError, type ArtifactDetail, type ArtifactSummary, type ArtifactVersion } from '../../lib/api';
import { relativeTime } from '../../lib/relativeTime';
import { useChannelStore } from '../../stores/channelStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { useUIStore } from '../../stores/uiStore';
import { usePalette } from '../../theme';
import { AuxPanelControl } from '../shell/AuxPanelControl';
import { buildSrcDoc, downloadMime, downloadName, KIND_LABELS, sandboxFor } from './frame';
import { renderMermaid } from './mermaid';

const errorText = (err: unknown) => err instanceof ApiError ? (err.status === 404 ? 'This artifact is gone (its posts were deleted).' : err.code) : 'Could not load the artifact';

/** The canvas pane: one artifact rendered in a sandbox, or the channel's artifacts to pick from. */
export function CanvasPanel() {
  const P = usePalette();
  const target = useUIStore(s => s.canvas);
  const activeChannelId = useChannelStore(s => s.activeChannelId);
  const channelId = target?.channelId ?? activeChannelId;
  if (!channelId) return null;
  return (
    <div className="flex flex-col min-h-0 border-l" style={{ background: P.bg, borderColor: P.border }}>
      {target?.artifactId
        ? <ArtifactView key={target.artifactId} channelId={channelId} artifactId={target.artifactId} pinned={target.version} />
        : <ArtifactList channelId={channelId} />}
    </div>
  );
}

function Header({ children }: { children: React.ReactNode }) {
  const P = usePalette();
  return (
    <div className="flex flex-wrap items-center gap-2 min-h-12 px-3 py-2 shrink-0" style={{ borderBottom: `1px solid ${P.border}` }}>
      <AuxPanelControl label="canvas" />
      {children}
    </div>
  );
}

function ArtifactList({ channelId }: { channelId: string }) {
  const P = usePalette();
  const openCanvas = useUIStore(s => s.openCanvas);
  const [items, setItems] = useState<ArtifactSummary[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    canvasApi.list(channelId).then(r => { if (!cancelled) setItems(r.artifacts); })
      .catch(err => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [channelId]);
  return (
    <>
      <Header><h2 className="text-[15px] font-semibold flex-1" style={{ color: P.text }}>Canvas</h2></Header>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {error && <p className="text-[13px]" style={{ color: P.danger }}>{error}</p>}
        {!error && !items && <p className="text-[13px]" style={{ color: P.muted }}>Loading…</p>}
        {items?.length === 0 && (
          <p className="text-[13px]" style={{ color: P.muted }}>
            No artifacts yet. Agents publish HTML pages, Markdown, Mermaid diagrams and SVGs here with canvas_publish.
          </p>
        )}
        <ul className="flex flex-col gap-1">
          {items?.map(a => (
            <li key={a.id}>
              <button type="button" onClick={() => openCanvas({ channelId, artifactId: a.id, version: null })}
                className="w-full min-h-11 rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover">
                <span className="block truncate text-[15px] font-medium" style={{ color: P.text }}>{a.title}</span>
                <span className="block text-[12px]" style={{ color: P.muted }}>
                  {KIND_LABELS[a.kind]} · v{a.latestVersion} · {a.createdByUsername ?? 'unknown'} · {relativeTime(a.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

const newestIn = (messages: Message[] | undefined, artifactId: string) =>
  (messages ?? []).reduce((n, m) => m.artifact?.id === artifactId && !m.deletedAt ? Math.max(n, m.artifact.version) : n, 0);

/** The newest version of this artifact the chat has seen arrive, so the pane can catch up live. */
function useNewestSeen(channelId: string, artifactId: string) {
  const inChannel = useMessageStore(s => newestIn(s.byChannel.get(channelId), artifactId));
  const inThreads = useThreadStore(s => {
    let n = 0;
    for (const list of s.repliesByThread.values()) n = Math.max(n, newestIn(list, artifactId));
    return n;
  });
  return Math.max(inChannel, inThreads);
}

function ArtifactView({ channelId, artifactId, pinned }: { channelId: string; artifactId: string; pinned: number | null }) {
  const P = usePalette();
  const openCanvas = useUIStore(s => s.openCanvas);
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [doc, setDoc] = useState<ArtifactVersion | null>(null);
  const [error, setError] = useState('');
  const [source, setSource] = useState(false);
  const [network, setNetwork] = useState(false);
  const newestSeen = useNewestSeen(channelId, artifactId);
  const known = detail?.latestVersion ?? 0;

  // Versions list: on open, and again when a newer version arrives in chat
  useEffect(() => {
    let cancelled = false;
    canvasApi.get(channelId, artifactId).then(d => { if (!cancelled) { setDetail(d); setError(''); } })
      .catch(err => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [channelId, artifactId, newestSeen > known ? newestSeen : 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Following the latest version unless one was picked
  const version = pinned ?? detail?.latestVersion ?? null;
  useEffect(() => {
    if (version === null) return;
    let cancelled = false;
    canvasApi.version(channelId, artifactId, version).then(v => { if (!cancelled) setDoc(v); })
      .catch(err => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [channelId, artifactId, version]);

  const shown = doc && doc.version === version ? doc : null;
  const download = () => {
    if (!shown) return;
    const url = URL.createObjectURL(new Blob([shown.content], { type: downloadMime(shown.kind) }));
    const a = document.createElement('a');
    a.href = url; a.download = downloadName(shown.title, shown.version, shown.kind); a.click();
    URL.revokeObjectURL(url);
  };
  const button = 'min-h-11 md:min-h-8 rounded-lg px-2.5 text-[13px] font-medium';
  const toggle = (on: boolean) => ({ background: on ? `${P.accent}24` : P.surface, color: on ? P.accent : P.muted, border: `1px solid ${P.border}` });

  return (
    <>
      <Header>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold" style={{ color: P.text }}>{shown?.title ?? detail?.title ?? 'Canvas'}</h2>
          {shown && <p className="truncate text-[12px]" style={{ color: P.muted }}>
            {KIND_LABELS[shown.kind]} · {shown.authorUsername ?? 'unknown'} · {relativeTime(shown.createdAt)}
          </p>}
        </div>
        {detail && detail.versions.length > 0 && (
          <select aria-label="Version" value={version ?? ''} className="min-h-11 md:min-h-8 rounded-lg px-2 text-[16px] md:text-[13px]"
            style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.text }}
            onChange={e => {
              const v = Number(e.target.value);
              openCanvas({ channelId, artifactId, version: v === detail.latestVersion ? null : v });
            }}>
            {detail.versions.map(v => <option key={v.version} value={v.version}>v{v.version}{v.version === detail.latestVersion ? ' (latest)' : ''}</option>)}
          </select>
        )}
      </Header>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: `1px solid ${P.border}` }}>
        <button type="button" className={button} style={toggle(source)} aria-pressed={source} onClick={() => setSource(s => !s)}>Source</button>
        {shown && shown.kind !== 'mermaid' && (
          <button type="button" className={button} style={toggle(network)} aria-pressed={network} onClick={() => setNetwork(n => !n)}
            title="Let the artifact load images, fonts and scripts over https. Off by default.">
            Network {network ? 'on' : 'off'}
          </button>
        )}
        <button type="button" className={button} style={toggle(false)} onClick={download} disabled={!shown}>Download</button>
        {pinned !== null && detail?.latestVersion && pinned !== detail.latestVersion && (
          <button type="button" className={button} style={toggle(true)} onClick={() => openCanvas({ channelId, artifactId, version: null })}>
            Go to latest (v{detail.latestVersion})
          </button>
        )}
      </div>
      <div className="relative flex-1 min-h-0">
        {error && <p className="p-4 text-[13px]" style={{ color: P.danger }}>{error}</p>}
        {!error && !shown && <p className="p-4 text-[13px]" style={{ color: P.muted }}>Loading…</p>}
        {!error && shown && (source
          ? <pre className="h-full overflow-auto p-4 text-[13px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ color: P.text, fontFamily: 'JetBrains Mono, monospace' }}>{shown.content}</pre>
          : <Rendered doc={shown} network={network} />)}
      </div>
    </>
  );
}

function Rendered({ doc, network }: { doc: ArtifactVersion; network: boolean }) {
  if (doc.kind === 'markdown') return <MarkdownView content={doc.content} network={network} />;
  if (doc.kind === 'mermaid') return <MermaidView source={doc.content} title={doc.title} />;
  return <SandboxFrame title={doc.title} kind={doc.kind} srcDoc={buildSrcDoc(doc.kind, doc.content, network)} />;
}

/**
 * The artifact's frame: sandboxed, opaque origin, CSP inside the document. A script can
 * still navigate its own frame away; the second load gives that away, and the frame is
 * reset instead of showing the other page.
 */
export function SandboxFrame({ title, kind, srcDoc }: { title: string; kind: 'html' | 'svg' | 'mermaid'; srcDoc: string }) {
  const P = usePalette();
  const loads = useRef({ doc: '', count: 0 });
  const [navigatedDoc, setNavigatedDoc] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const onLoad = () => {
    // A new document (or a reload) starts the count again; a second load of the same one is a navigation
    if (loads.current.doc !== srcDoc) loads.current = { doc: srcDoc, count: 0 };
    if (++loads.current.count > 1) setNavigatedDoc(srcDoc);
  };
  if (navigatedDoc === srcDoc) {
    return (
      <div className="p-4 text-[13px]" style={{ color: P.muted }}>
        <p>This artifact tried to open another page, so the frame was reset.</p>
        <button type="button" className="mt-2 min-h-11 md:min-h-8 rounded-lg px-3 font-medium" style={{ background: P.surface, color: P.text, border: `1px solid ${P.border}` }}
          onClick={() => { loads.current = { doc: '', count: 0 }; setNavigatedDoc(null); setGeneration(g => g + 1); }}>Reload it</button>
      </div>
    );
  }
  return (
    <iframe
      key={generation}
      title={title}
      sandbox={sandboxFor(kind)}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      allow=""
      onLoad={onLoad}
      className="absolute inset-0 h-full w-full border-0"
      style={{ background: '#fff' }}
    />
  );
}

function MermaidView({ source, title }: { source: string; title: string }) {
  const P = usePalette();
  const [result, setResult] = useState<{ source: string; svg?: string; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    renderMermaid(source)
      .then(svg => { if (!cancelled) setResult({ source, svg }); })
      .catch(err => { if (!cancelled) setResult({ source, error: err instanceof Error ? err.message : 'Could not render the diagram' }); });
    return () => { cancelled = true; };
  }, [source]);
  const current = result?.source === source ? result : null;
  const srcDoc = current?.svg ? buildSrcDoc('svg', current.svg) : null;
  if (!current) return <p className="p-4 text-[13px]" style={{ color: P.muted }}>Rendering diagram…</p>;
  if (current.error || !srcDoc) {
    return (
      <div className="h-full overflow-auto p-4 text-[13px]">
        <p style={{ color: P.danger }}>Mermaid could not render this diagram: {current.error}</p>
        <pre className="mt-2 whitespace-pre-wrap" style={{ color: P.text }}>{source}</pre>
      </div>
    );
  }
  return <SandboxFrame title={title} kind="mermaid" srcDoc={srcDoc} />;
}

/** Markdown never renders raw HTML here; images load only from data: URLs unless network is on. */
function MarkdownView({ content, network }: { content: string; network: boolean }) {
  const P = usePalette();
  return (
    <div className="h-full overflow-auto px-5 py-4 text-[15px] prose-msg" style={{ color: P.text }}>
      <Markdown
        urlTransform={(url, key) => {
          if (key === 'src') return /^data:image\//i.test(url) || (network && /^https:/i.test(url)) ? url : '';
          return /^(https?:|mailto:|#)/i.test(url) ? url : '';
        }}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline">{children}</a>,
          img: ({ src, alt }) => src ? <img src={src} alt={alt ?? ''} referrerPolicy="no-referrer" className="max-w-full" />
            : <span className="text-[13px]" style={{ color: P.muted }}>[image: {alt || 'not loaded'}{network ? '' : ', network off'}]</span>,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

import type { ArtifactKind } from '../../lib/api';

/**
 * The document a canvas artifact renders in. It goes into an iframe with `sandbox` and
 * no `allow-same-origin`, so it runs in an opaque origin: no cookies, no storage, no
 * access to Agora's page or API. The CSP below is the first thing in the document, so it
 * applies before any of the artifact's own markup is parsed: no network by default, only
 * inline scripts and styles and data:/blob: media. With `network` on, https: sources are
 * allowed too (for pages that load a library or font from a CDN).
 */
export function artifactCsp(network: boolean): string {
  const net = network ? ' https:' : '';
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob:${net}`,
    `style-src 'unsafe-inline'${net}`,
    `img-src data: blob:${net}`,
    `font-src data:${net}`,
    `media-src data: blob:${net}`,
    `connect-src ${network ? 'https:' : "'none'"}`,
    'worker-src blob:',
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** SVG (and rendered Mermaid) gets a page that centres it and scales it down to fit. */
const SVG_PAGE_STYLE = 'html,body{margin:0;height:100%;background:#fff}body{display:flex;align-items:flex-start;justify-content:center;padding:16px;box-sizing:border-box}svg{max-width:100%;height:auto}';

/**
 * Our doctype and meta tags come first; the artifact follows. A full HTML page still works:
 * the parser ignores its second doctype, merges its <html> attributes and keeps its <head>
 * content in the head. Its own CSP meta, if any, can only narrow ours.
 */
export function buildSrcDoc(kind: Extract<ArtifactKind, 'html' | 'svg'>, content: string, network = false): string {
  const head = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(artifactCsp(network))}">`
    + '<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">';
  if (kind === 'svg') return `${head}<style>${SVG_PAGE_STYLE}</style><body>${content}</body>`;
  return head + content;
}

/** HTML may run its scripts (in the opaque origin); SVG and Mermaid output never need to. */
export const sandboxFor = (kind: ArtifactKind): string => kind === 'html' ? 'allow-scripts' : '';

export const KIND_LABELS: Record<ArtifactKind, string> = { html: 'HTML', markdown: 'Markdown', mermaid: 'Mermaid', svg: 'SVG' };
const EXTENSIONS: Record<ArtifactKind, string> = { html: 'html', markdown: 'md', mermaid: 'mmd', svg: 'svg' };
const MIMES: Record<ArtifactKind, string> = { html: 'text/html', markdown: 'text/markdown', mermaid: 'text/plain', svg: 'image/svg+xml' };

/** A safe file name for downloading the source. */
export function downloadName(title: string, version: number, kind: ArtifactKind): string {
  const base = title.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'artifact';
  return `${base}-v${version}.${EXTENSIONS[kind]}`;
}
export const downloadMime = (kind: ArtifactKind) => MIMES[kind];

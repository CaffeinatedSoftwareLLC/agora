import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactCsp, buildSrcDoc, downloadName, sandboxFor } from './frame';

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), version: vi.fn(), render: vi.fn() }));
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()),
  canvasApi: { list: mocks.list, get: mocks.get, version: mocks.version } }));
vi.mock('./mermaid', () => ({ renderMermaid: mocks.render }));

import { CanvasPanel } from './CanvasPanel';
import { ArtifactCard } from './ArtifactCard';
import { useUIStore } from '../../stores/uiStore';
import { useMessageStore } from '../../stores/messageStore';

const A = 'artifact1';
const versionInfo = (version: number, kind = 'html') => ({ version, messageId: `m${version}`, threadId: null, authorUsername: 'builder', authorBot: true,
  title: 'Landing', kind, size: 10, createdAt: '2026-10-19T00:00:00Z' });
let latest = 2;
const content: Record<number, { kind: string; content: string }> = {};

beforeEach(() => {
  latest = 2;
  content[1] = { kind: 'html', content: '<h1>One</h1>' };
  content[2] = { kind: 'html', content: '<h1>Two</h1><script>document.title="x"</script>' };
  mocks.list.mockResolvedValue({ artifacts: [{ id: A, title: 'Landing', kind: 'html', latestVersion: 2, updatedAt: '2026-10-19T00:00:00Z', createdByUsername: 'builder' }] });
  mocks.get.mockImplementation(async () => ({ id: A, title: 'Landing', kind: 'html', latestVersion: latest,
    versions: Array.from({ length: latest }, (_, i) => versionInfo(latest - i, content[latest - i]?.kind)) }));
  mocks.version.mockImplementation(async (_c: string, _a: string, v: number) => ({ artifactId: A, version: v, title: 'Landing', ...content[v],
    authorUsername: 'builder', createdAt: '2026-10-19T00:00:00Z' }));
  mocks.render.mockReset();
  useUIStore.setState({ aux: null, canvas: null, canvasReturn: null });
  useMessageStore.setState({ byChannel: new Map() });
});

describe('the sandboxed document', () => {
  it('puts the CSP first, with no network unless asked', () => {
    const doc = buildSrcDoc('html', '<!doctype html><html><head><script src="https://cdn.example/x.js"></script></head></html>');
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<html>'));
    expect(doc.startsWith('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(artifactCsp(false)).toContain("default-src 'none'");
    expect(artifactCsp(false)).toContain("connect-src 'none'");
    expect(artifactCsp(false)).not.toContain('https:');
    expect(artifactCsp(true)).toContain("img-src data: blob: https:");
    expect(artifactCsp(true)).toContain('connect-src https:');
    expect(buildSrcDoc('svg', '<svg/>')).toContain('<body><svg/></body>');
  });
  it('strips every meta http-equiv from the artifact, so a refresh cannot navigate the frame', () => {
    const tricks = [
      '<meta http-equiv="refresh" content="0;url=https://evil.example/?d=1">',
      '<META HTTP-EQUIV=refresh CONTENT=0;url=https://evil.example/>',
      '<meta content="0;url=https://evil.example/>" http-equiv="refresh">',
      "<meta/http-equiv='&#114;efresh' content='0;url=https://evil.example/'>",
      '<me<meta http-equiv=x>ta http-equiv=refresh content=0;url=https://evil.example/>',
    ];
    for (const t of tricks) {
      const doc = buildSrcDoc('html', `<p>hi</p>${t}`);
      // Only our own CSP meta is left
      expect(doc.match(/http-equiv/gi), t).toHaveLength(1);
      expect(doc).not.toContain('evil.example/"');
    }
    expect(buildSrcDoc('html', '<meta name="viewport" content="x"><metadata>')).toContain('<meta name="viewport" content="x"><metadata>');
    expect(buildSrcDoc('svg', '<svg><meta http-equiv="refresh" content="0;url=https://evil.example/"/></svg>')).toContain('<svg></svg>');
  });
  it('lets only HTML run scripts, never with same-origin', () => {
    expect(sandboxFor('html')).toBe('allow-scripts');
    expect(sandboxFor('svg')).toBe('');
    expect(sandboxFor('mermaid')).toBe('');
  });
  it('names downloads safely', () => {
    expect(downloadName('../../etc/Landing page!', 3, 'html')).toBe('etc-Landing-page-v3.html');
    expect(downloadName('***', 1, 'markdown')).toBe('artifact-v1.md');
  });
});

describe('canvas pane', () => {
  it('lists the channel artifacts and opens one', async () => {
    useUIStore.getState().openCanvas({ channelId: 'c1', artifactId: null, version: null });
    render(<CanvasPanel />);
    fireEvent.click(await screen.findByText('Landing'));
    expect(useUIStore.getState().canvas).toEqual({ channelId: 'c1', artifactId: A, version: null });
    expect(mocks.list).toHaveBeenCalledWith('c1');
  });

  it('renders the latest version in a sandboxed frame and switches versions', async () => {
    useUIStore.getState().openCanvas({ channelId: 'c1', artifactId: A, version: null });
    const { container } = render(<CanvasPanel />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Two</h1>');
    expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'");
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1' } });
    expect(useUIStore.getState().canvas?.version).toBe(1);
    await waitFor(() => expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('<h1>One</h1>'));
    fireEvent.click(screen.getByText('Go to latest (v2)'));
    expect(useUIStore.getState().canvas?.version).toBeNull();
  });

  it('shows the source, and turns network on only when asked', async () => {
    useUIStore.getState().openCanvas({ channelId: 'c1', artifactId: A, version: null });
    const { container } = render(<CanvasPanel />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByText('Network off'));
    expect(confirm.mock.calls[0][0]).toContain('send data to the internet');
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).not.toContain('connect-src https:');
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByText('Network off'));
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('connect-src https:');
    fireEvent.click(screen.getByText('Source'));
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('pre')!.textContent).toBe(content[2].content);
  });

  it('catches up when a newer version is posted in chat', async () => {
    useUIStore.getState().openCanvas({ channelId: 'c1', artifactId: A, version: null });
    const { container } = render(<CanvasPanel />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<h1>Two</h1>'));
    latest = 3; content[3] = { kind: 'html', content: '<h1>Three</h1>' };
    act(() => {
      useMessageStore.setState({ byChannel: new Map([['c1', [{ id: 'm3', content: null, authorId: 'b', authorUsername: 'builder', channelId: 'c1',
        createdAt: '', artifact: { id: A, version: 3, title: 'Landing', kind: 'html', latestVersion: 3 } } as never]]]) });
    });
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<h1>Three</h1>'));
  });

  it('resets the frame when the artifact navigates itself away', async () => {
    useUIStore.getState().openCanvas({ channelId: 'c1', artifactId: A, version: null });
    const { container } = render(<CanvasPanel />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    // The document's own load (jsdom fires one when the frame is inserted) is not a navigation
    expect(screen.queryByText(/tried to open another page/)).toBeNull();
    const frame = container.querySelector('iframe')!;
    fireEvent.load(frame); fireEvent.load(frame);
    expect(screen.getByText(/tried to open another page/)).toBeTruthy();
    fireEvent.click(screen.getByText('Reload it'));
    expect(container.querySelector('iframe')).toBeTruthy();
  });

  it('renders Markdown without raw HTML or remote images, and Mermaid as a script-free frame', async () => {
    content[1] = { kind: 'markdown', content: '# Plan\n\n<script>alert(1)</script>\n\n![tracker](https://evil.example/p.png)' };
    latest = 1;
    useUIStore.getState().openCanvas({ channelId: 'c1', artifactId: A, version: null });
    const { container, unmount } = render(<CanvasPanel />);
    await screen.findByText('Plan');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('[image: tracker, network off]')).toBeTruthy();
    unmount();

    content[1] = { kind: 'mermaid', content: 'graph TD; A-->B' };
    mocks.render.mockResolvedValue('<svg id="d"><g/></svg>');
    const view = render(<CanvasPanel />);
    await waitFor(() => expect(view.container.querySelector('iframe')).toBeTruthy());
    expect(mocks.render).toHaveBeenCalledWith('graph TD; A-->B');
    expect(view.container.querySelector('iframe')!.getAttribute('sandbox')).toBe('');
    expect(view.container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('<svg id="d">');
  });

  // beta-test-plan §6.2 "Canvas sandbox": no form submit, no popups or top navigation, SVG can't script
  it('blocks form submits and base changes, and gives the HTML frame no popup, form, top-navigation or same-origin rights', async () => {
    for (const network of [false, true]) {
      expect(artifactCsp(network)).toContain("form-action 'none'");
      expect(artifactCsp(network)).toContain("base-uri 'none'");
    }
    useUIStore.getState().openCanvas({ channelId: 'c1', artifactId: A, version: null });
    const { container } = render(<CanvasPanel />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    const tokens = container.querySelector('iframe')!.getAttribute('sandbox')!.split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(['allow-scripts']);
    for (const right of ['allow-popups', 'allow-forms', 'allow-top-navigation', 'allow-same-origin', 'allow-modals', 'allow-popups-to-escape-sandbox'])
      expect(tokens).not.toContain(right);
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain("form-action 'none'");
  });

  it('renders an SVG artifact in a frame that cannot run scripts', async () => {
    content[1] = { kind: 'svg', content: '<svg onload="parent.document.title=1"><script>document.cookie="x=1"</script></svg>' };
    latest = 1;
    useUIStore.getState().openCanvas({ channelId: 'c1', artifactId: A, version: null });
    const { container } = render(<CanvasPanel />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    const frame = container.querySelector('iframe')!;
    expect(frame.hasAttribute('sandbox')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
  });

  it('goes back to the thread it was opened from', () => {
    useUIStore.setState({ aux: 'thread' });
    useUIStore.getState().openCanvas({ channelId: 'c1', artifactId: A, version: null });
    expect(useUIStore.getState().aux).toBe('canvas');
    useUIStore.getState().closeAux();
    expect(useUIStore.getState().aux).toBe('thread');
    useUIStore.getState().closeAux();
    expect(useUIStore.getState().aux).toBeNull();
  });
});

describe('artifact card', () => {
  it('follows the latest version from the newest post, and pins an older one', () => {
    const { rerender } = render(<ArtifactCard channelId="c1" artifact={{ id: A, version: 2, title: 'Landing', kind: 'html', latestVersion: 2 }} />);
    expect(screen.getByText('HTML · v2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Landing in the canvas' }));
    expect(useUIStore.getState().canvas).toEqual({ channelId: 'c1', artifactId: A, version: null });
    rerender(<ArtifactCard channelId="c1" artifact={{ id: A, version: 1, title: 'Landing', kind: 'html', latestVersion: 2 }} />);
    expect(screen.getByText('HTML · v1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Landing in the canvas' }));
    expect(useUIStore.getState().canvas?.version).toBe(1);
  });
});

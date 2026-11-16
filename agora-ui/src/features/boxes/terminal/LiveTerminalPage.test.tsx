/* eslint-disable @typescript-eslint/no-explicit-any -- the fakes stand in for xterm and Socket.IO */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, ApiError } from '../../../lib/api';
import type { LiveInfo } from './liveRules';

const { terms, sockets, FakeTerm, FakeFit, FakeSocket } = vi.hoisted(() => {
  const terms: any[] = [];
  class FakeTerm {
    cols = 120; rows = 32; options: any;
    written: Uint8Array[] = []; addons: unknown[] = []; disposed = false; focused = false; resized: Array<[number, number]> = [];
    handlers: Record<string, (...a: any[]) => void> = {};
    constructor(options: any) { this.options = options; terms.push(this); }
    loadAddon(a: unknown) { this.addons.push(a); }
    open() {}
    focus() { this.focused = true; }
    write(d: Uint8Array) { this.written.push(d); }
    resize(c: number, r: number) { this.cols = c; this.rows = r; this.resized.push([c, r]); }
    dispose() { this.disposed = true; }
    onData(cb: any) { this.handlers.data = cb; }
    onBinary(cb: any) { this.handlers.binary = cb; }
    onTitleChange(cb: any) { this.handlers.title = cb; }
  }
  class FakeFit { fit() {} }
  class FakeSocket {
    connected = false; sessionId: string; emitted: Array<[string, unknown]> = []; handlers: Record<string, (...a: any[]) => void> = {};
    constructor(sessionId: string) { this.sessionId = sessionId; }
    on(e: string, cb: (...a: any[]) => void) { this.handlers[e] = cb; return this; }
    emit(e: string, p?: unknown) { this.emitted.push([e, p]); return this; }
    connect() { queueMicrotask(() => { this.connected = true; this.handlers.connect?.(); }); }
    disconnect() { this.connected = false; }
    fire(e: string, ...a: any[]) { this.handlers[e]?.(...a); }
  }
  return { terms, sockets: [] as FakeSocket[], FakeTerm, FakeFit, FakeSocket };
});
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerm }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFit }));
vi.mock('../../../lib/socketFactory', () => ({ createLiveSocket: (id: string) => { const s = new FakeSocket(id); sockets.push(s); return s; } }));

import { LiveTerminalPage } from './LiveTerminalPage';

const S = 'S'.repeat(26), SID = 'L'.repeat(26);
const info = (over: Partial<LiveInfo> = {}): LiveInfo => ({
  sessionId: SID, profile: 'cc', channelId: 'C'.repeat(26), channelName: 'general', role: 'owner', canType: true, state: 'idle', note: null,
  controlsBy: null, held: false, hostConnected: true, needsUpdate: false, tokensMeasured: false, wakesUsed: 0, ...over,
});
const ready = (over: object = {}) => ({ role: 'owner', state: 'idle', note: null, cols: 100, rows: 30, controlsBy: null, held: false, ...over });
const renderPage = () => render(
  <MemoryRouter initialEntries={[`/live-terminal/${S}/${SID}`]}><Routes><Route path="/live-terminal/:serverId/:sessionId" element={<LiveTerminalPage />} /></Routes></MemoryRouter>);
const connect = async (over: object = {}) => {
  renderPage();
  await waitFor(() => expect(sockets).toHaveLength(1));
  await waitFor(() => expect(sockets[0].connected).toBe(true));
  act(() => sockets[0].fire('live:ready', ready(over)));
  return sockets[0];
};
/** The owner presses a key: a gesture, then the terminal widget's data */
const type = (term: any, data: string) => { fireEvent.keyDown(screen.getByTestId('live-terminal-container'), { key: 'a' }); term.handlers.data(data); };
const sent = (s: any, event: string) => s.emitted.filter(([e]: [string]) => e === event).map(([, p]: [string, unknown]) => p);

let get: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  terms.length = 0; sockets.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  get = vi.spyOn(api, 'get').mockResolvedValue(info());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('says in its own chrome that this is the agent\'s terminal, not the owner\'s shell', async () => {
  await connect();
  expect(get).toHaveBeenCalledWith(`/servers/${S}/live-terminals/${SID}`);
  expect(screen.getByTestId('live-agent-badge')).toHaveTextContent("cc's terminal");
  expect(screen.getByTestId('live-terminal-title')).toHaveTextContent("The agent's own terminal, not your shell");
  expect(screen.getByTestId('live-state')).toHaveTextContent('Idle');
  expect(screen.getByTestId('live-footnote')).toHaveTextContent('Token use is not measured in live terminal mode');
  expect(sockets[0].sessionId).toBe(SID);
});

it('explains a refusal without saying whether the session exists', async () => {
  get.mockRejectedValue(new ApiError(404, 'not_found'));
  renderPage();
  expect(await screen.findByTestId('live-blocked')).toHaveTextContent('Only the server owner and people who can direct agents');
  expect(sockets).toHaveLength(0);
});

it('a box that needs its update and a box that is not connected are not connected to', async () => {
  get.mockResolvedValue(info({ needsUpdate: true }));
  renderPage();
  expect(await screen.findByTestId('live-blocked')).toHaveTextContent('needs its update first');
  cleanup();
  get.mockResolvedValue(info({ hostConnected: false }));
  renderPage();
  expect(await screen.findByTestId('live-blocked')).toHaveTextContent('not connected');
  expect(sockets).toHaveLength(0);
});

it('draws the replay first, then live output, at the size the server names', async () => {
  const s = await connect({ cols: 90, rows: 28 });
  act(() => { s.fire('live:replay', new Uint8Array([104, 105])); s.fire('live:output', new Uint8Array([33])); });
  expect(terms[0].resized[0]).toEqual([90, 28]);
  expect(terms[0].written.map((b: Uint8Array) => Buffer.from(b).toString())).toEqual(['hi', '!']);
  act(() => s.fire('live:size', { cols: 80, rows: 24 }));
  expect(terms[0].resized[1]).toEqual([80, 24]);
});

it('shows the states the box reports, and what a startup prompt or a dialog needs', async () => {
  const s = await connect();
  act(() => s.fire('live:state', { state: 'waiting', note: 'no_signal' }));
  expect(screen.getByTestId('live-state')).toHaveTextContent('Waiting on you');
  expect(screen.getByTestId('live-note')).toHaveTextContent('probably showing a startup prompt');
  act(() => s.fire('live:state', { state: 'working', note: null }));
  expect(screen.getByTestId('live-state')).toHaveTextContent('Working');
  expect(screen.queryByTestId('live-note')).toBeNull();
  act(() => s.fire('live:state', { state: 'idle', note: 'channel_unavailable' }));
  expect(screen.getByTestId('live-note')).toHaveTextContent('chat messages cannot reach it');
  expect(screen.getByTestId('live-note')).toHaveTextContent('not typed into this terminal');
});

it('sends nothing before the owner has confirmed, whatever is typed', async () => {
  const s = await connect();
  type(terms[0], 'ls\r');
  expect(sent(s, 'live:input')).toEqual([]);
  expect(sent(s, 'live:take')).toEqual([]);
});

it('the owner takes the keyboard only after reading that the agent sees whatever is typed', async () => {
  const s = await connect();
  fireEvent.click(screen.getByTestId('live-take'));
  const dialog = screen.getByTestId('live-confirm');
  expect(dialog).toHaveTextContent("This is cc's terminal, not your own shell");
  expect(dialog).toHaveTextContent('Whatever you type here, the agent sees it');
  expect(dialog).toHaveTextContent('chat messages to cc are held');
  expect(sent(s, 'live:take')).toEqual([]);
  fireEvent.click(screen.getByTestId('live-confirm-take'));
  expect(sent(s, 'live:take')).toEqual([{ ack: true }]);
  // Still not typing until the server confirms
  type(terms[0], 'x');
  expect(sent(s, 'live:input')).toEqual([]);
  act(() => s.fire('live:taken'));
  expect(terms[0].focused).toBe(true);
  type(terms[0], 'ls\r');
  expect(sent(s, 'live:input')).toEqual(['ls\r']);
});

it('drops the widget\'s automatic answers to queries the screen printed; only gestures become input', async () => {
  const s = await connect();
  act(() => s.fire('live:taken'));
  // No browser event of the owner's: this is a reply to a query
  terms[0].handlers.data('\x1b[?1;2c');
  expect(sent(s, 'live:input')).toEqual([]);
  expect(sent(s, 'live:reply')).toEqual([]);
  type(terms[0], 'y');
  expect(sent(s, 'live:input')).toEqual(['y']);
});

it('shows the owner that they have the controls while messages are held, and a limit hold as its own thing', async () => {
  const s = await connect();
  act(() => s.fire('live:taken'));
  act(() => s.fire('live:controls', { by: 'eryk', held: true, reason: 'controls' }));
  expect(screen.getByTestId('live-controls')).toHaveTextContent('You have the controls');
  expect(screen.getByTestId('live-controls')).toHaveTextContent('held while you type');
  act(() => s.fire('live:controls', { by: null, held: false, reason: null }));
  expect(screen.queryByTestId('live-controls')).toBeNull();
  act(() => s.fire('live:controls', { by: null, held: true, reason: 'wake_limit' }));
  expect(screen.getByTestId('live-limit')).toHaveTextContent('wake limit');
});

it('a watcher has no way to type, resize or take the keyboard, and the page says so', async () => {
  const s = await connect({ role: 'watcher' });
  expect(screen.getByTestId('live-readonly')).toHaveTextContent('Only the server owner can type here');
  expect(screen.queryByTestId('live-take')).toBeNull();
  type(terms[0], 'rm -rf /\r');
  // Even if the widget produced data, nothing is emitted by a watcher's page
  act(() => s.fire('live:taken'));
  expect(sent(s, 'live:take')).toEqual([]);
  expect(sent(s, 'live:resize')).toEqual([]);
});

it('never writes the clipboard, changes the title, follows links or answers window queries', async () => {
  await connect();
  const t = terms[0];
  expect(t.addons).toHaveLength(1); // the fit addon only: no clipboard, no web-links addon
  expect(t.options.windowOptions).toEqual({});
  expect(t.options.allowProposedApi).toBe(false);
  document.title = 'Agora';
  t.handlers.title('evil title');
  expect(document.title).toBe('Agora');
  expect(t.options.linkHandler.activate({}, 'https://evil.example')).toBeUndefined();
  expect(t.options.linkHandler.allowNonHttpProtocols).toBe(false);
});

it('tells the person why they were disconnected, and the box\'s end of it', async () => {
  const s = await connect();
  act(() => s.fire('live:exit', { reason: 'session_ended' }));
  expect(await screen.findByTestId('live-ended')).toHaveTextContent('The session ended');
  expect(terms[0].disposed).toBe(true);
  cleanup();
  sockets.length = 0; terms.length = 0;
  renderPage();
  await waitFor(() => expect(sockets).toHaveLength(1));
  act(() => sockets[0].fire('connect_error', new Error('forbidden')));
  expect(await screen.findByTestId('live-ended')).toHaveTextContent('may watch');
});

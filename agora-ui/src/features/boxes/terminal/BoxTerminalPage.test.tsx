/* eslint-disable @typescript-eslint/no-explicit-any -- the fakes stand in for xterm and Socket.IO */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../../../lib/api';
import { boxApi, type TerminalStatus } from '../api';

// xterm needs a canvas and a layout; the page's use of it is what is tested
const { terms, sockets, FakeTerm, FakeFit, FakeSocket } = vi.hoisted(() => {
  const terms: any[] = [];
  class FakeTerm {
    cols = 100; rows = 30; options: any;
    written: Uint8Array[] = []; addons: unknown[] = []; disposed = false; focused = false;
    handlers: Record<string, (...a: any[]) => void> = {};
    constructor(options: any) { this.options = options; terms.push(this); }
    loadAddon(a: unknown) { this.addons.push(a); }
    open() {}
    focus() { this.focused = true; }
    write(d: Uint8Array) { this.written.push(d); }
    dispose() { this.disposed = true; }
    onData(cb: any) { this.handlers.data = cb; }
    onBinary(cb: any) { this.handlers.binary = cb; }
    onResize(cb: any) { this.handlers.resize = cb; }
    onTitleChange(cb: any) { this.handlers.title = cb; }
  }
  class FakeFit { fit() {} }
  class FakeSocket {
    connected = false; ticket: string; emitted: Array<[string, unknown]> = []; handlers: Record<string, (...a: any[]) => void> = {};
    constructor(ticket: string) { this.ticket = ticket; }
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
vi.mock('../../../lib/socketFactory', () => ({ createShellSocket: (t: string) => { const s = new FakeSocket(t); sockets.push(s); return s; } }));

import { BoxTerminalPage } from './BoxTerminalPage';

const ID = 'B'.repeat(26);
const status = (over: Partial<TerminalStatus> = {}): TerminalStatus => ({
  box: { id: ID, name: 'builder', adapter: 'claude' }, supported: true, hostConnected: true, running: true, open: null, activeRun: false,
  limits: { idleMinutes: 15, maxHours: 8, rateKbps: 512 }, ...over,
});
const renderPage = () => render(
  <MemoryRouter initialEntries={[`/terminal/${ID}`]}><Routes><Route path="/terminal/:boxId" element={<BoxTerminalPage />} /></Routes></MemoryRouter>);
const fillPassword = (v = 'TestPass123!') => fireEvent.change(screen.getByLabelText(/Your password/), { target: { value: v } });

let getStatus: ReturnType<typeof vi.spyOn>;
let ticket: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  terms.length = 0; sockets.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  getStatus = vi.spyOn(boxApi, 'terminalStatus').mockResolvedValue(status());
  ticket = vi.spyOn(boxApi, 'terminalTicket').mockResolvedValue({ ticket: 'T'.repeat(43), expiresInSeconds: 30, activeRun: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('says who may open one when the server refuses the owner check', async () => {
  getStatus.mockRejectedValue(new ApiError(403, 'forbidden'));
  renderPage();
  expect(await screen.findByTestId('terminal-blocked')).toHaveTextContent('Only the server owner');
  expect(screen.queryByLabelText(/Your password/)).toBeNull();
});

it('a box that has not got the terminal yet says it needs its update first, and offers no way in', async () => {
  getStatus.mockResolvedValue(status({ supported: false, hostConnected: false }));
  renderPage();
  expect(await screen.findByTestId('terminal-blocked')).toHaveTextContent('needs its update first');
  expect(screen.queryByLabelText(/Your password/)).toBeNull();
  expect(ticket).not.toHaveBeenCalled();
});

it('a stopped box and a box that is not connected are not offered a terminal', async () => {
  getStatus.mockResolvedValue(status({ running: false }));
  renderPage();
  expect(await screen.findByTestId('terminal-blocked')).toHaveTextContent('not running');
  cleanup();
  getStatus.mockResolvedValue(status({ hostConnected: false }));
  renderPage();
  expect(await screen.findByTestId('terminal-blocked')).toHaveTextContent('not connected');
});

it('tells the owner what it means before asking for the password, and shows the limits', async () => {
  getStatus.mockResolvedValue(status({ activeRun: true }));
  renderPage();
  const confirm = await screen.findByTestId('terminal-confirm');
  expect(screen.getByTestId('terminal-box-name')).toHaveTextContent('Terminal in builder');
  expect(confirm).toHaveTextContent('15 minutes without a keystroke');
  expect(confirm).toHaveTextContent('8 hours at most');
  expect(confirm).toHaveTextContent('512 KiB a second');
  expect(confirm).toHaveTextContent('a run in progress keeps going');
  expect(confirm).toHaveTextContent('not stored or logged');
  expect(screen.getByRole('button', { name: 'Open terminal' })).toBeDisabled();
  expect(screen.queryByTestId('terminal-takeover')).toBeNull();
});

it('a wrong password gets no terminal, says so and clears the field', async () => {
  ticket.mockRejectedValue(new ApiError(403, 'reauth_failed'));
  renderPage();
  await screen.findByTestId('terminal-confirm');
  fillPassword('nope');
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  expect(await screen.findByText('That password is not right.')).toBeInTheDocument();
  expect((screen.getByLabelText(/Your password/) as HTMLInputElement).value).toBe('');
  expect(sockets).toHaveLength(0);
  expect(ticket).toHaveBeenCalledWith(ID, 'nope', false);
});

it('opening: ticket, its own socket, the size, the shell, typing, output, resize and close', async () => {
  renderPage();
  await screen.findByTestId('terminal-confirm');
  fillPassword();
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  expect(sockets[0].ticket).toBe('T'.repeat(43));
  expect(ticket).toHaveBeenCalledWith(ID, 'TestPass123!', false);
  // The password is not kept once the ticket is taken
  await waitFor(() => expect(sockets[0].emitted.some(([e]) => e === 'shell:start')).toBe(true));
  expect(sockets[0].emitted.find(([e]) => e === 'shell:start')![1]).toEqual({ cols: 100, rows: 30 });

  act(() => sockets[0].fire('shell:ready', { limits: { idleMinutes: 15, maxHours: 8, rateKbps: 512 } }));
  expect(await screen.findByTestId('terminal-live')).toBeInTheDocument();
  expect(screen.getByTestId('terminal-limits')).toHaveTextContent('15 min without a keystroke');
  const term = terms[0];
  expect(term.focused).toBe(true);

  act(() => sockets[0].fire('shell:output', new Uint8Array([104, 105]).buffer));
  expect(Array.from(term.written[0])).toEqual([104, 105]);
  term.handlers.data('ls\r');
  term.handlers.binary('\xff\x01');
  term.handlers.resize({ cols: 120, rows: 40 });
  const sent = sockets[0].emitted.filter(([e]) => e !== 'shell:start');
  expect(sent[0]).toEqual(['shell:input', 'ls\r']);
  expect(Array.from(sent[1][1] as Uint8Array)).toEqual([255, 1]);
  expect(sent[2]).toEqual(['shell:resize', { cols: 120, rows: 40 }]);

  fireEvent.click(screen.getByRole('button', { name: 'Close terminal' }));
  expect(sockets[0].emitted.at(-1)).toEqual(['shell:close', undefined]);
  act(() => sockets[0].fire('shell:exit', { reason: 'closed_by_owner' }));
  const ended = await screen.findByTestId('terminal-ended');
  expect(ended).toHaveTextContent('You closed the terminal.');
  expect(term.disposed).toBe(true);
  expect(sockets[0].connected).toBe(false);
});

it('a large paste goes in pieces the server accepts, never splitting a character', async () => {
  renderPage();
  await screen.findByTestId('terminal-confirm');
  fillPassword();
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  await waitFor(() => expect(sockets[0].connected).toBe(true));
  act(() => sockets[0].fire('shell:ready', {}));
  // 20,000 characters: the 16,384th is the first half of an emoji
  const text = 'a'.repeat(16383) + '\u{1F600}' + 'b'.repeat(3600);
  terms[0].handlers.data(text);
  const pieces = sockets[0].emitted.filter(([e]) => e === 'shell:input').map(([, p]) => p as string);
  expect(pieces.length).toBe(2);
  expect(pieces.join('')).toBe(text);
  expect(pieces.every(p => p.length <= 16384)).toBe(true);
  expect(pieces[0].endsWith('a')).toBe(true);
});

it('a terminal that ended for a limit says which', async () => {
  renderPage();
  await screen.findByTestId('terminal-confirm');
  fillPassword();
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  act(() => sockets[0].fire('shell:ready', {}));
  act(() => sockets[0].fire('shell:exit', { reason: 'idle_timeout' }));
  expect(await screen.findByTestId('terminal-ended')).toHaveTextContent('nothing was typed for the idle limit');
  getStatus.mockResolvedValue(status());
  fireEvent.click(screen.getByRole('button', { name: 'Open a new terminal' }));
  expect(await screen.findByTestId('terminal-confirm')).toBeInTheDocument();
});

it('a refused ticket at the socket ends it with a plain sentence', async () => {
  renderPage();
  await screen.findByTestId('terminal-confirm');
  fillPassword();
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  act(() => sockets[0].fire('connect_error', new Error('ticket_invalid')));
  expect(await screen.findByTestId('terminal-ended')).toHaveTextContent('single-use');
});

it('a terminal open elsewhere is shown, and opening takes it over', async () => {
  getStatus.mockResolvedValue(status({ open: { id: 'S', openedByName: 'eryk', openedAt: '2026-11-13T10:00:00Z', mine: true } }));
  renderPage();
  expect(await screen.findByTestId('terminal-takeover')).toHaveTextContent('opened by eryk');
  fillPassword();
  fireEvent.click(screen.getByRole('button', { name: 'Close that one and open here' }));
  await waitFor(() => expect(ticket).toHaveBeenCalledWith(ID, 'TestPass123!', true));
});

it('what the shell prints cannot reach the clipboard, the page title or a link', async () => {
  document.title = 'Agora';
  renderPage();
  await screen.findByTestId('terminal-confirm');
  fillPassword();
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  await waitFor(() => expect(terms).toHaveLength(1));
  const term = terms[0];
  // Only the fit addon is loaded: no clipboard addon (OSC 52 is ignored), no web-links addon
  expect(term.addons).toHaveLength(1);
  expect(term.addons[0]).toBeInstanceOf(FakeFit);
  // A title the shell sets changes nothing
  term.handlers.title('pwned');
  expect(document.title).toBe('Agora');
  // A link the shell prints is never followed, and nothing is opened
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  term.options.linkHandler.activate(new MouseEvent('click'), 'https://evil.example', {});
  expect(open).not.toHaveBeenCalled();
  expect(term.options.linkHandler.allowNonHttpProtocols).toBe(false);
  expect(term.options.allowProposedApi).toBe(false);
});

it('leaving the page ends the shell: the socket is dropped and the widget disposed', async () => {
  const view = renderPage();
  await screen.findByTestId('terminal-confirm');
  fillPassword();
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  view.unmount();
  expect(sockets[0].connected).toBe(false);
  expect(terms[0].disposed).toBe(true);
});

it('the phone toolbar sends the keys a soft keyboard lacks', async () => {
  renderPage();
  await screen.findByTestId('terminal-confirm');
  fillPassword();
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  await waitFor(() => expect(sockets[0].connected).toBe(true));
  act(() => sockets[0].fire('shell:ready', {}));
  fireEvent.click(await screen.findByRole('button', { name: 'Ctrl-C' }));
  fireEvent.click(screen.getByRole('button', { name: '↑' }));
  const inputs = sockets[0].emitted.filter(([e]) => e === 'shell:input').map(([, p]) => p);
  expect(inputs).toEqual(['\x03', '\x1b[A']);
});

it('the page imports nothing that renders what a user wrote: no messages, channels, stores or the chat socket', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('src/features/boxes/terminal/BoxTerminalPage.tsx', 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]);
  expect(imports.filter(i => /messages|stores|SocketProvider|shell\/|servers\/|markdown|Message/i.test(i))).toEqual([]);
  expect(imports).toEqual(expect.arrayContaining(['@xterm/xterm', '@xterm/addon-fit']));
});

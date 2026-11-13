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
    modes = { bracketedPasteMode: false }; pasted: string[] = [];
    paste(t: string) { this.pasted.push(t); }
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
  expect(confirm).toHaveTextContent('a run already working keeps going');
  expect(confirm).toHaveTextContent('not stored or logged');
  // The sharing warning is on the page, not behind a link, and the old safety claim is gone
  for (const line of [
    'in the same box, as the same user, as an autonomous agent that may be running now',
    'can read or change what you type and what you see',
    'It can show a fake prompt. Agora asks for your password only on this page',
    'Do not type passwords, tokens, login codes or git credentials you would not give the agent',
    'New wakes for this agent are paused while the terminal is open',
    'anything started with setsid, nohup or disown keeps running',
    'that key is in this shell',
  ]) expect(confirm).toHaveTextContent(line);
  expect(confirm.textContent).not.toContain('reaches nothing more than the agent can');
  expect(confirm.querySelectorAll('li').length).toBeLessThanOrEqual(10);
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
  expect(screen.getByTestId('terminal-shared-warning')).toHaveTextContent('You share this box with the agent. Treat what you type as visible to it.');

  act(() => sockets[0].fire('shell:output', new Uint8Array([104, 105]).buffer));
  expect(Array.from(term.written[0])).toEqual([104, 105]);
  // The owner types: a key event, then the data it produces
  fireEvent.keyDown(screen.getByTestId('terminal-container'));
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
  fireEvent.keyDown(screen.getByTestId('terminal-container'));
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

async function openLive() {
  renderPage();
  await screen.findByTestId('terminal-confirm');
  fillPassword();
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  await waitFor(() => expect(sockets[0].connected).toBe(true));
  act(() => sockets[0].fire('shell:ready', {}));
  return terms[0];
}

it('the widget\'s own answers are sent as replies and the owner\'s keys, paste and touches as input', async () => {
  const term = await openLive();
  const box = screen.getByTestId('terminal-container');
  // A query the shell printed, answered by the widget with no event of the owner's: not activity
  term.handlers.data('\x1b[?1;2c');
  term.handlers.data('\x1b[I');
  // A key, then a paste, then a soft-keyboard composition each make what follows the owner's
  fireEvent.keyDown(box); term.handlers.data('a');
  fireEvent.paste(box); term.handlers.data('pasted');
  fireEvent.compositionEnd(box); term.handlers.data('é');
  const sent = sockets[0].emitted.filter(([e]) => e !== 'shell:start').map(([e, p]) => [e, p]);
  expect(sent).toEqual([
    ['shell:reply', '\x1b[?1;2c'], ['shell:reply', '\x1b[I'],
    ['shell:input', 'a'], ['shell:input', 'pasted'], ['shell:input', 'é'],
  ]);
  // The owner's activity lapses: the next automatic answer is a reply again
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
  term.handlers.data('\x1b[0n');
  expect(sockets[0].emitted.at(-1)).toEqual(['shell:reply', '\x1b[0n']);
});

it('a multi-line paste is asked about when bracketed paste is off, and sent only on yes', async () => {
  const term = await openLive();
  const box = screen.getByTestId('terminal-container');
  const paste = (text: string) => fireEvent.paste(box, { clipboardData: { getData: () => text } });
  // One line goes straight to the widget (no confirm)
  paste('ls -la');
  expect(screen.queryByTestId('terminal-paste-confirm')).toBeNull();
  // Several lines: held back until the owner says so
  paste('rm -rf x\nls\n');
  expect(await screen.findByTestId('terminal-paste-confirm')).toHaveTextContent('each line runs as soon as it arrives');
  expect(term.pasted).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(term.pasted).toEqual([]);
  expect(screen.queryByTestId('terminal-paste-confirm')).toBeNull();
  paste('a\nb');
  fireEvent.click(await screen.findByRole('button', { name: 'Send paste' }));
  expect(term.pasted).toEqual(['a\nb']);
  // With bracketed paste on, the shell can tell a paste from typing: no question
  term.modes.bracketedPasteMode = true;
  paste('x\ny');
  expect(screen.queryByTestId('terminal-paste-confirm')).toBeNull();
});

it('refuses to open on plain http away from localhost, with the reason, and asks the server nothing', async () => {
  vi.stubGlobal('isSecureContext', false);
  vi.stubGlobal('location', { ...window.location, hostname: 'agora.example.com' });
  renderPage();
  expect(await screen.findByTestId('terminal-blocked')).toHaveTextContent('only opens on a secure (https) connection');
  expect(getStatus).not.toHaveBeenCalled();
  expect(screen.queryByLabelText(/Your password/)).toBeNull();
});

it('plain http on localhost is allowed, and a secure page is never blocked', async () => {
  vi.stubGlobal('isSecureContext', false);
  renderPage();
  expect(await screen.findByTestId('terminal-confirm')).toBeInTheDocument();
  cleanup();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('location', { ...window.location, hostname: 'agora.example.com' });
  renderPage();
  expect(await screen.findByTestId('terminal-confirm')).toBeInTheDocument();
});

it('a terminal closed because the connection to the box changed says so', async () => {
  await openLive();
  act(() => sockets[0].fire('shell:exit', { reason: 'host_changed' }));
  expect(await screen.findByTestId('terminal-ended')).toHaveTextContent('connection to the box changed, so the terminal was closed for safety');
});

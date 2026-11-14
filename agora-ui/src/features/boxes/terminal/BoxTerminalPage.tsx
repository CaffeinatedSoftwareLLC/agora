import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Socket } from 'socket.io-client';
import { ApiError } from '../../../lib/api';
import { createShellSocket } from '../../../lib/socketFactory';
import { Button } from '../../../components/ui/Button';
import { boxApi, type TerminalLimits, type TerminalStatus } from '../api';
import { INPUT } from '../boxRules';
import { GESTURE_EVENTS, GESTURE_WINDOW_MS, TOOLBAR_KEYS, binaryToBytes, closeText, inputChunks, needsPasteConfirm, plainHttpProblem, readiness, socketError, ticketError } from './terminalRules';

/**
 * The terminal in a box (docs/box-terminal.md), on a route of its own that renders nothing a
 * user wrote: no messages, no channel names, no agent output. Only the box's name (a fixed
 * pattern) and what the owner types and the shell prints, inside xterm.
 *
 * Opening one is deliberate: the owner reaches this page from the box's card in Settings, reads
 * what it means, and types their password again. The server then issues a 30-second single-use
 * ticket and this page opens its own socket with it. Nothing about a terminal survives the page:
 * leaving it, or closing the tab, ends the shell.
 *
 * Idle time counts only what the owner does. xterm's `onData` carries both the owner's keys and the
 * widget's automatic answers to queries the shell prints (device attributes, cursor position, focus
 * reports), so data is sent as `shell:input` only within a moment of a browser event of the owner's
 * (a key, composition, paste, pointer, wheel or touch: `onKey` alone misses paste, IME and soft
 * keyboards) and as `shell:reply` otherwise. The server writes both to the shell but only the first
 * resets the idle clock.
 *
 * What the terminal widget will not do with what the shell prints: it never writes the clipboard
 * (no clipboard addon, so OSC 52 is ignored), never changes this page's title, never opens a link
 * (OSC 8 links are shown but their activation is a no-op) and never answers a window report.
 */

type Phase = 'loading' | 'blocked' | 'confirm' | 'connecting' | 'live' | 'ended';

const THEME = { background: '#0b0f14', foreground: '#d6deeb', cursor: '#d6deeb', selectionBackground: '#3a4a64' };

export function BoxTerminalPage() {
  const { boxId = '' } = useParams();
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [message, setMessage] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [limits, setLimits] = useState<TerminalLimits | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const gestureAt = useRef(0);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setMessage('');
    const insecure = plainHttpProblem(window.isSecureContext, window.location.hostname);
    if (insecure) { setStatus(null); setMessage(insecure); setPhase('blocked'); return; }
    try {
      const s = await boxApi.terminalStatus(boxId);
      setStatus(s);
      const r = readiness(s);
      if (!r.ready) { setMessage(r.text); setPhase('blocked'); return; }
      setPhase('confirm');
    } catch (err) {
      setStatus(null);
      setMessage(err instanceof ApiError && (err.status === 403 || err.status === 404)
        ? 'Only the server owner can open a terminal, and only on a box that exists.'
        : 'Could not reach Agora.');
      setPhase('blocked');
    }
  }, [boxId]);

  useEffect(() => { void load(); }, [load]);

  const open = async (e: FormEvent) => {
    e.preventDefault();
    if (!status || !password) return;
    setBusy(true);
    setMessage('');
    try {
      const r = await boxApi.terminalTicket(boxId, password, !!status.open);
      setPassword('');
      setTicket(r.ticket);
      setPhase('connecting');
    } catch (err) {
      setPassword('');
      setMessage(ticketError(err));
      // The state may have moved under us (someone closed it, the box restarted)
      if (err instanceof ApiError && err.code !== 'reauth_failed' && err.code !== 'too_many_attempts') void load().then(() => setMessage(ticketError(err)));
    } finally {
      setBusy(false);
    }
  };

  // The terminal and its socket live exactly as long as a ticket's session does
  useEffect(() => {
    if (!ticket || !container.current) return;
    let finished = false;
    const end = (text: string) => {
      if (finished) return;
      finished = true;
      setMessage(text);
      setPhase('ended');
      setTicket(null);
    };
    const term = new Terminal({
      cursorBlink: true, scrollback: 5000, fontSize: 14, convertEol: false, allowProposedApi: false, theme: THEME,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', macOptionIsMeta: true,
      // Links the shell prints are shown, never followed: the default would offer to open them
      linkHandler: { activate: () => {}, allowNonHttpProtocols: false },
      windowOptions: {},
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    fit.fit();
    // A title the shell sets is ignored: nothing the box says changes this page
    term.onTitleChange(() => {});
    termRef.current = term;
    const socket = createShellSocket(ticket);
    socketRef.current = socket;
    const markGesture = () => { gestureAt.current = Date.now(); };
    const box = container.current;
    for (const ev of GESTURE_EVENTS) box.addEventListener(ev, markGesture, true);
    // A multi-line paste into a shell that did not ask for bracketed paste runs line by line at once: ask first
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (needsPasteConfirm(text, !!term.modes?.bracketedPasteMode)) {
        e.preventDefault();
        e.stopPropagation();
        setPendingPaste(text);
      }
    };
    box.addEventListener('paste', onPaste, true);
    const forward = (payload: string | Uint8Array) => {
      const owner = Date.now() - gestureAt.current <= GESTURE_WINDOW_MS;
      socket.emit(owner ? 'shell:input' : 'shell:reply', payload);
    };
    socket.on('connect', () => socket.emit('shell:start', { cols: term.cols, rows: term.rows }));
    socket.on('shell:ready', (m: { limits?: TerminalLimits }) => { setLimits(m?.limits ?? null); setPhase('live'); term.focus(); });
    socket.on('shell:output', (d: ArrayBuffer | Uint8Array) => term.write(new Uint8Array(d)));
    socket.on('shell:exit', (m: { reason?: string }) => end(closeText(m?.reason)));
    socket.on('connect_error', (err: Error) => end(socketError(err.message)));
    socket.on('disconnect', () => end('The connection to Agora ended.'));
    term.onData(d => { if (socket.connected) for (const piece of inputChunks(d)) forward(piece); });
    term.onBinary(b => {
      if (!socket.connected) return;
      const bytes = binaryToBytes(b);
      for (let i = 0; i < bytes.length; i += 16384) forward(bytes.slice(i, i + 16384));
    });
    term.onResize(({ cols, rows }) => { if (socket.connected) socket.emit('shell:resize', { cols, rows }); });
    const observer = new ResizeObserver(() => { try { fit.fit(); } catch { /* not laid out yet */ } });
    observer.observe(container.current);
    socket.connect();
    return () => {
      finished = true;
      for (const ev of GESTURE_EVENTS) box.removeEventListener(ev, markGesture, true);
      box.removeEventListener('paste', onPaste, true);
      observer.disconnect();
      socket.disconnect();
      socketRef.current = null;
      termRef.current = null;
      setPendingPaste(null);
      term.dispose();
    };
  }, [ticket]);

  const close = () => {
    const socket = socketRef.current;
    if (socket?.connected) socket.emit('shell:close');
  };
  const send = (seq: string) => { const s = socketRef.current; if (s?.connected) s.emit('shell:input', seq); };
  const confirmPaste = () => {
    const text = pendingPaste;
    setPendingPaste(null);
    if (text === null) return;
    gestureAt.current = Date.now();
    termRef.current?.paste(text);
    termRef.current?.focus();
  };

  const name = status?.box.name ?? 'this box';
  const takeover = !!status?.open;

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text" data-testid="box-terminal-page">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-4 py-2">
        <span className="text-sm font-semibold" data-testid="terminal-box-name">Terminal in {name}</span>
        {status && <span className="text-xs text-text-muted">{status.box.adapter} box</span>}
        {phase === 'live' && <span className="text-xs text-warn" data-testid="terminal-shared-warning">Your shell is a separate user the agent cannot read or change. What you type in an as-agent session is on the agent&apos;s side.</span>}
        {phase === 'live' && <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-warn" data-testid="terminal-live">live</span>}
        <span className="grow" />
        {(phase === 'live' || phase === 'connecting') && <Button variant="danger" onClick={close} className="min-h-11 md:min-h-9">Close terminal</Button>}
        <Link to="/settings/agents" className="text-xs text-text-muted underline">Back to Settings</Link>
      </header>

      {phase === 'loading' && <p className="p-6 text-sm text-text-muted" role="status">Checking the box…</p>}

      {phase === 'blocked' && (
        <div className="p-6 text-sm" data-testid="terminal-blocked">
          <p role="alert">{message}</p>
          <Button variant="secondary" className="mt-3" onClick={() => void load()}>Check again</Button>
        </div>
      )}

      {phase === 'confirm' && status && (
        <form onSubmit={e => void open(e)} className="flex max-w-xl flex-col gap-3 p-4 text-sm md:p-6" data-testid="terminal-confirm">
          <h1 className="text-base font-semibold">Open a terminal in {name}</h1>
          <ul className="list-disc space-y-1 pl-5 text-text-muted">
            <li>Your shell runs as a separate user in the box (<code>operator</code>), not as the agent. An autonomous agent that may be running now cannot read or change your shell, its terminal or its files.</li>
            <li>Do not run the agent&apos;s code from your own shell. To act as the agent, in its workspace, with its login, use <code>as-agent &lt;command&gt;</code>.</li>
            <li>What you type in an as-agent session is on the agent&apos;s side of the wall: the agent can see it and can show a fake prompt there. Agora asks for your password only on this page, never inside the terminal.</li>
            <li>Never type a password, token, login code or git credential into the box.</li>
            <li>New wakes for this agent are paused while the terminal is open{status.activeRun ? '; a run already working keeps going, so you share the box with it' : '; a run already working keeps going'}. The channel is told that a terminal is open.</li>
            <li>Closing the tab ends the shell; anything started with <code>setsid</code>, <code>nohup</code> or <code>disown</code> keeps running.</li>
            <li>An agent that runs on an API key keeps that key to itself: it is not in your shell, but it is in what <code>as-agent</code> runs.</li>
            <li>
              It closes after {status.limits.idleMinutes} minutes without a keystroke, after {status.limits.maxHours} hours at most, and if the shell prints more than {status.limits.rateKbps} KiB a second. You can change these in the box&apos;s settings.
            </li>
            <li>What you type and what the shell prints is not stored or logged. Who opened it, when, for how long and how many bytes are.</li>
          </ul>
          {takeover && (
            <p className="rounded border border-warn/40 bg-warn/10 p-2 text-warn" role="alert" data-testid="terminal-takeover">
              A terminal is already open on this box{status.open?.openedByName ? ` (opened by ${status.open.openedByName})` : ''}. Opening this one closes that one.
            </p>
          )}
          <label className="flex flex-col gap-1 text-xs font-semibold text-text-muted">Your password, to confirm it is you
            <input className={INPUT} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
          </label>
          {message && <p className="text-danger" role="alert">{message}</p>}
          <div className="flex flex-col gap-2 md:flex-row">
            <Button type="submit" loading={busy} disabled={!password}>{takeover ? 'Close that one and open here' : 'Open terminal'}</Button>
            <Link to="/settings/agents" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 text-[13px] md:min-h-9">Cancel</Link>
          </div>
        </form>
      )}

      {(phase === 'connecting' || phase === 'live') && (
        <>
          <div ref={container} className="min-h-0 flex-1 p-2" style={{ background: THEME.background }} data-testid="terminal-container" aria-label={`Terminal in ${name}`} />
          {pendingPaste !== null && (
            <div className="flex flex-wrap items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn" role="alert" data-testid="terminal-paste-confirm">
              <span>This paste has {pendingPaste.split(/\r\n|\r|\n/).length} lines and the shell did not ask for bracketed paste, so each line runs as soon as it arrives. Send it?</span>
              <Button variant="danger" onClick={confirmPaste} className="min-h-11 md:min-h-8">Send paste</Button>
              <Button variant="secondary" onClick={() => { setPendingPaste(null); termRef.current?.focus(); }} className="min-h-11 md:min-h-8">Cancel</Button>
            </div>
          )}
          {phase === 'connecting' && <p className="px-4 py-1 text-xs text-text-muted" role="status">Starting the shell…</p>}
          {limits && phase === 'live' && (
            <p className="px-4 py-1 text-[11px] text-text-muted" data-testid="terminal-limits">
              Closes after {limits.idleMinutes} min without a keystroke, {limits.maxHours} h at most, output limit {limits.rateKbps} KiB/s.
            </p>
          )}
          <div className="flex flex-wrap gap-1 border-t border-border bg-surface p-1 md:hidden" data-testid="terminal-toolbar">
            {TOOLBAR_KEYS.map(k => (
              <button key={k.label} type="button" title={k.title} onClick={() => send(k.seq)} disabled={phase !== 'live'}
                className="min-h-11 min-w-11 flex-1 rounded border border-border bg-bg px-2 text-sm disabled:opacity-50">{k.label}</button>
            ))}
            <button type="button" onClick={() => container.current?.querySelector('textarea')?.focus()} className="min-h-11 flex-1 rounded border border-border bg-bg px-2 text-sm">Keyboard</button>
          </div>
        </>
      )}

      {phase === 'ended' && (
        <div className="p-6 text-sm" data-testid="terminal-ended">
          <p role="status">{message}</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void load()}>Open a new terminal</Button>
            <Link to="/settings/agents" className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-[13px] md:min-h-9">Back to Settings</Link>
          </div>
        </div>
      )}
    </div>
  );
}

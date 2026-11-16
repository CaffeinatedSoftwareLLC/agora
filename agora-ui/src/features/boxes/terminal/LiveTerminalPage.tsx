import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Socket } from 'socket.io-client';
import { api } from '../../../lib/api';
import { createLiveSocket } from '../../../lib/socketFactory';
import { Button } from '../../../components/ui/Button';
import { GESTURE_EVENTS, GESTURE_WINDOW_MS, TOOLBAR_KEYS, binaryToBytes, inputChunks, plainHttpProblem } from './terminalRules';
import { liveExitText, liveInfoError, liveNoteText, liveSocketError, liveStateLabel, type LiveInfo, type LiveState } from './liveRules';

/**
 * The live terminal of a boxed agent (docs/planning/live-terminals.md), on a route of its own like the
 * owner's box terminal. This is the AGENT's terminal: its interactive CLI, running in its box as the
 * agent's own user. The page says so, in its own chrome, where nothing the screen prints can reach.
 *
 * Everyone who may watch (the server owner, and people who can direct agents in the channel) sees the
 * same screen, at the one size the owner's page last set, letterboxed. Only the owner can type, and
 * only after a deliberate confirmation the first time in a session that says the agent sees whatever
 * is typed. A watcher's page has no way to send a byte: it never emits input or a resize, and the
 * server would drop it if it did.
 *
 * What the page does with what the agent's screen prints: it never writes the clipboard (no clipboard
 * addon, so OSC 52 is ignored), never changes this page's title, never follows a link, and never
 * answers a terminal query: data from the terminal widget is sent only within a moment of a
 * browser event of the owner's (a key, paste, pointer or touch), and the widget's automatic answers
 * to queries the screen printed are dropped, not sent.
 */

type Phase = 'loading' | 'blocked' | 'connecting' | 'live' | 'ended';
const THEME = { background: '#0b0f14', foreground: '#d6deeb', cursor: '#d6deeb', selectionBackground: '#3a4a64' };

export function LiveTerminalPage() {
  const { serverId = '', sessionId = '' } = useParams();
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [message, setMessage] = useState('');
  const [state, setState] = useState<LiveState>('starting');
  const [note, setNote] = useState<string | null>(null);
  const [role, setRole] = useState<'owner' | 'watcher'>('watcher');
  const [controls, setControls] = useState<{ by: string | null; held: boolean; reason: string | null }>({ by: null, held: false, reason: null });
  const [typing, setTyping] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Bumped when a connection should be made; back to 0 when it ends (this is what the connection effect lives on)
  const [connectKey, setConnectKey] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const gestureAt = useRef(0);
  const typingRef = useRef(false);

  const load = useCallback(async () => {
    setPhase('loading');
    setMessage('');
    const insecure = plainHttpProblem(window.isSecureContext, window.location.hostname);
    if (insecure) { setMessage(insecure); setPhase('blocked'); return; }
    try {
      const i = await api.get<LiveInfo>(`/servers/${serverId}/live-terminals/${sessionId}`);
      setInfo(i);
      setState(i.state); setNote(i.note); setRole(i.role);
      if (i.needsUpdate) { setMessage('This agent\'s box needs its update first (its image is older than live terminals). Rebuild the box.'); setPhase('blocked'); return; }
      if (!i.hostConnected) { setMessage('The box is not connected to Agora yet.'); setPhase('blocked'); return; }
      setPhase('connecting');
      setConnectKey(k => k + 1);
    } catch (err) {
      setInfo(null);
      setMessage(liveInfoError(err));
      setPhase('blocked');
    }
  }, [serverId, sessionId]);

  // Checking the session on arrival sets state before it fetches: the page starts in 'loading' and this is what leaves it
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  // The terminal and its socket live exactly as long as the page is connected
  useEffect(() => {
    if (connectKey === 0 || !container.current) return;
    let finished = false;
    const end = (text: string) => {
      if (finished) return;
      finished = true;
      setMessage(text);
      setPhase('ended');
      setConnectKey(0);
      setTyping(false); typingRef.current = false;
    };
    const term = new Terminal({
      cursorBlink: true, scrollback: 5000, fontSize: 14, convertEol: false, allowProposedApi: false, theme: THEME,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', macOptionIsMeta: true,
      linkHandler: { activate: () => {}, allowNonHttpProtocols: false },
      windowOptions: {},
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    term.onTitleChange(() => {});
    termRef.current = term; fitRef.current = fit;
    const socket = createLiveSocket(sessionId);
    socketRef.current = socket;
    const markGesture = () => { gestureAt.current = Date.now(); };
    const box = container.current;
    for (const ev of GESTURE_EVENTS) box.addEventListener(ev, markGesture, true);
    socket.on('live:ready', (m: { role: 'owner' | 'watcher'; state: LiveState; note: string | null; cols: number; rows: number; controlsBy: string | null; held: boolean }) => {
      setRole(m.role); setState(m.state); setNote(m.note);
      setControls({ by: m.controlsBy, held: m.held, reason: null });
      term.resize(m.cols, m.rows);
      setPhase('live');
    });
    // The replay (what is on the screen now) comes first, then live output
    socket.on('live:replay', (d: ArrayBuffer | Uint8Array) => term.write(new Uint8Array(d)));
    socket.on('live:output', (d: ArrayBuffer | Uint8Array) => term.write(new Uint8Array(d)));
    socket.on('live:state', (m: { state: LiveState; note: string | null }) => { setState(m.state); setNote(m.note); });
    socket.on('live:size', (m: { cols: number; rows: number }) => { if (!typingRef.current) term.resize(m.cols, m.rows); });
    socket.on('live:controls', (m: { by: string | null; held: boolean; reason: string | null }) => setControls(m));
    socket.on('live:taken', () => {
      typingRef.current = true; setTyping(true); setConfirming(false);
      // The owner's page sets the one authoritative size: the screen is fitted to this window
      try { fit.fit(); } catch { /* not laid out yet */ }
      term.focus();
    });
    socket.on('live:exit', (m: { reason?: string }) => end(liveExitText(m?.reason)));
    socket.on('connect_error', (err: Error) => end(liveSocketError(err.message)));
    socket.on('disconnect', () => end('The connection to Agora ended.'));
    // Only the owner who confirmed can send anything; automatic answers to queries (no recent gesture) are dropped
    const forward = (payload: string | Uint8Array) => {
      if (!typingRef.current || !socket.connected) return;
      if (Date.now() - gestureAt.current > GESTURE_WINDOW_MS) return;
      socket.emit('live:input', payload);
    };
    term.onData(d => { for (const piece of inputChunks(d)) forward(piece); });
    term.onBinary(b => { const bytes = binaryToBytes(b); for (let i = 0; i < bytes.length; i += 16384) forward(bytes.slice(i, i + 16384)); });
    const observer = new ResizeObserver(() => {
      if (!typingRef.current) return;
      try { fit.fit(); const { cols, rows } = term; if (socket.connected) socket.emit('live:resize', { cols, rows }); } catch { /* not laid out yet */ }
    });
    observer.observe(container.current);
    socket.connect();
    return () => {
      finished = true;
      for (const ev of GESTURE_EVENTS) box.removeEventListener(ev, markGesture, true);
      observer.disconnect();
      socket.disconnect();
      socketRef.current = null; termRef.current = null; fitRef.current = null;
      typingRef.current = false;
      term.dispose();
    };
  }, [connectKey, sessionId]);

  const take = () => { const s = socketRef.current; if (s?.connected) s.emit('live:take', { ack: true }); };
  const send = (seq: string) => { const s = socketRef.current; if (typingRef.current && s?.connected) s.emit('live:input', seq); };
  const name = info?.profile ?? 'this agent';
  const live = phase === 'live' || phase === 'connecting';
  const youHaveControls = typing && controls.held && controls.reason === 'controls';

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text" data-testid="live-terminal-page">
      {/* Page chrome, drawn here: nothing the agent's screen prints can reach it */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-4 py-2">
        <span className="rounded bg-accent/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-accent" data-testid="live-agent-badge">{name}&apos;s terminal</span>
        <span className="text-sm font-semibold" data-testid="live-terminal-title">The agent&apos;s own terminal, not your shell</span>
        {live && <span className="rounded bg-bg px-1.5 py-0.5 text-xs font-medium" data-testid="live-state" data-state={state}>{liveStateLabel(state)}</span>}
        {info && <span className="text-xs text-text-muted">in #{info.channelName}</span>}
        <span className="grow" />
        <Link to="/settings/agents" className="text-xs text-text-muted underline">Back</Link>
      </header>

      {phase === 'loading' && <p className="p-6 text-sm text-text-muted" role="status">Checking the session…</p>}

      {phase === 'blocked' && (
        <div className="p-6 text-sm" data-testid="live-blocked">
          <p role="alert">{message}</p>
          <Button variant="secondary" className="mt-3" onClick={() => void load()}>Check again</Button>
        </div>
      )}

      {live && (
        <>
          {liveNoteText(note) && <p className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn" role="status" data-testid="live-note">{liveNoteText(note)}</p>}
          {youHaveControls && <p className="border-b border-border bg-primary/10 px-4 py-2 text-xs" role="status" data-testid="live-controls">You have the controls. Chat messages to {name} are held while you type and delivered when you stop for a few seconds.</p>}
          {!youHaveControls && controls.held && controls.reason === 'wake_limit' && <p className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn" role="status" data-testid="live-limit">{name} has reached its wake limit: chat messages to it are held until you lift the limit in Settings → Agents.</p>}
          {role === 'watcher' && <p className="border-b border-border bg-surface px-4 py-2 text-xs text-text-muted" data-testid="live-readonly">You are watching. Only the server owner can type here.</p>}
          {role === 'owner' && !typing && !confirming && phase === 'live' && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2 text-xs">
              <span>You are watching. Typing is off until you take the keyboard.</span>
              <Button onClick={() => setConfirming(true)} className="min-h-11 md:min-h-8" data-testid="live-take">Take the keyboard</Button>
            </div>
          )}
          {confirming && (
            <div className="space-y-2 border-b border-warn/40 bg-warn/10 px-4 py-3 text-sm" role="alertdialog" aria-label="Take the keyboard" data-testid="live-confirm">
              <p className="font-semibold">This is {name}&apos;s terminal, not your own shell.</p>
              <ul className="list-disc space-y-1 pl-5 text-text-muted">
                <li>Whatever you type here, the agent sees it. It runs as the agent, with the agent&apos;s login.</li>
                <li>Never type a password, token or login code of your own here.</li>
                <li>While you type, chat messages to {name} are held, and delivered when you stop for a few seconds.</li>
                <li>Token use is not measured in live terminal mode, so token budgets do not apply.</li>
              </ul>
              <div className="flex gap-2">
                <Button onClick={take} className="min-h-11 md:min-h-9" data-testid="live-confirm-take">I understand, take the keyboard</Button>
                <Button variant="secondary" onClick={() => setConfirming(false)} className="min-h-11 md:min-h-9">Cancel</Button>
              </div>
            </div>
          )}
          {/* Letterboxed: the screen is drawn at the one size the owner's page set; a smaller window scrolls */}
          <div className="min-h-0 flex-1 overflow-auto p-2" style={{ background: THEME.background }} data-testid="live-viewport">
            <div ref={container} className="inline-block" data-testid="live-terminal-container" aria-label={`${name}'s terminal`} />
          </div>
          {phase === 'connecting' && <p className="px-4 py-1 text-xs text-text-muted" role="status">Connecting…</p>}
          <p className="px-4 py-1 text-[11px] text-text-muted" data-testid="live-footnote">
            Token use is not measured in live terminal mode. What the screen shows is the agent&apos;s own output and is shown as text only; nothing it prints can write your clipboard, change this page or follow a link.
          </p>
          {typing && (
            <div className="flex flex-wrap gap-1 border-t border-border bg-surface p-1 md:hidden" data-testid="live-toolbar">
              {TOOLBAR_KEYS.map(k => (
                <button key={k.label} type="button" title={k.title} onClick={() => send(k.seq)}
                  className="min-h-11 min-w-11 flex-1 rounded border border-border bg-bg px-2 text-sm">{k.label}</button>
              ))}
              <button type="button" onClick={() => container.current?.querySelector('textarea')?.focus()} className="min-h-11 flex-1 rounded border border-border bg-bg px-2 text-sm">Keyboard</button>
            </div>
          )}
        </>
      )}

      {phase === 'ended' && (
        <div className="p-6 text-sm" data-testid="live-ended">
          <p role="status">{message}</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void load()}>Reconnect</Button>
            <Link to="/settings/agents" className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-[13px] md:min-h-9">Back</Link>
          </div>
        </div>
      )}
    </div>
  );
}

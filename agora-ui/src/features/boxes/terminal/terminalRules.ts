import { ApiError } from '../../../lib/api';
import type { TerminalStatus } from '../api';

/**
 * Words and checks for the terminal in a box (docs/box-terminal.md). The server decides who may
 * open one and says why not in fixed codes; this file only turns the codes into sentences.
 */

/** Why a terminal ended, as the server names it (src/lib/boxes/shell.ts CLOSE_REASONS). */
export const CLOSE_TEXT: Record<string, string> = {
  closed_by_owner: 'You closed the terminal.',
  shell_exited: 'The shell exited.',
  browser_gone: 'This page disconnected.',
  taken_over: 'A terminal opened somewhere else took this one over.',
  idle_timeout: 'It closed because nothing was typed for the idle limit.',
  max_duration: 'It reached the longest a terminal may stay open.',
  output_flood: 'It closed because the shell sent output faster than the limit allows.',
  input_flood: 'It closed because input arrived faster than the limit allows.',
  box_disconnected: 'The box disconnected.',
  box_changed: 'The box was rebuilt, stopped or deleted.',
  box_not_ready: 'The box could not start a shell.',
  host_error: 'The box could not start a shell.',
  host_timeout: 'The box did not start a shell in time.',
  no_start: 'The terminal never started.',
  session_ended: 'Your Agora session ended.',
  server_restarted: 'Agora restarted.',
  server_stopped: 'Agora stopped.',
  access_changed: 'Your access changed.',
  host_changed: 'The connection to the box changed, so the terminal was closed for safety. The channel and the audit log have a note.',
  browser_stalled: 'It closed because this page stopped reading what the shell printed.',
};

export const closeText = (reason: string | null | undefined) => (reason && CLOSE_TEXT[reason]) || 'The terminal closed.';

const TICKET_ERRORS: Record<string, string> = {
  reauth_failed: 'That password is not right.',
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  forbidden: 'Only the server owner can open a terminal.',
  box_not_found: 'That box no longer exists.',
  box_needs_update: 'This box needs its update first.',
  box_not_ready: 'The box is not connected yet. Try again in a moment.',
  box_not_running: 'The box is not running.',
  terminal_in_use: 'A terminal is already open on this box.',
  cookie_session_required: 'Sign in again, then open the terminal from Settings.',
  origin_not_allowed: 'Open the terminal from this site\'s own pages.',
  login_unavailable: 'Sign-in checks are unavailable right now. Try again shortly.',
};

/** A sentence for a refused ticket request. */
export function ticketError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Could not reach Agora.';
  if (err.status === 400) return 'Enter your password.';
  return TICKET_ERRORS[err.code] ?? err.code;
}

const SOCKET_ERRORS: Record<string, string> = {
  ticket_invalid: 'The ticket was refused (it is single-use and lasts 30 seconds). Open the terminal again.',
  origin_not_allowed: 'Open the terminal from this site\'s own pages.',
  'Authentication required': 'Sign in again, then open the terminal.',
  forbidden: 'Only the server owner can open a terminal.',
  box_not_ready: 'The box is not connected yet. Try again in a moment.',
  box_needs_update: 'This box needs its update first.',
  box_not_found: 'That box no longer exists.',
  terminal_in_use: 'A terminal is already open on this box.',
  token_expired: 'Your Agora session ended. Sign in again.',
};

/** A sentence for a refused socket handshake. */
export const socketError = (message: string) => SOCKET_ERRORS[message] ?? 'The terminal could not connect.';

export type Readiness =
  | { ready: true }
  | { ready: false; reason: 'needs_update' | 'not_connected' | 'stopped'; text: string };

/** Can a terminal be opened on this box now, and if not, what does the owner do. */
export function readiness(s: Pick<TerminalStatus, 'supported' | 'running' | 'hostConnected'>): Readiness {
  if (!s.running) return { ready: false, reason: 'stopped', text: 'The box is not running. Start it first.' };
  if (!s.supported) return { ready: false, reason: 'needs_update', text: 'This box needs its update first. Rebuild it to put the current image on it.' };
  if (!s.hostConnected) return { ready: false, reason: 'not_connected', text: 'The box is not connected to Agora yet.' };
  return { ready: true };
}

/**
 * A terminal over plain http would send the owner's password and every keystroke where anyone on
 * the network can read them. Refused unless this is localhost. `isSecureContext` is undefined in
 * old engines and in test DOMs: only an explicit false counts.
 */
export function plainHttpProblem(isSecureContext: boolean | undefined, hostname: string): string | null {
  if (isSecureContext !== false) return null;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')) return null;
  return 'The terminal only opens on a secure (https) connection; this page was loaded over plain http, where your password and keystrokes could be read on the network.';
}

/** Pasted text with a line break runs as soon as it arrives when the shell has not asked for bracketed paste. */
export const needsPasteConfirm = (text: string, bracketedPaste: boolean) => !bracketedPaste && /[\r\n]/.test(text);

/** The browser events that count as the owner doing something (as opposed to the widget answering the shell). */
export const GESTURE_EVENTS = ['keydown', 'beforeinput', 'input', 'compositionend', 'paste', 'mousedown', 'pointerdown', 'wheel', 'touchstart'] as const;
/** Terminal data this soon after such an event is the owner's; later data is the widget's own reply. */
export const GESTURE_WINDOW_MS = 150;

/** Keys the phone toolbar sends: what a soft keyboard has no key for. */
export const TOOLBAR_KEYS: ReadonlyArray<{ label: string; seq: string; title: string }> = [
  { label: 'Esc', seq: '\x1b', title: 'Escape' },
  { label: 'Tab', seq: '\t', title: 'Tab' },
  { label: 'Ctrl-C', seq: '\x03', title: 'Interrupt' },
  { label: 'Ctrl-D', seq: '\x04', title: 'End of input' },
  { label: '↑', seq: '\x1b[A', title: 'Up' },
  { label: '↓', seq: '\x1b[B', title: 'Down' },
  { label: '←', seq: '\x1b[D', title: 'Left' },
  { label: '→', seq: '\x1b[C', title: 'Right' },
];

/**
 * Typed or pasted text in pieces the server accepts (it closes a terminal on a single input over
 * 64 KiB). A piece never ends between the two halves of a character outside the BMP.
 */
export function inputChunks(text: string, size = 16 * 1024): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** xterm's onBinary hands over a string of bytes, one per character. */
export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'never started';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

import { ApiError } from '../../../lib/api';

/**
 * Words for the live terminal page (docs/planning/live-terminals.md). The server sends fixed codes
 * (states, notes, exit reasons, refusals); this turns them into sentences. Nothing the agent's screen
 * says is ever used here.
 */

export type LiveState = 'starting' | 'idle' | 'working' | 'waiting' | 'restarting' | 'stopped';

export const LIVE_STATE_LABEL: Record<LiveState, string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  waiting: 'Waiting on you',
  restarting: 'Restarting',
  stopped: 'Stopped',
};

export const liveStateLabel = (s: string | null | undefined) => LIVE_STATE_LABEL[(s ?? 'stopped') as LiveState] ?? 'Stopped';

const NOTE_TEXT: Record<string, string> = {
  no_signal: 'The CLI has not said it started: it is probably showing a startup prompt. Answer it here.',
  notification: 'The CLI is asking you something (a permission or a dialog). Answer it here.',
  channel_unavailable: 'Its Claude Code Channel is not connected, so chat messages cannot reach it. They are not typed into this terminal.',
  exited: 'The CLI ended. It is being started again with its conversation resumed.',
  box_disconnected: 'The box is not connected to Agora.',
  wake_limit: 'The wake limit was reached: new messages are held.',
  turn_limit: 'A turn passed its run-time limit and was interrupted.',
};
export const liveNoteText = (note: string | null | undefined) => (note && NOTE_TEXT[note]) || null;

/** Why the page was disconnected, as the hub names it. */
const EXIT_TEXT: Record<string, string> = {
  not_running: 'This agent has no live terminal running right now.',
  session_ended: 'The session ended, or your Agora session did.',
  access_changed: 'Your access changed.',
  input_flood: 'Input arrived faster than the limit allows, so this page was disconnected. The agent is not affected.',
  viewer_stalled: 'This page stopped reading the screen, so it was disconnected. Reload to watch again.',
  server_stopped: 'Agora stopped.',
  left: 'You left the terminal.',
};
export const liveExitText = (reason: string | null | undefined) => (reason && EXIT_TEXT[reason]) || 'The terminal connection ended.';

const SOCKET_ERRORS: Record<string, string> = {
  forbidden: 'There is no live terminal here that you may watch. Only the server owner and people who can direct agents in the channel can.',
  origin_not_allowed: 'Open the terminal from this site\'s own pages.',
  'Authentication required': 'Sign in again, then open the terminal.',
  token_expired: 'Your Agora session ended. Sign in again.',
};
export const liveSocketError = (message: string) => SOCKET_ERRORS[message] ?? 'The terminal could not connect.';

export function liveInfoError(err: unknown): string {
  return err instanceof ApiError && (err.status === 403 || err.status === 404)
    ? 'There is no live terminal here that you may watch. Only the server owner and people who can direct agents in the channel can.'
    : 'Could not reach Agora.';
}

export interface LiveInfo {
  sessionId: string; profile: string; channelId: string; channelName: string;
  role: 'owner' | 'watcher'; canType: boolean;
  state: LiveState; note: string | null; controlsBy: string | null; held: boolean;
  hostConnected: boolean; needsUpdate: boolean; tokensMeasured: boolean; wakesUsed: number;
}

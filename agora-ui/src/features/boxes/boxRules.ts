import { ApiError } from '../../lib/api';
import type { Box, BoxLogin, LoginStatus } from './api';

/**
 * Client-side checks that mirror the server's (src/lib/boxes/contract.ts, the box routes'
 * schemas), so the owner sees a mistake before sending. The server stays the authority.
 */

/** An allowlist entry: an exact host name or `*.suffix`; never an IP, never a bare `*` (DOMAIN_ENTRY). */
export const DOMAIN_ENTRY = /^(\*\.)?(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** Same rule as an agent profile name: the bot and /start name. */
export const BOX_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** owner/repo on github.com (box_repos checks). */
export const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** Resource limits the box row accepts (migration 080). */
export const LIMITS = {
  cpus: { min: 0.25, max: 16, step: 0.25 },
  memoryMb: { min: 512, max: 65536, step: 256 },
  pids: { min: 64, max: 16384, step: 64 },
} as const;

export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

/** Why a domain can't be added, or null when it can. */
export function domainProblem(raw: string, existing: readonly string[]): string | null {
  const d = normalizeDomain(raw);
  if (!d) return 'Enter a domain.';
  if (d === '*' || d === '*.') return 'A wildcard for everything is not allowed.';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d) || d.includes(':')) return 'IP addresses are not allowed; use a domain name.';
  if (!DOMAIN_ENTRY.test(d)) return 'Use a name like example.com or *.example.com.';
  if (existing.includes(d)) return 'Already on the list.';
  return null;
}

export function normalizeRepo(raw: string): string {
  return raw.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
}

/** Repos from a text box, one per line or comma separated; `bad` lists the entries that aren't owner/repo. */
export function parseRepos(text: string): { repos: string[]; bad: string[] } {
  const entries = text.split(/[\s,]+/).map(normalizeRepo).filter(Boolean);
  const bad = entries.filter(r => !REPO.test(r) || r.endsWith('/.') || r.endsWith('/..'));
  return { repos: [...new Set(entries.filter(r => !bad.includes(r)))], bad };
}

export function resourceProblem(key: keyof typeof LIMITS, value: string): string | null {
  const n = Number(value);
  const { min, max } = LIMITS[key];
  if (!value.trim() || !Number.isFinite(n)) return 'Enter a number.';
  if (key !== 'cpus' && !Number.isInteger(n)) return 'Enter a whole number.';
  if (n < min || n > max) return `Between ${min} and ${max}.`;
  return null;
}

export const ADAPTER_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

/** The state chip: what the box is doing, including an owner action boxd hasn't done yet. */
export function stateChip(box: Box): { label: string; tone: string; login?: boolean } {
  if (box.deletedAt || box.desiredState === 'deleted') return { label: 'deleted', tone: 'bg-surface text-text-muted' };
  if (box.pendingAction) return { label: `${box.pendingAction} pending`, tone: 'bg-warn/20 text-warn' };
  if (box.state === 'failed') return { label: 'failed', tone: 'bg-danger/20 text-danger' };
  if (box.state === 'running' && box.desiredState === 'stopped') return { label: 'stopping', tone: 'bg-warn/20 text-warn' };
  if (box.state === 'stopped' && box.desiredState === 'running') return { label: 'starting', tone: 'bg-warn/20 text-warn' };
  // A running box whose CLI isn't logged in can't answer anyone: say that, not "running"
  if (box.state === 'running' && box.auth === 'subscription' && box.loginState !== 'logged_in') {
    if (box.loginState === 'failed') return { label: 'login failed', tone: 'bg-danger/20 text-danger', login: true };
    if (box.loginState === 'pending') return { label: 'logging in', tone: 'bg-warn/20 text-warn', login: true };
    return { label: 'not logged in', tone: 'bg-warn/20 text-warn', login: true };
  }
  if (box.state === 'running') return { label: 'running', tone: 'bg-online/20 text-online' };
  if (box.state === 'creating') return { label: 'creating', tone: 'bg-warn/20 text-warn' };
  return { label: box.state, tone: 'bg-surface text-text-muted' };
}

export const LOGIN_LABEL: Record<Box['loginState'], string> = {
  none: 'not logged in',
  pending: 'login in progress',
  logged_in: 'logged in',
  failed: 'login failed',
};

/**
 * What the owner does next about a box's login, or null: the domains to allow on the box's card
 * when the edge is refusing its login, else "log in again" after a failure.
 */
export function loginHint(box: Box): string | null {
  if (box.auth !== 'subscription' || box.deletedAt) return null;
  const hosts = box.loginBlockedHosts ?? [];
  if (box.loginState === 'failed') {
    return hosts.length
      ? `Login failed: allow ${hosts.join(', ')} on the box's card, then log in again.`
      : `Login failed${box.loginError ? ` (${box.loginError})` : ''}: log in again.`;
  }
  if (box.loginState === 'pending' && hosts.length) return `The login is waiting: allow ${hosts.join(', ')} on the box's card.`;
  return null;
}

/** Whether a login has ended (nothing more to poll). */
export function loginEnded(status: LoginStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'expired' || status === 'cancelled';
}

/** A sentence for the login dialog. */
export function loginStatusText(login: BoxLogin | null, adapter: Box['adapter']): string {
  if (!login) return 'Starting…';
  // The CLI is waiting on a domain the box isn't allowed to reach yet
  if (login.blockedHosts?.length && !loginEnded(login.status)) {
    return `Blocked: the login needs ${login.blockedHosts.join(', ')}. Allow it on the box's card in its channel; the login waits up to 2 minutes for it, then log in again if it fails.`;
  }
  switch (login.status) {
    case 'requested': return 'Waiting for the box to pick up the login. The box must be running.';
    case 'claimed': return `The box is starting ${ADAPTER_LABEL[adapter] ?? adapter}'s login…`;
    case 'awaiting_user': return adapter === 'codex'
      ? 'Open the link, sign in to OpenAI and enter the code below.'
      : 'Open the link and sign in to Anthropic.';
    case 'awaiting_code': return 'Open the link, sign in to Anthropic, then paste the code Anthropic shows.';
    case 'code_sent': return 'Code sent. Waiting for the CLI to finish…';
    case 'succeeded': return 'Logged in. The login is saved in the box\'s home folder only.';
    case 'failed': return login.error === 'needs_domain' && login.blockedHosts?.length
      ? `Login failed: the box was blocked from ${login.blockedHosts.join(', ')}. Allow it on the box's card, then log in again.`
      : `Login failed${login.error ? `: ${login.error}` : '.'}`;
    case 'expired': return 'The login expired. Start again.';
    case 'cancelled': return 'Login cancelled.';
  }
}

/** Only http(s) links are shown as links; anything else is shown as text. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Where each CLI's own sign-in page may be (the server checks the same list; src/routes/box-hosts.ts). */
const LOGIN_HOSTS: Record<string, string[]> = {
  claude: ['claude.ai', 'claude.com', 'anthropic.com'],
  codex: ['openai.com', 'chatgpt.com'],
};

/** A sign-in link to show the owner: https, on the CLI's provider's own hosts; else nothing. */
export function loginUrl(adapter: string, url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    return (LOGIN_HOSTS[adapter] ?? []).some(d => host === d || host.endsWith(`.${d}`)) ? u.toString() : null;
  } catch {
    return null;
  }
}

const BOX_ERRORS: Record<string, string> = {
  owner_only: 'Only the server owner can do this.',
  forbidden: 'Only the server owner can do this.',
  verification_url_not_allowed: 'The box sent a sign-in link that is not on the provider’s own site, so it was not shown.',
  name_taken: 'An agent with that name already exists.',
  confirm_required: 'Type the box\'s name exactly to confirm.',
  box_deleted: 'This box is deleted. Restore it first.',
  box_not_found: 'That box no longer exists.',
  not_deleted: 'This box is not deleted.',
  not_restorable: 'This box can no longer be restored.',
  api_key_required: 'Enter the API key.',
  api_key_needs_api_key_auth: 'An API key is only used with API key sign-in.',
  unknown_channel: 'That channel is not on this server.',
  login_active: 'A login is already in progress.',
  no_login_awaiting_code: 'The login is not waiting for a code. Start it again.',
  github_token_invalid: 'GitHub did not accept that token.',
  github_unreachable: 'Could not reach GitHub to check the token. Try again.',
  invalid_domain: 'One of the domains is not allowed.',
  invalid_repo: 'One of the repositories is not owner/repo.',
  already_decided: 'Someone already answered this.',
  no_wildcard: 'This domain has no wider name that can be allowed. Allow it on its own.',
  expired: 'This request expired.',
  not_found: 'Not found. It may have been removed.',
  report_too_large: 'The report is too large to send.',
  collector_unreachable: 'Could not reach the report service. Try again later.',
  collector_refused: 'The report service refused the report.',
};

export function boxError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Request failed';
  if (BOX_ERRORS[err.code]) return BOX_ERRORS[err.code];
  if (err.status === 403) return 'Only the server owner can do this.';
  return err.code;
}

/** Days left before a deleted box's home volume is removed (rounded up), or null. */
export function daysLeft(purgeAfter: string | null, now = Date.now()): number | null {
  if (!purgeAfter) return null;
  const ms = Date.parse(purgeAfter) - now;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** The profile fields the API sends (agent profile JSON): boxed = its host is a box. */
export interface BoxMode { boxed?: boolean | null; hostMode?: boolean | null }

/**
 * "boxed" when the profile's host is a box, else "unboxed" (§10). Null only when the JSON
 * carries neither field (an API from before boxes), so nothing is claimed that isn't known.
 */
export function boxModeLabel(p: BoxMode | null | undefined): 'boxed' | 'unboxed' | null {
  if (!p) return null;
  if (p.boxed === true) return 'boxed';
  if (typeof p.boxed === 'boolean' || typeof p.hostMode === 'boolean') return 'unboxed';
  return null;
}

/** Field style shared by the box forms: 44px targets on a phone, 16px text so iOS doesn't zoom. */
export const INPUT = 'min-h-11 md:min-h-9 w-full bg-bg border border-border rounded px-3 py-1.5 text-[16px] md:text-sm text-text placeholder:text-text-muted/70 focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60';
/** Phone: full-width stacked buttons; desktop: a row. */
export const TOUCH = 'w-full md:w-auto';

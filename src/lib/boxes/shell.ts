import { createHash, randomBytes } from 'node:crypto';
import { generateUlid } from '../../utils/ulid';

/**
 * The terminal in a box (docs/box-terminal.md): rows, tickets and numbers. Everything here runs
 * as the table owner, in a transaction of the caller's (a request, or the gateway's own).
 *
 * No function in this file, or in shell-hub.ts, ever sees what the shell says: the hub passes
 * bytes through and keeps their count.
 */

/** The terminal protocol this server speaks (agora-host's box-shell.ts sends the same number). */
export const SHELL_PROTOCOL = 1;

/** A ticket is good for this long after it is issued, once. */
export const TICKET_TTL_SECONDS = 30;
/** One chunk of keystrokes or pasted text from the browser. */
export const MAX_INPUT_CHUNK = 64 * 1024;
/** What the owner may type per second before the terminal is closed (a large paste fits). */
export const INPUT_RATE_BYTES = 256 * 1024;
export const INPUT_BURST_BYTES = 1024 * 1024;
export const MAX_COLS = 500;
export const MAX_ROWS = 200;
/** The host has this long to start the shell; the browser this long to say its size. */
export const OPEN_TIMEOUT_MS = 15_000;
export const START_TIMEOUT_MS = 15_000;

/** Why a terminal ended: the codes in the audit log, the owner's list and the notice. */
export const CLOSE_REASONS = [
    'closed_by_owner', 'shell_exited', 'browser_gone', 'taken_over', 'idle_timeout', 'max_duration',
    'output_flood', 'input_flood', 'box_disconnected', 'box_changed', 'box_not_ready', 'host_error',
    'host_timeout', 'no_start', 'session_ended', 'server_restarted', 'server_stopped', 'access_changed',
] as const;
export type CloseReason = typeof CLOSE_REASONS[number];

/** The sentence for a close reason, for the channel notice and the owner's list. */
export const CLOSE_TEXT: Record<CloseReason, string> = {
    closed_by_owner: 'closed by its owner',
    shell_exited: 'the shell exited',
    browser_gone: 'the browser disconnected',
    taken_over: 'taken over by a new terminal',
    idle_timeout: 'no keystroke for the idle limit',
    max_duration: 'reached the longest a terminal may stay open',
    output_flood: 'the shell sent output faster than the limit allows',
    input_flood: 'input arrived faster than the limit allows',
    box_disconnected: 'the box disconnected',
    box_changed: 'the box was rebuilt, stopped or deleted',
    box_not_ready: 'the box could not start a shell',
    host_error: 'the box could not start a shell',
    host_timeout: 'the box did not start a shell in time',
    no_start: 'the browser never started the terminal',
    session_ended: 'the owner\'s session ended',
    server_restarted: 'Agora restarted',
    server_stopped: 'Agora stopped',
    access_changed: 'the owner\'s access changed',
};

/**
 * A byte meter with a budget: `rate` per second, `burst` bytes at once. `add` says whether the
 * bytes fit; the balance may run to `-slack` before a stream counts as flooding. The same rule
 * limits output on both ends: the host paces itself to `rate` (its pty then blocks, which is
 * what slows `cat bigfile`), and the server closes the terminal when a host ignores it.
 */
export class ByteMeter {
    private tokens: number;
    private last: number;
    constructor(private rate: number, private burst: number, private slack: number, now = Date.now()) {
        this.tokens = burst; this.last = now;
    }
    /** True while the stream stays within budget plus slack. */
    add(bytes: number, now = Date.now()): boolean {
        this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
        this.last = now;
        this.tokens -= bytes;
        return this.tokens >= -this.slack;
    }
}

/** What the owner may change per box (migration 100): the limits are shown, never hidden. */
export interface ShellLimits { idleMinutes: number; maxHours: number; rateKbps: number }
export const limitsOf = (b: any): ShellLimits => ({
    idleMinutes: Number(b.terminal_idle_minutes), maxHours: Number(b.terminal_max_hours), rateKbps: Number(b.terminal_rate_kbps),
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * A new ticket for this box, person and browser session. The token is returned once; only its
 * hash is stored. Old expired rows go on the way.
 */
export async function issueTicket(db: any, t: { boxId: string; userId: string; jti: string; generation: number }): Promise<{ ticket: string; expiresInSeconds: number }> {
    await db.query(`DELETE FROM box_shell_tickets WHERE expires_at < NOW() - interval '1 hour'`);
    const ticket = randomBytes(32).toString('base64url');
    await db.query(
        `INSERT INTO box_shell_tickets (id, token_hash, box_id, user_id, session_jti, generation, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7))`,
        [generateUlid(), sha256(ticket), t.boxId, t.userId, t.jti, t.generation, TICKET_TTL_SECONDS]
    );
    return { ticket, expiresInSeconds: TICKET_TTL_SECONDS };
}

export interface RedeemedTicket { boxId: string; generation: number }

/**
 * Spend a ticket: one atomic UPDATE that matches only an unused, unexpired ticket issued to this
 * person for this very browser session. Whatever the reason a ticket doesn't match, the answer
 * is the same null: a probe learns nothing.
 */
export async function redeemTicket(db: any, token: string, who: { userId: string; jti: string }): Promise<RedeemedTicket | null> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const row = (await db.query(
        `UPDATE box_shell_tickets SET used_at = NOW()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() AND user_id = $2 AND session_jti = $3
         RETURNING box_id, generation`,
        [sha256(token), who.userId, who.jti]
    )).rows[0];
    return row ? { boxId: row.box_id.trim(), generation: row.generation } : null;
}

/** What a terminal needs to know about its box, as the table owner. */
export async function shellBox(db: any, boxId: string): Promise<any | null> {
    return (await db.query(
        `SELECT b.id, b.server_id, b.state, b.desired_state, b.generation, b.home_channel_id, b.host_id, b.profile_id,
                b.terminal_idle_minutes, b.terminal_max_hours, b.terminal_rate_kbps,
                p.name, p.adapter, p.bot_id, h.shell_protocol, h.revoked_at, s.owner_id
         FROM agent_boxes b
         JOIN agent_profiles p ON p.id = b.profile_id
         JOIN agent_hosts h ON h.id = b.host_id
         JOIN servers s ON s.id = b.server_id
         WHERE b.id = $1`,
        [boxId]
    )).rows[0] ?? null;
}

/** A refusal or an event for the owner's audit trail (never anything the shell said). */
export async function shellAudit(db: any, a: { serverId: string | null; actorId: string | null; action: string; boxId: string | null; changes: Record<string, unknown> }): Promise<void> {
    await db.query(
        `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
         VALUES ($1, $2, $3, $4, 'box', $5, $6)`,
        [generateUlid(), a.serverId, a.actorId, a.action, a.boxId, JSON.stringify(a.changes)]
    );
}

export interface ShellSessionRow {
    id: string; boxId: string; openedBy: string | null; openedByName: string | null; state: string; openedAt: string;
    startedAt: string | null; closedAt: string | null; closeReason: string | null; durationSeconds: number | null;
    bytesIn: number; bytesOut: number;
}
export const sessionJson = (r: any): ShellSessionRow => ({
    id: r.id.trim(), boxId: r.box_id.trim(), openedBy: r.opened_by?.trim() ?? null, openedByName: r.username ?? null, state: r.state,
    openedAt: r.opened_at, startedAt: r.started_at ?? null, closedAt: r.closed_at ?? null, closeReason: r.close_reason ?? null,
    durationSeconds: r.started_at && r.closed_at ? Math.max(0, Math.round((new Date(r.closed_at).getTime() - new Date(r.started_at).getTime()) / 1000)) : null,
    bytesIn: Number(r.bytes_in), bytesOut: Number(r.bytes_out),
});

/** The terminal open on this box now (opening or open), if any. */
export async function openSessionOf(db: any, boxId: string): Promise<ShellSessionRow | null> {
    const r = (await db.query(
        `SELECT s.*, u.username FROM box_shell_sessions s LEFT JOIN users u ON u.id = s.opened_by
         WHERE s.box_id = $1 AND s.state <> 'closed'`, [boxId]
    )).rows[0];
    return r ? sessionJson(r) : null;
}

/** The newest terminals of a box, for the owner's list. */
export async function recentSessions(db: any, boxId: string, limit = 20): Promise<ShellSessionRow[]> {
    const r = await db.query(
        `SELECT s.*, u.username FROM box_shell_sessions s LEFT JOIN users u ON u.id = s.opened_by
         WHERE s.box_id = $1 ORDER BY s.opened_at DESC, s.id DESC LIMIT $2`, [boxId, limit]
    );
    return r.rows.map(sessionJson);
}

/** Is a run of this agent working now? Opening a terminal then shares the box with it. */
export async function activeRunOf(db: any, profileId: string): Promise<boolean> {
    const r = await db.query(
        `SELECT 1 FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id
         WHERE s.profile_id = $1 AND r.status = 'claimed' LIMIT 1`, [profileId]
    );
    return r.rows.length > 0;
}

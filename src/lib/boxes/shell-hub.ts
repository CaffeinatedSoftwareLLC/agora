import type { Pool } from 'pg';
import type { Socket } from 'socket.io';
import { generateUlid } from '../../utils/ulid';
import { verifyToken, sessionEndsAt, sessionLimitError } from '../../auth/tokens';
import { isTokenBlacklisted } from '../../auth/token-blacklist';
import { verifyBotSecret } from '../../auth/bot-tokens';
import { originAllowed, originSchemeMatches, sessionTokenFromHeaders } from '../../auth/session-cookie';
import { postNotice, type Notice } from '../agent-runs';
import type { ProvenanceCredential } from './provenance';
import {
    ByteMeter, CLOSE_TEXT, MAX_BROWSER_BUFFER_BYTES, NOTICE_INTERVAL_MINUTES, shellRefusal, INPUT_BURST_BYTES, INPUT_RATE_BYTES, MAX_COLS, MAX_INPUT_CHUNK, MAX_ROWS, OPEN_TIMEOUT_MS,
    SHELL_PROTOCOL, START_TIMEOUT_MS, activeRunOf, limitsOf, redeemTicket, shellAudit, shellBox, type CloseReason, type ShellLimits,
} from './shell';

/**
 * The terminal's relay (docs/box-terminal.md). Two kinds of socket meet here, both on the
 * existing gateway and both authenticated by their own handshake:
 *
 *  - a browser socket (`auth.type = 'shell'`): the owner's cookie session, an allowed Origin and a
 *    single-use ticket bound to that session and one box;
 *  - a relay socket (`auth.type = 'relay'`): the box's terminal relay, a process of its own Unix
 *    user inside the box (docs/box-terminal.md), with the relay credential minted for that box
 *    generation, through the box's own edge (the provenance rule of docs/agent-boxes.md §4.1).
 *    The box's host token, which the agent can read, is not accepted here at all.
 *
 * The hub joins a browser to the relay of the box its ticket names, and to nothing else. Bytes go
 * socket to socket, never through a Socket.IO room, never into a database column or a log line;
 * the hub keeps only counts. One terminal per box at a time (a unique index says so too).
 */

export interface ShellHostInfo { hostId: string; boxId: string; serverId: string; generation: number }
export interface ShellBrowserInfo {
    sessionId: string; boxId: string; serverId: string; userId: string; generation: number; limits: ShellLimits;
}

interface Live {
    info: ShellBrowserInfo;
    browser: Socket;
    host: Socket | null;
    started: boolean;
    opened: boolean;
    closing: boolean;
    openedAtMs: number;
    lastInputMs: number;
    bytesIn: number;
    bytesOut: number;
    outMeter: ByteMeter | null;
    inMeter: ByteMeter;
    /** When the cookie session behind this socket ends (ms): the terminal goes with it */
    sessionEndsMs: number;
    startTimer: ReturnType<typeof setTimeout> | null;
    openTimer: ReturnType<typeof setTimeout> | null;
    /** When the next "still open" reminder is due (ms) */
    nextReminderMs: number;
}

type Emit = (notices: Notice[]) => void;
const SWEEP_MS = 5_000;
const RECHECK_EVERY = 3;

const dims = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max ? v as number : null;
const isBytes = (d: unknown): d is Buffer | Uint8Array => d instanceof Uint8Array;

/** Bytes the transport still holds for this browser socket (queued packets plus the websocket's own buffer). */
export function bufferedBytes(socket: Socket): number {
    const conn = (socket as any).conn;
    let n = 0;
    for (const p of conn?.writeBuffer ?? []) {
        const d = p?.data;
        n += typeof d === 'string' ? d.length : (d?.byteLength ?? d?.length ?? 0);
    }
    const ws = conn?.transport?.socket;
    if (typeof ws?.bufferedAmount === 'number') n += ws.bufferedAmount;
    return n;
}

export class ShellHub {
    private hosts = new Map<string, { socket: Socket; info: ShellHostInfo }>();
    private live = new Map<string, Live>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private sweeps = 0;
    /** Database work in flight (an ending, an opening): stop() and tests wait for it */
    private pending = new Set<Promise<unknown>>();
    /** Handshakes refused for a ticket that did not redeem (a count, never a row or a line) */
    refusedTickets = 0;
    /** What a stalled browser may leave queued before its terminal is closed (tests lower it) */
    maxBrowserBuffer = MAX_BROWSER_BUFFER_BYTES;

    constructor(private db: Pool, private emit: Emit) {}

    /** Start the sweep (idle, longest, access re-checks) and end terminals a restart left behind. */
    async start(): Promise<void> {
        const stale = await this.db.query(`SELECT id FROM box_shell_sessions WHERE state <> 'closed'`);
        for (const r of stale.rows) await this.finish(r.id.trim(), 'server_restarted', 0, 0);
        this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, SWEEP_MS);
        this.timer.unref();
    }

    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await Promise.all([...this.live.keys()].map(id => this.close(id, 'server_stopped')));
        await this.drain();
    }

    /** Wait for the database work in flight to finish. */
    async drain(): Promise<void> {
        while (this.pending.size) await Promise.allSettled([...this.pending]);
    }

    private track<T>(p: Promise<T>): Promise<T> {
        this.pending.add(p);
        const done = () => { this.pending.delete(p); };
        p.then(done, done);
        return p;
    }

    // ─── Queries the routes use ───

    /** Is this box's host connected, at this generation (when given)? A socket from an older generation doesn't count. */
    hostConnected(boxId: string, generation?: number): boolean {
        const h = this.hosts.get(boxId);
        return !!h && h.socket.connected && (generation === undefined || h.info.generation === generation);
    }
    liveSessionOf(boxId: string): string | null {
        for (const [id, l] of this.live) if (l.info.boxId === boxId) return id;
        return null;
    }
    liveCount(): number { return this.live.size; }

    // ─── Host sockets ───

    /**
     * Take a box's relay socket (kept as "host" in the names: it is the box's end of the terminal).
     * One per box: while the registered socket is connected at the same generation, a second one is
     * refused. Only the relay's own user holds the credential, but a leak by any other road must
     * not let a second socket take the owner's keystrokes. A genuine reconnect comes after the old
     * socket's disconnect or ping timeout. Returns false when refused.
     */
    registerHost(socket: Socket, info: ShellHostInfo): boolean {
        const old = this.hosts.get(info.boxId);
        if (old && old.socket !== socket && old.socket.connected && old.info.generation === info.generation) {
            this.hostConflict(info, 'second_socket');
            socket.emit('shell:refused', { code: 'host_already_connected' });
            socket.disconnect(true);
            return false;
        }
        this.hosts.set(info.boxId, { socket, info });
        // The old socket was dead or from an older generation: a terminal on it ends
        if (old && old.socket !== socket) {
            for (const [id, l] of this.live) if (l.info.boxId === info.boxId && l.host === old.socket) void this.close(id, old.info.generation === info.generation ? 'host_changed' : 'box_changed');
            old.socket.disconnect(true);
        }
        socket.on('shell:opened', (m: { sessionId?: unknown }) => this.fromHost(socket, m?.sessionId, l => this.onOpened(l)));
        socket.on('shell:output', (m: { sessionId?: unknown; data?: unknown }) => this.fromHost(socket, m?.sessionId, l => {
            if (!isBytes(m.data) || m.data.byteLength === 0 || m.data.byteLength > 256 * 1024 || !l.opened) return;
            l.bytesOut += m.data.byteLength;
            // The host paces itself to the limit; a host that doesn't is closed
            if (l.outMeter && !l.outMeter.add(m.data.byteLength)) { void this.close(l.info.sessionId, 'output_flood'); return; }
            if (l.browser.connected) {
                if (bufferedBytes(l.browser) > this.maxBrowserBuffer) { void this.close(l.info.sessionId, 'browser_stalled'); return; }
                l.browser.emit('shell:output', Buffer.from(m.data));
            }
        }));
        socket.on('shell:exited', (m: { sessionId?: unknown }) => this.fromHost(socket, m?.sessionId, l => { void this.close(l.info.sessionId, 'shell_exited'); }));
        socket.on('shell:failed', (m: { sessionId?: unknown }) => this.fromHost(socket, m?.sessionId, l => { void this.close(l.info.sessionId, 'host_error'); }));
        socket.on('disconnect', () => {
            if (this.hosts.get(info.boxId)?.socket === socket) this.hosts.delete(info.boxId);
            for (const [id, l] of this.live) if (l.host === socket) void this.close(id, 'box_disconnected');
        });
        return true;
    }

    /**
     * A second connection claimed to be this box's host. Closes an open terminal (the owner is told
     * the connection changed), writes an audit entry (at most one a minute) and tells the agent's
     * channel (at most one an hour per box).
     */
    hostConflict(info: { boxId: string; serverId: string }, how: string): void {
        for (const [id, l] of this.live) if (l.info.boxId === info.boxId) void this.close(id, 'host_changed');
        void this.track(this.recordConflict(info, how)).catch(() => {});
    }

    private async recordConflict(info: { boxId: string; serverId: string }, how: string): Promise<void> {
        const client = await this.db.connect();
        let notices: Notice[] = [];
        try {
            await client.query('BEGIN');
            await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`box-host-conflict:${info.boxId}`]);
            const recentAudit = await client.query(
                `SELECT 1 FROM audit_log WHERE action = 'box_host_conflict' AND target_id = $1 AND created_at > NOW() - interval '1 minute' LIMIT 1`, [info.boxId]);
            if (!recentAudit.rows.length) {
                await shellAudit(client, { serverId: info.serverId, actorId: null, action: 'box_host_conflict', boxId: info.boxId, changes: { how } });
            }
            const box = (await client.query(
                `SELECT b.home_channel_id, p.name FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id WHERE b.id = $1`, [info.boxId])).rows[0];
            if (box?.home_channel_id) {
                const recent = await client.query(
                    `SELECT 1 FROM audit_log WHERE action = 'box_host_conflict_notice' AND target_id = $1 AND created_at > NOW() - make_interval(mins => $2) LIMIT 1`,
                    [info.boxId, NOTICE_INTERVAL_MINUTES]);
                if (!recent.rows.length) {
                    await shellAudit(client, { serverId: info.serverId, actorId: null, action: 'box_host_conflict_notice', boxId: info.boxId, changes: {} });
                    notices = [await postNotice(client, box.home_channel_id.trim(),
                        `Box **${box.name}**: a second connection claimed to be this box's host while the real one was connected, and was refused (\`host_already_connected\`). Any open terminal was closed for safety. It is in the audit log; further attempts are not posted for an hour.`)];
                }
            }
            await client.query('COMMIT');
        } catch {
            await client.query('ROLLBACK').catch(() => {});
            notices = [];
        } finally {
            client.release();
        }
        if (notices.length) this.emit(notices);
    }

    /** Drop host sockets registered at a generation the box has left (a rebuild keeps the old socket alive otherwise). */
    private async dropStaleHosts(): Promise<void> {
        if (!this.hosts.size) return;
        const ids = [...this.hosts.keys()];
        const rows = (await this.db.query(`SELECT id, generation FROM agent_boxes WHERE id = ANY($1)`, [ids])).rows;
        const current = new Map<string, number>(rows.map((r: any) => [r.id.trim(), Number(r.generation)]));
        for (const [boxId, h] of [...this.hosts]) {
            if (current.get(boxId) !== h.info.generation) {
                this.hosts.delete(boxId);
                for (const [id, l] of this.live) if (l.host === h.socket) void this.close(id, 'box_changed');
                h.socket.disconnect(true);
            }
        }
    }

    /** Re-check every open terminal's access now (called when authorization changes commit). */
    async recheckAccess(): Promise<void> {
        for (const [id, l] of [...this.live]) {
            if (l.closing) continue;
            const reason = await this.accessProblem(l).catch(() => null);
            if (reason) await this.close(id, reason);
        }
        await this.dropStaleHosts().catch(() => {});
    }

    /** An event from a host socket counts only for a terminal that socket was given. */
    private fromHost(socket: Socket, sessionId: unknown, fn: (l: Live) => void): void {
        if (typeof sessionId !== 'string') return;
        const l = this.live.get(sessionId);
        if (!l || l.host !== socket || l.closing) return;
        fn(l);
    }

    private onOpened(l: Live): void {
        if (l.opened) return;
        l.opened = true;
        if (l.openTimer) { clearTimeout(l.openTimer); l.openTimer = null; }
        l.lastInputMs = Date.now();
        l.outMeter = new ByteMeter(l.info.limits.rateKbps * 1024, l.info.limits.rateKbps * 1024, l.info.limits.rateKbps * 1024 * 3);
        void this.track(this.markOpen(l)).then(() => { if (!l.closing && l.browser.connected) l.browser.emit('shell:ready', { limits: l.info.limits }); })
            .catch(() => { void this.close(l.info.sessionId, 'host_error'); });
    }

    // ─── Browser sockets ───

    /** A browser that passed its handshake (the session row exists). */
    attachBrowser(socket: Socket, info: ShellBrowserInfo, sessionEndsMs: number): void {
        const reg = this.hosts.get(info.boxId);
        const host = reg && reg.socket.connected && reg.info.generation === info.generation ? reg.socket : null;
        const l: Live = {
            info, browser: socket, host, started: false, opened: false, closing: false, openedAtMs: Date.now(), lastInputMs: Date.now(),
            bytesIn: 0, bytesOut: 0, outMeter: null, inMeter: new ByteMeter(INPUT_RATE_BYTES, INPUT_BURST_BYTES, INPUT_BURST_BYTES),
            sessionEndsMs, startTimer: null, openTimer: null, nextReminderMs: Date.now() + 3_600_000,
        };
        this.live.set(info.sessionId, l);
        // Gone between the handshake and now: its disconnect event already fired, so nothing else would end this
        if (!socket.connected) { void this.close(info.sessionId, 'browser_gone'); return; }
        if (!host) { void this.close(info.sessionId, 'box_not_ready'); return; }
        l.startTimer = setTimeout(() => { if (!l.started) void this.close(info.sessionId, 'no_start'); }, START_TIMEOUT_MS);

        socket.on('shell:start', (m: { cols?: unknown; rows?: unknown }) => {
            if (l.started || l.closing) return;
            const cols = dims(m?.cols, MAX_COLS), rows = dims(m?.rows, MAX_ROWS);
            if (!cols || !rows) { void this.close(info.sessionId, 'no_start'); return; }
            l.started = true;
            if (l.startTimer) { clearTimeout(l.startTimer); l.startTimer = null; }
            l.openTimer = setTimeout(() => { if (!l.opened) void this.close(info.sessionId, 'host_timeout'); }, OPEN_TIMEOUT_MS);
            host.emit('shell:open', { sessionId: info.sessionId, cols, rows, rateBytesPerSecond: info.limits.rateKbps * 1024 });
        });
        // `shell:input` is what the owner typed or pasted and counts as activity. `shell:reply` is
        // the terminal widget's own automatic answers (to queries and focus reports the shell
        // printed): written to the shell just the same, and under the same limits, but it never
        // resets the idle clock, so a shell cannot keep itself alive by asking questions.
        const forward = (data: unknown, activity: boolean) => {
            if (!l.opened || l.closing || !l.host) return;
            const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : isBytes(data) ? Buffer.from(data) : null;
            if (!bytes || bytes.length === 0) return;
            if (bytes.length > MAX_INPUT_CHUNK) { void this.close(info.sessionId, 'input_flood'); return; }
            if (!l.inMeter.add(bytes.length)) { void this.close(info.sessionId, 'input_flood'); return; }
            l.bytesIn += bytes.length;
            if (activity) l.lastInputMs = Date.now();
            l.host.emit('shell:input', { sessionId: info.sessionId, data: bytes });
        };
        socket.on('shell:input', (data: unknown) => forward(data, true));
        socket.on('shell:reply', (data: unknown) => forward(data, false));
        socket.on('shell:resize', (m: { cols?: unknown; rows?: unknown }) => {
            if (!l.opened || l.closing || !l.host) return;
            const cols = dims(m?.cols, MAX_COLS), rows = dims(m?.rows, MAX_ROWS);
            if (cols && rows) l.host.emit('shell:resize', { sessionId: info.sessionId, cols, rows });
        });
        socket.on('shell:close', () => { void this.close(info.sessionId, 'closed_by_owner'); });
        socket.on('disconnect', () => { if (!l.closing) void this.close(info.sessionId, 'browser_gone'); });
    }

    // ─── Ending a terminal ───

    /** End a terminal and record it. Safe to call twice: the first call does the work. */
    async close(sessionId: string, reason: CloseReason): Promise<void> {
        const l = this.live.get(sessionId);
        if (l) {
            if (l.closing) return;
            l.closing = true;
            if (l.startTimer) clearTimeout(l.startTimer);
            if (l.openTimer) clearTimeout(l.openTimer);
            this.live.delete(sessionId);
            // The host kills the shell first; the browser is told why, then dropped
            if (l.host?.connected) l.host.emit('shell:close', { sessionId });
            if (l.browser.connected) {
                l.browser.emit('shell:exit', { reason });
                setTimeout(() => l.browser.disconnect(true), 50).unref();
            }
        }
        await this.track(this.finish(sessionId, reason, l?.bytesIn ?? 0, l?.bytesOut ?? 0));
    }

    /** The database side of ending: the row, the audit entry, the channel notice. */
    private async finish(sessionId: string, reason: CloseReason, bytesIn: number, bytesOut: number): Promise<void> {
        const client = await this.db.connect();
        let notices: Notice[] = [];
        try {
            await client.query('BEGIN');
            const row = (await client.query(
                `UPDATE box_shell_sessions SET state = 'closed', closed_at = NOW(), close_reason = $2,
                        bytes_in = GREATEST(bytes_in, $3), bytes_out = GREATEST(bytes_out, $4)
                 WHERE id = $1 AND state <> 'closed'
                 RETURNING box_id, server_id, opened_by, started_at, closed_at, bytes_in, bytes_out, generation`,
                [sessionId, reason, bytesIn, bytesOut]
            )).rows[0];
            if (row) {
                const box = (await client.query(
                    `SELECT b.home_channel_id, p.name, u.username FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id
                     LEFT JOIN users u ON u.id = $2 WHERE b.id = $1`, [row.box_id, row.opened_by]
                )).rows[0];
                const seconds = row.started_at ? Math.max(0, Math.round((new Date(row.closed_at).getTime() - new Date(row.started_at).getTime()) / 1000)) : null;
                await shellAudit(client, {
                    serverId: row.server_id.trim(), actorId: row.opened_by?.trim() ?? null, action: 'box_terminal_close', boxId: row.box_id.trim(),
                    changes: { name: box?.name ?? null, sessionId, reason, opened: !!row.started_at, durationSeconds: seconds, bytesIn: Number(row.bytes_in), bytesOut: Number(row.bytes_out) },
                });
                // A terminal that never started never announced itself, so it doesn't announce its end
                if (row.started_at && box?.home_channel_id) {
                    const text = `**${box.username ?? 'The owner'}**'s terminal in **${box.name}**'s box closed after ${duration(seconds ?? 0)} (${CLOSE_TEXT[reason]}). Wakes for this agent resume.`;
                    notices = [await postNotice(client, box.home_channel_id.trim(), text)];
                }
            }
            await client.query('COMMIT');
        } catch {
            await client.query('ROLLBACK').catch(() => {});
            notices = [];
        } finally {
            client.release();
        }
        if (notices.length) this.emit(notices);
    }

    /** The host started the shell: state `open`, the audit entry and the notice, in one transaction. */
    private async markOpen(l: Live): Promise<void> {
        const client = await this.db.connect();
        let notices: Notice[] = [];
        try {
            await client.query('BEGIN');
            const row = (await client.query(
                `UPDATE box_shell_sessions SET state = 'open', started_at = NOW() WHERE id = $1 AND state = 'opening' RETURNING opened_by`, [l.info.sessionId]
            )).rows[0];
            if (row) {
                const box = (await client.query(
                    `SELECT b.home_channel_id, p.name, u.username, p.id AS profile_id FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id
                     LEFT JOIN users u ON u.id = $2 WHERE b.id = $1`, [l.info.boxId, row.opened_by]
                )).rows[0];
                const run = await activeRunOf(client, box.profile_id);
                await shellAudit(client, {
                    serverId: l.info.serverId, actorId: l.info.userId, action: 'box_terminal_open', boxId: l.info.boxId,
                    changes: { name: box.name, sessionId: l.info.sessionId, activeRun: run, limits: l.info.limits },
                });
                if (box.home_channel_id) {
                    notices = [await postNotice(client, box.home_channel_id.trim(),
                        `**${box.username}** has a terminal open in **${box.name}**'s box. New wakes for this agent are paused until it closes${run ? '; the run in progress keeps going' : ''}.`)];
                }
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        if (notices.length) this.emit(notices);
    }

    // ─── The sweep ───

    private async sweep(): Promise<void> {
        const now = Date.now();
        this.sweeps++;
        // A row with no socket behind it (a handshake that never reached `connection`)
        const orphans = await this.db.query(
            `SELECT id FROM box_shell_sessions WHERE state <> 'closed' AND opened_at < NOW() - interval '30 seconds'`
        );
        for (const r of orphans.rows) if (!this.live.has(r.id.trim())) await this.finish(r.id.trim(), 'no_start', 0, 0);
        for (const [id, l] of [...this.live]) {
            if (l.closing) continue;
            if (l.opened && now - l.lastInputMs > l.info.limits.idleMinutes * 60_000) { await this.close(id, 'idle_timeout'); continue; }
            if (now - l.openedAtMs > l.info.limits.maxHours * 3_600_000) { await this.close(id, 'max_duration'); continue; }
            if (l.sessionEndsMs <= now) { await this.close(id, 'session_ended'); continue; }
            if (l.opened && now >= l.nextReminderMs) {
                l.nextReminderMs = now + 3_600_000;
                await this.remind(l).catch(() => {});
            }
            if (this.sweeps % RECHECK_EVERY === 0) {
                const reason = await this.accessProblem(l).catch(() => null);
                if (reason) await this.close(id, reason);
            }
        }
        if (this.sweeps % RECHECK_EVERY === 0) await this.dropStaleHosts().catch(() => {});
    }

    /** One channel notice an hour while a terminal stays open: it is still pausing wakes. */
    private async remind(l: Live): Promise<void> {
        const client = await this.db.connect();
        let notices: Notice[] = [];
        try {
            await client.query('BEGIN');
            const box = (await client.query(
                `SELECT b.home_channel_id, p.name, u.username FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id
                 LEFT JOIN users u ON u.id = $2 WHERE b.id = $1`, [l.info.boxId, l.info.userId])).rows[0];
            if (box?.home_channel_id) {
                const hours = Math.max(1, Math.round((Date.now() - l.openedAtMs) / 3_600_000));
                notices = [await postNotice(client, box.home_channel_id.trim(),
                    `**${box.username ?? 'The owner'}**'s terminal in **${box.name}**'s box has been open for ${hours} h. It is still open; wakes for **${box.name}** are paused.`)];
            }
            await client.query('COMMIT');
        } catch {
            await client.query('ROLLBACK').catch(() => {});
            notices = [];
        } finally {
            client.release();
        }
        if (notices.length) this.emit(notices);
    }

    /** The box and the owner are still what the ticket said they were. */
    private async accessProblem(l: Live): Promise<CloseReason | null> {
        const box = await shellBox(this.db, l.info.boxId);
        if (!box || box.desired_state !== 'running' || box.state !== 'running' || box.generation !== l.info.generation || box.revoked_at) return 'box_changed';
        if (box.owner_id.trim() !== l.info.userId) return 'access_changed';
        const user = (await this.db.query(`SELECT account_status FROM users WHERE id = $1`, [l.info.userId])).rows[0];
        return user?.account_status === 'active' ? null : 'access_changed';
    }
}

function duration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ─── The handshake (called from src/gateway.ts) ───

export interface ShellAuthDeps {
    db: Pool;
    jwtSecret: string;
    hub: ShellHub;
    /** The box provenance rule for the handshake; resolves to the refusal code or null. */
    provenanceRefused(headers: Record<string, string | string[] | undefined>, cred: ProvenanceCredential): Promise<string | null>;
}

/** The relay credential: `ar_<hostId>.<secret>`. A host token (`ah_`) does not parse. */
const RELAY_TOKEN = /^ar_([0-9A-HJKMNP-TV-Z]{26})\.(.+)$/;
const intOrNull = (v: unknown) => v === null || v === undefined ? null : Number(v);

/** Is this handshake one of the terminal's? Decided on `auth.type` alone, before any other path reads it. */
export const isShellHandshake = (auth: unknown) => {
    const t = (auth as { type?: unknown } | undefined)?.type;
    return t === 'shell' || t === 'relay';
};

/**
 * Authenticate a terminal socket. Every refusal is a fixed code in the Error message (the client
 * shows it) and nothing else: no detail of what was wrong with the ticket.
 */
export async function shellHandshake(d: ShellAuthDeps, socket: Socket, next: (err?: Error) => void): Promise<void> {
    const type = (socket.handshake.auth as { type?: string })?.type;
    try {
        if (type === 'relay') return await relayHandshake(d, socket, next);
        return await browserHandshake(d, socket, next);
    } catch {
        return next(new Error('Invalid token'));
    }
}

async function relayHandshake(d: ShellAuthDeps, socket: Socket, next: (err?: Error) => void): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown; shellProtocol?: unknown };
    const m = typeof auth.token === 'string' ? RELAY_TOKEN.exec(auth.token) : null;
    if (!m) return next(new Error('Malformed relay token'));
    // The relay credential only: the host token's hash is never consulted here
    const row = (await d.db.query(
        `SELECT h.id, h.server_id, h.relay_secret_hash, h.kind, h.box_id, h.box_generation, b.generation AS box_current_generation, b.desired_state
         FROM agent_hosts h LEFT JOIN agent_boxes b ON b.id = h.box_id
         WHERE h.id = $1 AND h.revoked_at IS NULL`, [m[1]]
    )).rows[0];
    if (!row || !row.relay_secret_hash || !await verifyBotSecret(m[2], row.relay_secret_hash)) return next(new Error('Invalid relay token'));
    const refused = await d.provenanceRefused(socket.handshake.headers, {
        kind: 'relay', id: row.id.trim(), serverId: row.server_id.trim(), boxId: row.box_id?.trim() || null,
        generation: intOrNull(row.box_generation), currentGeneration: intOrNull(row.box_current_generation),
    });
    if (refused) return next(new Error(refused));
    // Only a box's own relay takes part, and only while its box lives
    if (row.kind !== 'box' || !row.box_id || row.desired_state === 'deleted') return next(new Error('box_hosts_only'));
    const protocol = Number.isInteger(auth.shellProtocol) ? Math.min(auth.shellProtocol as number, SHELL_PROTOCOL) : 0;
    if (protocol < SHELL_PROTOCOL) return next(new Error('unsupported_protocol'));
    // The agent cannot read the relay credential, but a second socket while the real relay is
    // connected is still refused, audited and announced, and any open terminal is closed
    // (shell-hub.ts registerHost): defence in depth for a leak by any other road
    if (d.hub.hostConnected(row.box_id.trim(), Number(row.box_generation))) {
        d.hub.hostConflict({ boxId: row.box_id.trim(), serverId: row.server_id.trim() }, 'handshake');
        return next(new Error('host_already_connected'));
    }
    await d.db.query(`UPDATE agent_hosts SET shell_protocol = $2 WHERE id = $1`, [row.id, protocol]);
    socket.data.shellHost = { hostId: row.id.trim(), boxId: row.box_id.trim(), serverId: row.server_id.trim(), generation: Number(row.box_generation) } satisfies ShellHostInfo;
    next();
}

async function browserHandshake(d: ShellAuthDeps, socket: Socket, next: (err?: Error) => void): Promise<void> {
    const h = socket.handshake;
    const ticket = (h.auth as { ticket?: unknown })?.ticket;
    // A browser always sends Origin on a WebSocket handshake, and it must be this site's. Unlike the
    // chat socket, a handshake without one is refused: only a browser opens a terminal.
    if (!h.headers.origin || !originAllowed(h.headers) || !originSchemeMatches(h.headers, h.secure)) return next(new Error('origin_not_allowed'));
    // The cookie session only: a bearer token, a bot token or a host token never opens a terminal
    const token = sessionTokenFromHeaders(h.headers);
    if (!token) return next(new Error('Authentication required'));
    let payload;
    try { payload = verifyToken(token, d.jwtSecret); } catch { return next(new Error('Invalid token')); }
    if (!payload.jti) return next(new Error('Invalid token'));
    const limit = sessionLimitError(payload);
    if (limit) return next(new Error(limit));
    if (await isTokenBlacklisted(payload.jti)) return next(new Error('Token revoked'));
    // A person's login never works through a box's edge
    const refused = await d.provenanceRefused(h.headers, { kind: 'user', id: payload.userId, serverId: null, boxId: null, generation: null, currentGeneration: null });
    if (refused) return next(new Error(refused));
    const user = (await d.db.query(`SELECT account_status, token_version, bot FROM users WHERE id = $1`, [payload.userId])).rows[0];
    if (!user || user.bot || (payload.tokenVersion ?? 0) !== user.token_version) return next(new Error('Token revoked'));
    if (user.account_status !== 'active') return next(new Error(`account_${user.account_status}`));
    const userId = payload.userId.trim();

    const refuse = async (code: string, boxId: string | null, serverId: string | null) => {
        await shellRefusal(d.db, { serverId, actorId: userId, boxId, code, via: 'socket' }).catch(() => {});
        return next(new Error(code));
    };
    // Redeemed first, so a probe can't tell a wrong ticket from a ticket for another box or person
    const redeemed = await redeemTicket(d.db, typeof ticket === 'string' ? ticket : '', { userId, jti: payload.jti });
    // A ticket that does not redeem has no box and no owner to attach a row to, and anyone signed in can
    // try: it is counted, not written down
    if (!redeemed) { d.hub.refusedTickets++; return next(new Error('ticket_invalid')); }

    const box = await shellBox(d.db, redeemed.boxId);
    if (!box || box.desired_state === 'deleted') return refuse('box_not_found', redeemed.boxId, null);
    // Ownership again, at redemption: the ticket was issued to an owner, not to whoever holds it now
    if (box.owner_id.trim() !== userId) return refuse('forbidden', redeemed.boxId, box.server_id.trim());
    if (box.generation !== redeemed.generation || box.state !== 'running' || box.desired_state !== 'running' || box.revoked_at) {
        return refuse('box_not_ready', redeemed.boxId, box.server_id.trim());
    }
    if (!d.hub.hostConnected(redeemed.boxId, box.generation)) return refuse(Number(box.shell_protocol) >= SHELL_PROTOCOL ? 'box_not_ready' : 'box_needs_update', redeemed.boxId, box.server_id.trim());

    const sessionId = generateUlid();
    try {
        await d.db.query(
            `INSERT INTO box_shell_sessions (id, box_id, server_id, opened_by, generation) VALUES ($1, $2, $3, $4, $5)`,
            [sessionId, redeemed.boxId, box.server_id.trim(), userId, box.generation]
        );
    } catch (err: any) {
        // The unique index: another terminal is open on this box
        if (err?.code === '23505') return refuse('terminal_in_use', redeemed.boxId, box.server_id.trim());
        throw err;
    }
    socket.data.shell = {
        sessionId, boxId: redeemed.boxId, serverId: box.server_id.trim(), userId, generation: box.generation, limits: limitsOf(box),
    } satisfies ShellBrowserInfo;
    // The same fields the chat socket carries, so a logout, a password change or a suspension drops this socket too
    socket.data.userId = userId;
    socket.data.isBot = false;
    socket.data.tokenVersion = payload.tokenVersion ?? 0;
    socket.data.jti = payload.jti;
    socket.data.cookieSession = true;
    socket.data.tokenExpiresAt = sessionEndsAt(payload);
    next();
}

/** After the handshake: hand the socket to the hub. */
export function shellConnection(hub: ShellHub, socket: Socket): void {
    if (socket.data.shellHost) { hub.registerHost(socket, socket.data.shellHost as ShellHostInfo); return; }
    const info = socket.data.shell as ShellBrowserInfo | undefined;
    if (info) hub.attachBrowser(socket, info, Number(socket.data.tokenExpiresAt));
}

let current: ShellHub | null = null;
export const setShellHub = (hub: ShellHub | null) => { current = hub; };
export const shellHub = (): ShellHub | null => current;

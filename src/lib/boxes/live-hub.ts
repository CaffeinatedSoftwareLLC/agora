import type { Pool } from 'pg';
import type { Socket } from 'socket.io';
import { verifyToken, sessionEndsAt, sessionLimitError } from '../../auth/tokens';
import { isTokenBlacklisted } from '../../auth/token-blacklist';
import { verifyBotSecret } from '../../auth/bot-tokens';
import { originAllowed, originSchemeMatches, sessionTokenFromHeaders } from '../../auth/session-cookie';
import { generateUlid } from '../../utils/ulid';
import { postNotice, type Notice } from '../agent-runs';
import { limitOf } from '../agent-budget-notice';
import { stampAuthority } from '../direct-agents';
import type { ProvenanceCredential } from './provenance';
import { ByteMeter, INPUT_BURST_BYTES, INPUT_RATE_BYTES, MAX_COLS, MAX_INPUT_CHUNK, MAX_ROWS, MAX_BROWSER_BUFFER_BYTES, shellAudit } from './shell';
import { bufferedBytes } from './shell-hub';

/**
 * Live terminals, server side (docs/planning/live-terminals.md). A boxed Claude Code agent in "Live
 * terminal" mode runs its interactive CLI in a pseudo-terminal that its own agora-host (the agent's
 * Unix user, uid 1000) owns. This hub joins that host to the browsers that watch it.
 *
 *  - host socket (`auth.type = 'live'`): the box's agora-host, with its host token, through the box's
 *    edge (the provenance rule of docs/agent-boxes.md section 4.1). It is NOT the owner's terminal
 *    relay (that is another Unix user's process, with a credential the agent cannot read): what the
 *    agent's screen shows can hold the agent's own secrets, and the operator side never sees it.
 *  - viewer socket (`auth.type = 'live-view'`): a person's cookie session. The server owner may watch
 *    and, after a deliberate confirmation, type. People who can direct agents in the session's
 *    channel may watch, read-only. Nobody else is let in.
 *
 * What the hub keeps: a bounded scrollback ring of the screen (memory only, never a database column,
 * never a log line), the session's state, who has the controls, and byte counts. Anything a viewer
 * sends goes to the agent's terminal only, and only from the confirmed owner.
 *
 * Size rule: there is one authoritative terminal size. The owner's page sets it (the most recent size
 * the owner's page reported while the owner holds the keyboard); every other viewer renders at that
 * size, letterboxed, and cannot resize. Backpressure: a viewer that stops reading is dropped, never
 * waited for; the agent's output is never blocked by a viewer.
 */

export const LIVE_PROTOCOL = 1;
export const RING_BYTES = 256 * 1024;
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 32;
/** Output the agent's terminal may send, bytes per second, before the host is told to slow down. */
export const LIVE_RATE_BYTES = 2 * 1024 * 1024;

const intEnv = (name: string, fallback: number) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 ? v : fallback; };
/** The owner's keyboard counts as "having the controls" this long after the last keystroke. */
export const controlIdleMs = () => intEnv('AGORA_LIVE_CONTROL_IDLE_MS', 20_000);
const syncMs = () => intEnv('AGORA_LIVE_SYNC_MS', 3_000);
/** A session with a connected host but no channel connection after this long is reported. */
const channelGraceMs = () => intEnv('AGORA_LIVE_CHANNEL_GRACE_MS', 90_000);

export const LIVE_STATES = ['starting', 'idle', 'working', 'waiting', 'restarting', 'stopped'] as const;
export type LiveState = typeof LIVE_STATES[number];
/** Codes only: the owner's page maps them to sentences. Never screen text. */
export const LIVE_NOTES = ['no_signal', 'notification', 'channel_unavailable', 'exited', 'box_disconnected', 'wake_limit', 'turn_limit'] as const;

/** Bounded scrollback: the newest RING_BYTES of the screen's bytes. */
export class Ring {
    private chunks: Buffer[] = [];
    private size = 0;
    constructor(private max = RING_BYTES) {}
    push(data: Buffer): void {
        if (data.length === 0) return;
        if (data.length >= this.max) { this.chunks = [Buffer.from(data.subarray(data.length - this.max))]; this.size = this.max; return; }
        this.chunks.push(Buffer.from(data));
        this.size += data.length;
        while (this.chunks.length > 1 && this.size - this.chunks[0].length >= this.max) this.size -= this.chunks.shift()!.length;
        if (this.size > this.max) {
            const first = this.chunks[0];
            const cut = this.size - this.max;
            this.chunks[0] = first.subarray(cut);
            this.size -= cut;
        }
    }
    snapshot(): Buffer { return Buffer.concat(this.chunks); }
    get length(): number { return this.size; }
    clear(): void { this.chunks = []; this.size = 0; }
}

export interface LiveHostInfo { hostId: string; boxId: string; serverId: string; generation: number }
export interface LiveViewerInfo { sessionId: string; userId: string; username: string; role: 'owner' | 'watcher'; sessionEndsMs: number }

interface Viewer {
    socket: Socket; info: LiveViewerInfo; confirmed: boolean; inMeter: ByteMeter; bytesIn: number;
}

interface Sess {
    sessionId: string; boxId: string; serverId: string; channelId: string; botId: string; ownerId: string;
    profile: string; channelName: string;
    state: LiveState; note: string | null; stateAtMs: number; startedAtMs: number;
    ring: Ring; cols: number; rows: number;
    viewers: Map<string, Viewer>;
    lastOwnerInputMs: number; controlsBy: string | null; held: boolean; limitHeld: boolean;
    outMeter: ByteMeter; bytesOut: number; bytesIn: number;
    /** The open turn, if any */
    turn: { id: string; startedMs: number; interrupted: boolean } | null;
    wakeLimit: number | null; turnLimitSec: number | null;
    channelNoticeSent: boolean;
    persisted: string;
}

type Emit = (notices: Notice[]) => void;
export interface LiveDeps {
    /** Send an event to every socket of a bot (its `user:<id>` room) */
    emitToBot(botId: string, event: string, payload: unknown): void;
    /** Does the bot hold a Claude Code Channel connection (agora-mcp --channel-mode) right now? */
    botChannelConnected(botId: string): boolean;
}

const isBytes = (d: unknown): d is Buffer | Uint8Array => d instanceof Uint8Array;
const dims = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max ? v as number : null;

export class LiveHub {
    private hosts = new Map<string, { socket: Socket; info: LiveHostInfo; allowed: Set<string>; sent: string }>();
    private sessions = new Map<string, Sess>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private holdTimer: ReturnType<typeof setInterval> | null = null;
    private pending = new Set<Promise<unknown>>();
    /** Counted, never logged: events from a viewer that may not send them, and handshakes refused. */
    deniedInput = 0;
    refusedViewers = 0;
    maxViewerBuffer = MAX_BROWSER_BUFFER_BYTES;

    constructor(private db: Pool, private emit: Emit, private deps: LiveDeps) {}

    async start(): Promise<void> {
        this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, syncMs());
        this.timer.unref();
        this.holdTimer = setInterval(() => { for (const s of this.sessions.values()) this.applyHold(s); }, 1_000);
        this.holdTimer.unref();
    }
    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        if (this.holdTimer) clearInterval(this.holdTimer);
        this.timer = this.holdTimer = null;
        for (const s of [...this.sessions.values()]) this.dropViewers(s, 'server_stopped');
        await this.drain();
    }
    async drain(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }
    private track<T>(p: Promise<T>): Promise<T> {
        this.pending.add(p);
        const done = () => { this.pending.delete(p); };
        p.then(done, done);
        return p;
    }

    // ─── Queries ───

    hostConnected(boxId: string, generation?: number): boolean {
        const h = this.hosts.get(boxId);
        return !!h && h.socket.connected && (generation === undefined || h.info.generation === generation);
    }
    /** What the session sheet and the viewer page show. Null for a session the hub has not heard of. */
    stateOf(sessionId: string): { state: LiveState; note: string | null; controlsBy: string | null; held: boolean; cols: number; rows: number; viewers: number } | null {
        const s = this.sessions.get(sessionId);
        return s ? { state: s.state, note: s.note, controlsBy: s.controlsBy, held: s.held, cols: s.cols, rows: s.rows, viewers: s.viewers.size } : null;
    }
    ringOf(sessionId: string): Buffer | null { return this.sessions.get(sessionId)?.ring.snapshot() ?? null; }
    isHeld(botId: string): boolean {
        for (const s of this.sessions.values()) if (s.botId === botId && s.held) return true;
        return false;
    }

    // ─── What the box should be running ───

    /** The live sessions of this box's agent, as the box's host should run them. Also the host's allow-list. */
    private async desired(boxId: string): Promise<Array<Record<string, unknown>>> {
        const rows = (await this.db.query(
            `SELECT s.id, s.channel_id, s.bot_id, s.native_session_id, s.wakes_used, c.name AS channel_name, p.name AS profile, p.wake_budget, p.model, p.effort,
                    p.run_timeout_sec, srv.owner_id, b.server_id
             FROM agent_boxes b
             JOIN agent_profiles p ON p.id = b.profile_id
             JOIN agent_sessions s ON s.profile_id = p.id AND s.live_mode AND s.state = 'live' AND s.thread_id IS NULL
             JOIN channels c ON c.id = s.channel_id
             JOIN servers srv ON srv.id = b.server_id
             WHERE b.id = $1 AND b.desired_state = 'running' AND p.session_mode = 'live'`, [boxId]
        )).rows;
        return rows.map((r: any) => ({
            sessionId: r.id.trim(), channelId: r.channel_id.trim(), channelName: r.channel_name, botId: r.bot_id.trim(),
            conversation: r.native_session_id, profile: r.profile, ownerId: r.owner_id.trim(), serverId: r.server_id.trim(),
            model: r.model ?? null, effort: r.effort ?? null, wakesUsed: Number(r.wakes_used), wakeLimit: limitOf(r.wake_budget), turnLimitSec: limitOf(r.run_timeout_sec),
        }));
    }

    /** Push the box's desired set to its host (when it changed), and bring our session records in line. */
    async syncBox(boxId: string): Promise<void> {
        const h = this.hosts.get(boxId);
        if (!h || !h.socket.connected) return;
        const want = await this.desired(boxId);
        h.allowed = new Set(want.map(w => w.sessionId as string));
        for (const w of want) this.ensure(h.info, w as any);
        const wire = want.map(w => ({ sessionId: w.sessionId, channelId: w.channelId, channelName: w.channelName, botId: w.botId, conversation: w.conversation, model: w.model, effort: w.effort,
            profile: w.profile, cols: this.sessions.get(w.sessionId as string)?.cols ?? DEFAULT_COLS, rows: this.sessions.get(w.sessionId as string)?.rows ?? DEFAULT_ROWS }));
        const sent = JSON.stringify(wire.map(w => [w.sessionId, w.conversation]));
        if (sent !== h.sent) { h.sent = sent; h.socket.emit('live:desired', { sessions: wire }); }
        // Sessions that are no longer wanted: their viewers are told, the record goes
        for (const s of [...this.sessions.values()]) {
            if (s.boxId === boxId && !h.allowed.has(s.sessionId)) {
                await this.endTurn(s, 'session_ended', null, null).catch(() => {});
                this.dropViewers(s, 'session_ended');
                this.deps.emitToBot(s.botId, 'ChannelHold', { held: false, sessionId: s.sessionId, reason: null });
                this.sessions.delete(s.sessionId);
            }
        }
    }

    private ensure(host: LiveHostInfo, w: { sessionId: string; channelId: string; channelName: string; botId: string; profile: string; ownerId: string; wakesUsed: number; wakeLimit: number | null; turnLimitSec: number | null }): Sess {
        let s = this.sessions.get(w.sessionId);
        if (!s) {
            s = {
                sessionId: w.sessionId, boxId: host.boxId, serverId: host.serverId, channelId: w.channelId, botId: w.botId, ownerId: w.ownerId,
                profile: w.profile, channelName: w.channelName, state: 'starting', note: null, stateAtMs: Date.now(), startedAtMs: Date.now(),
                ring: new Ring(), cols: DEFAULT_COLS, rows: DEFAULT_ROWS, viewers: new Map(), lastOwnerInputMs: 0, controlsBy: null, held: false, limitHeld: false,
                outMeter: new ByteMeter(LIVE_RATE_BYTES, LIVE_RATE_BYTES, 0), bytesOut: 0, bytesIn: 0, turn: null,
                wakeLimit: w.wakeLimit, turnLimitSec: w.turnLimitSec, channelNoticeSent: false, persisted: '',
            };
            this.sessions.set(w.sessionId, s);
        }
        s.wakeLimit = w.wakeLimit; s.turnLimitSec = w.turnLimitSec;
        const limited = s.wakeLimit !== null && w.wakesUsed >= s.wakeLimit;
        if (limited !== s.limitHeld) { s.limitHeld = limited; this.applyHold(s); }
        return s;
    }

    // ─── Host sockets ───

    registerHost(socket: Socket, info: LiveHostInfo): boolean {
        const old = this.hosts.get(info.boxId);
        if (old && old.socket !== socket && old.socket.connected && old.info.generation === info.generation) {
            socket.emit('live:refused', { code: 'host_already_connected' });
            socket.disconnect(true);
            return false;
        }
        if (old && old.socket !== socket) old.socket.disconnect(true);
        const entry = { socket, info, allowed: new Set<string>(), sent: '' };
        this.hosts.set(info.boxId, entry);
        const mine = (id: unknown): Sess | null => {
            if (typeof id !== 'string' || !entry.allowed.has(id)) return null;
            const s = this.sessions.get(id);
            return s && s.boxId === info.boxId ? s : null;
        };
        socket.on('live:output', (m: { sessionId?: unknown; data?: unknown }) => {
            const s = mine(m?.sessionId);
            if (!s || !isBytes(m.data) || m.data.byteLength === 0 || m.data.byteLength > 256 * 1024) return;
            this.onOutput(s, Buffer.from(m.data), socket);
        });
        // After a reconnect the host sends what its own ring holds; used only when ours is empty (the server restarted)
        socket.on('live:replay', (m: { sessionId?: unknown; data?: unknown }) => {
            const s = mine(m?.sessionId);
            if (!s || !isBytes(m.data) || m.data.byteLength > RING_BYTES || s.ring.length > 0) return;
            s.ring.push(Buffer.from(m.data));
        });
        socket.on('live:state', (m: { sessionId?: unknown; state?: unknown; note?: unknown; cols?: unknown; rows?: unknown }) => {
            const s = mine(m?.sessionId);
            if (!s || !LIVE_STATES.includes(m.state as LiveState)) return;
            const note = typeof m.note === 'string' && (LIVE_NOTES as readonly string[]).includes(m.note) ? m.note : null;
            this.setState(s, m.state as LiveState, note);
        });
        socket.on('live:turn', (m: { sessionId?: unknown; phase?: unknown; messageId?: unknown; source?: unknown; branch?: unknown; sha?: unknown; signal?: unknown }) => {
            const s = mine(m?.sessionId);
            if (!s) return;
            const sha = typeof m.sha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(m.sha) ? m.sha : null;
            const branch = typeof m.branch === 'string' && m.branch.length <= 255 && !/[\0-\x1f]/.test(m.branch) ? m.branch : null;
            if (m.phase === 'start') {
                const messageId = typeof m.messageId === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(m.messageId) ? m.messageId : null;
                void this.track(this.startTurn(s, messageId, branch, sha)).catch(() => {});
            } else if (m.phase === 'end') {
                const signal = m.signal === 'stop_hook' ? 'stop_hook' : 'interrupted';
                void this.track(this.endTurn(s, signal, branch, sha)).catch(() => {});
            }
        });
        socket.on('live:exited', (m: { sessionId?: unknown }) => {
            const s = mine(m?.sessionId);
            if (!s) return;
            void this.track(this.endTurn(s, 'session_ended', null, null)).catch(() => {});
            this.setState(s, 'restarting', 'exited');
        });
        socket.on('disconnect', () => {
            if (this.hosts.get(info.boxId)?.socket !== socket) return;
            this.hosts.delete(info.boxId);
            for (const s of this.sessions.values()) {
                if (s.boxId !== info.boxId) continue;
                void this.track(this.endTurn(s, 'host_lost', null, null)).catch(() => {});
                this.setState(s, 'stopped', 'box_disconnected');
            }
        });
        void this.track(this.syncBox(info.boxId)).catch(() => {});
        return true;
    }

    private onOutput(s: Sess, data: Buffer, host: Socket): void {
        s.bytesOut += data.length;
        s.ring.push(data);
        // The host paces itself when told; a host that ignores it is not closed (it is the agent's own work), only slowed
        if (!s.outMeter.add(data.length)) host.emit('live:pace', { sessionId: s.sessionId, ms: 500 });
        for (const [id, v] of s.viewers) {
            if (!v.socket.connected) continue;
            if (bufferedBytes(v.socket) > this.maxViewerBuffer) { this.dropViewer(s, id, 'viewer_stalled'); continue; }
            v.socket.emit('live:output', data);
        }
    }

    // ─── State, controls and holds ───

    private setState(s: Sess, state: LiveState, note: string | null): void {
        if (s.state === state && s.note === note) return;
        const was = s.state;
        s.state = state; s.note = note; s.stateAtMs = Date.now();
        if (state !== 'idle' && state !== 'working') s.channelNoticeSent = false;
        this.toViewers(s, 'live:state', { state, note });
        void this.track(this.persist(s)).catch(() => {});
        if (state === 'waiting' && was !== 'waiting') {
            void this.track(this.say(s, `**${s.profile}** is waiting on you in its terminal${note === 'no_signal' ? ' (the CLI is showing a startup prompt)' : ''}. Open its terminal to answer.`)).catch(() => {});
        }
    }

    private async persist(s: Sess): Promise<void> {
        const key = `${s.state}/${s.note}`;
        if (key === s.persisted) return;
        s.persisted = key;
        await this.db.query(`UPDATE agent_sessions SET live_state = $2, live_note = $3, live_state_at = NOW() WHERE id = $1 AND live_mode`, [s.sessionId, s.state, s.note]);
    }

    private controlsActive(s: Sess, now = Date.now()): boolean {
        if (!s.lastOwnerInputMs || now - s.lastOwnerInputMs >= controlIdleMs()) return false;
        for (const v of s.viewers.values()) if (v.info.role === 'owner' && v.socket.connected && v.confirmed) return true;
        return false;
    }

    /** Recompute whether deliveries to this agent are held, and tell the bot's channel connection and the viewers. */
    applyHold(s: Sess): void {
        const controls = this.controlsActive(s);
        const owner = controls ? [...s.viewers.values()].find(v => v.info.role === 'owner')?.info.username ?? null : null;
        const held = controls || s.limitHeld;
        const changed = held !== s.held || owner !== s.controlsBy;
        s.held = held; s.controlsBy = owner;
        if (!changed) return;
        this.deps.emitToBot(s.botId, 'ChannelHold', { held, sessionId: s.sessionId, reason: controls ? 'controls' : s.limitHeld ? 'wake_limit' : null });
        this.toViewers(s, 'live:controls', { by: owner, held, reason: controls ? 'controls' : s.limitHeld ? 'wake_limit' : null });
    }

    /** A bot's channel connection just came up: tell it whether it is being held. */
    botConnected(botId: string, socket: { emit(e: string, p: unknown): unknown }): void {
        for (const s of this.sessions.values()) {
            if (s.botId === botId && s.held) socket.emit('ChannelHold', { held: true, sessionId: s.sessionId, reason: s.limitHeld && !this.controlsActive(s) ? 'wake_limit' : 'controls' });
        }
    }

    private toViewers(s: Sess, event: string, payload: unknown): void {
        for (const v of s.viewers.values()) if (v.socket.connected) v.socket.emit(event, payload);
    }

    // ─── Turns ───

    private async startTurn(s: Sess, messageId: string | null, branch: string | null, sha: string | null): Promise<void> {
        if (s.turn) await this.endTurn(s, 'host_lost', branch, sha);
        const id = generateUlid();
        s.turn = { id, startedMs: Date.now(), interrupted: false };
        const client = await this.db.connect();
        let notices: Notice[] = [];
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO live_terminal_turns (id, session_id, server_id, channel_id, message_id, source, branch, start_sha)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [id, s.sessionId, s.serverId, s.channelId, messageId, messageId ? 'message' : 'typed', branch, sha]);
            // One wake per turn (docs/agent-limits.md): a turn the owner typed is not a wake
            const used = messageId ? Number((await client.query(
                `UPDATE agent_sessions SET wakes_used = wakes_used + 1, last_active_at = NOW() WHERE id = $1 RETURNING wakes_used`, [s.sessionId])).rows[0]?.wakes_used ?? 0) : 0;
            // The limit is read now: the owner may have changed it since the last sync
            if (messageId) s.wakeLimit = limitOf((await client.query(`SELECT p.wake_budget FROM agent_sessions x JOIN agent_profiles p ON p.id = x.profile_id WHERE x.id = $1`, [s.sessionId])).rows[0]?.wake_budget);
            if (messageId && s.wakeLimit !== null && used >= s.wakeLimit && !s.limitHeld) {
                s.limitHeld = true;
                notices = [await postNotice(client, s.channelId,
                    `**${s.profile}** has used its wake limit (${used} of ${s.wakeLimit}). Further messages are held, not delivered, until the limit is lifted in Settings → Agents.`)];
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            s.turn = null;
            throw err;
        } finally {
            client.release();
        }
        if (notices.length) this.emit(notices);
        this.applyHold(s);
    }

    private async endTurn(s: Sess, signal: 'stop_hook' | 'interrupted' | 'session_ended' | 'host_lost', branch: string | null, sha: string | null): Promise<void> {
        const t = s.turn;
        if (!t) return;
        s.turn = null;
        await this.db.query(
            `UPDATE live_terminal_turns SET ended_at = NOW(), end_signal = $2::text, end_sha = $3::text, branch = COALESCE(branch, $4::text),
                    verified = ($2::text = 'stop_hook' AND start_sha IS NOT NULL AND $3::text IS NOT NULL),
                    unverified_reason = CASE WHEN $2::text <> 'stop_hook' THEN 'no_idle_signal' WHEN start_sha IS NULL OR $3::text IS NULL THEN 'no_commit_read' ELSE NULL END
             WHERE id = $1 AND ended_at IS NULL`, [t.id, signal, sha, branch]);
    }

    // ─── Notices ───

    private async say(s: Sess, text: string): Promise<void> {
        const client = await this.db.connect();
        let notices: Notice[] = [];
        try {
            await client.query('BEGIN');
            notices = [await postNotice(client, s.channelId, text)];
            await client.query('COMMIT');
        } catch { await client.query('ROLLBACK').catch(() => {}); notices = []; } finally { client.release(); }
        if (notices.length) this.emit(notices);
    }

    // ─── Viewers ───

    attachViewer(socket: Socket, info: LiveViewerInfo): void {
        const s = this.sessions.get(info.sessionId);
        if (!s || !socket.connected) { this.refusedViewers++; socket.emit('live:exit', { reason: 'not_running' }); setTimeout(() => socket.disconnect(true), 50).unref(); return; }
        const v: Viewer = { socket, info, confirmed: false, inMeter: new ByteMeter(INPUT_RATE_BYTES, INPUT_BURST_BYTES, INPUT_BURST_BYTES), bytesIn: 0 };
        s.viewers.set(socket.id, v);
        socket.emit('live:ready', {
            role: info.role, state: s.state, note: s.note, cols: s.cols, rows: s.rows, profile: s.profile, channelName: s.channelName,
            controlsBy: s.controlsBy, held: s.held, hostConnected: this.hostConnected(s.boxId),
        });
        const snap = s.ring.snapshot();
        if (snap.length) socket.emit('live:replay', snap);
        // Everything below is accepted from the owner's confirmed socket only
        socket.on('live:take', (m: { ack?: unknown }) => {
            if (info.role !== 'owner' || m?.ack !== true || v.confirmed) { if (info.role !== 'owner') this.deniedInput++; return; }
            v.confirmed = true;
            socket.emit('live:taken', {});
            void this.track(this.audit(s, info.userId, 'live_terminal_take')).catch(() => {});
        });
        socket.on('live:input', (data: unknown) => {
            if (info.role !== 'owner' || !v.confirmed || !socket.connected) { this.deniedInput++; return; }
            const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : isBytes(data) ? Buffer.from(data) : null;
            const host = this.hosts.get(s.boxId);
            if (!bytes || bytes.length === 0 || !host?.socket.connected) return;
            if (bytes.length > MAX_INPUT_CHUNK || !v.inMeter.add(bytes.length)) { this.dropViewer(s, socket.id, 'input_flood'); return; }
            v.bytesIn += bytes.length; s.bytesIn += bytes.length;
            s.lastOwnerInputMs = Date.now();
            host.socket.emit('live:input', { sessionId: s.sessionId, data: bytes });
            this.applyHold(s);
        });
        socket.on('live:resize', (m: { cols?: unknown; rows?: unknown }) => {
            if (info.role !== 'owner' || !v.confirmed) { this.deniedInput++; return; }
            const cols = dims(m?.cols, MAX_COLS), rows = dims(m?.rows, MAX_ROWS);
            if (!cols || !rows || (cols === s.cols && rows === s.rows)) return;
            s.cols = cols; s.rows = rows;
            this.hosts.get(s.boxId)?.socket.emit('live:resize', { sessionId: s.sessionId, cols, rows });
            this.toViewers(s, 'live:size', { cols, rows });
        });
        socket.on('live:leave', () => this.dropViewer(s, socket.id, 'left'));
        socket.on('disconnect', () => { s.viewers.delete(socket.id); this.applyHold(s); });
        this.applyHold(s);
    }

    private dropViewer(s: Sess, socketId: string, reason: string): void {
        const v = s.viewers.get(socketId);
        if (!v) return;
        s.viewers.delete(socketId);
        if (v.socket.connected) { v.socket.emit('live:exit', { reason }); setTimeout(() => v.socket.disconnect(true), 50).unref(); }
        this.applyHold(s);
    }
    private dropViewers(s: Sess, reason: string): void { for (const id of [...s.viewers.keys()]) this.dropViewer(s, id, reason); }

    private async audit(s: Sess, userId: string, action: string): Promise<void> {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            await shellAudit(client, { serverId: s.serverId, actorId: userId, action, boxId: s.boxId, changes: { sessionId: s.sessionId, profile: s.profile } });
            await client.query('COMMIT');
        } catch { await client.query('ROLLBACK').catch(() => {}); } finally { client.release(); }
    }

    // ─── The sweep ───

    async sweep(): Promise<void> {
        const now = Date.now();
        for (const boxId of [...this.hosts.keys()]) await this.syncBox(boxId).catch(() => {});
        for (const s of this.sessions.values()) {
            // Turn time limit: the CLI is interrupted once (Escape), the channel is told
            if (s.turn && !s.turn.interrupted && s.turnLimitSec !== null && now - s.turn.startedMs > s.turnLimitSec * 1000) {
                s.turn.interrupted = true;
                this.hosts.get(s.boxId)?.socket.emit('live:interrupt', { sessionId: s.sessionId });
                void this.track(this.say(s, `**${s.profile}**'s turn passed its run-time limit (${Math.round(s.turnLimitSec / 60)} min) and was interrupted.`)).catch(() => {});
            }
            // The Channel is the only delivery road: say so when it is not connected, never type instead
            const alive = (s.state === 'idle' || s.state === 'working') && this.hostConnected(s.boxId);
            if (alive && !this.deps.botChannelConnected(s.botId)) {
                if (now - s.stateAtMs > channelGraceMs() && s.note !== 'channel_unavailable') {
                    s.note = 'channel_unavailable';
                    this.toViewers(s, 'live:state', { state: s.state, note: s.note });
                    void this.track(this.persist(s)).catch(() => {});
                    if (!s.channelNoticeSent) {
                        s.channelNoticeSent = true;
                        void this.track(this.say(s, `**${s.profile}**'s live terminal is running, but its Claude Code Channel is not connected, so chat messages cannot reach it. `
                            + 'They are not typed into the terminal. Open the terminal to see why (the channel flag may have been refused, or a startup prompt is waiting).')).catch(() => {});
                    }
                }
            } else if (alive && s.note === 'channel_unavailable') { s.note = null; this.toViewers(s, 'live:state', { state: s.state, note: null }); void this.track(this.persist(s)).catch(() => {}); }
            for (const [id, v] of s.viewers) {
                if (v.info.sessionEndsMs <= now) this.dropViewer(s, id, 'session_ended');
            }
            this.applyHold(s);
        }
        // Viewers' access is re-checked now and then
        for (const s of this.sessions.values()) {
            for (const [id, v] of [...s.viewers]) {
                const still = await viewerRole(this.db, s.sessionId, v.info.userId).catch(() => null);
                if (still !== v.info.role) this.dropViewer(s, id, 'access_changed');
            }
        }
    }
}

// ─── Who may watch ───

/** 'owner', 'watcher' (can direct agents in the session's channel) or null: the person's role for this live session. */
export async function viewerRole(db: Pool, sessionId: string, userId: string): Promise<'owner' | 'watcher' | null> {
    const row = (await db.query(
        `SELECT s.channel_id, s.server_id, srv.owner_id, u.account_status, u.bot
         FROM agent_sessions s JOIN servers srv ON srv.id = s.server_id JOIN users u ON u.id = $2
         WHERE s.id = $1 AND s.live_mode AND s.state = 'live'`, [sessionId, userId])).rows[0];
    if (!row || row.bot || row.account_status !== 'active') return null;
    if (row.owner_id.trim() === userId.trim()) return 'owner';
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const can = await stampAuthority(client, row.channel_id.trim(), userId, false);
        await client.query('ROLLBACK');
        return can ? 'watcher' : null;
    } catch { await client.query('ROLLBACK').catch(() => {}); return null; } finally { client.release(); }
}

// ─── The handshake (called from src/gateway.ts) ───

export interface LiveAuthDeps {
    db: Pool;
    jwtSecret: string;
    hub: LiveHub;
    provenanceRefused(headers: Record<string, string | string[] | undefined>, cred: ProvenanceCredential): Promise<string | null>;
}

export const isLiveHandshake = (auth: unknown) => {
    const t = (auth as { type?: unknown } | undefined)?.type;
    return t === 'live' || t === 'live-view';
};

const HOST_TOKEN = /^ah_([0-9A-HJKMNP-TV-Z]{26})\.(.+)$/;
const intOrNull = (v: unknown) => v === null || v === undefined ? null : Number(v);

export async function liveHandshake(d: LiveAuthDeps, socket: Socket, next: (err?: Error) => void): Promise<void> {
    const type = (socket.handshake.auth as { type?: string })?.type;
    try {
        return type === 'live' ? await hostHandshake(d, socket, next) : await viewerHandshake(d, socket, next);
    } catch {
        return next(new Error('Invalid token'));
    }
}

async function hostHandshake(d: LiveAuthDeps, socket: Socket, next: (err?: Error) => void): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown; liveProtocol?: unknown };
    const m = typeof auth.token === 'string' ? HOST_TOKEN.exec(auth.token) : null;
    if (!m) return next(new Error('Malformed host token'));
    const row = (await d.db.query(
        `SELECT h.id, h.server_id, h.secret_hash, h.kind, h.box_id, h.box_generation, b.generation AS box_current_generation, b.desired_state
         FROM agent_hosts h LEFT JOIN agent_boxes b ON b.id = h.box_id WHERE h.id = $1 AND h.revoked_at IS NULL`, [m[1]])).rows[0];
    if (!row || !await verifyBotSecret(m[2], row.secret_hash)) return next(new Error('Invalid host token'));
    const refused = await d.provenanceRefused(socket.handshake.headers, {
        kind: 'host', id: row.id.trim(), serverId: row.server_id.trim(), boxId: row.box_id?.trim() || null,
        generation: intOrNull(row.box_generation), currentGeneration: intOrNull(row.box_current_generation),
    });
    if (refused) return next(new Error(refused));
    // Live terminals are for boxes: on a machine this would be a pty on the owner's own computer
    if (row.kind !== 'box' || !row.box_id || row.desired_state === 'deleted') return next(new Error('box_hosts_only'));
    const protocol = Number.isInteger(auth.liveProtocol) ? Math.min(auth.liveProtocol as number, LIVE_PROTOCOL) : 0;
    if (protocol < LIVE_PROTOCOL) return next(new Error('unsupported_protocol'));
    if (d.hub.hostConnected(row.box_id.trim(), Number(row.box_generation))) return next(new Error('host_already_connected'));
    await d.db.query(`UPDATE agent_hosts SET live_protocol = $2 WHERE id = $1`, [row.id, protocol]);
    socket.data.liveHost = { hostId: row.id.trim(), boxId: row.box_id.trim(), serverId: row.server_id.trim(), generation: Number(row.box_generation) } satisfies LiveHostInfo;
    next();
}

async function viewerHandshake(d: LiveAuthDeps, socket: Socket, next: (err?: Error) => void): Promise<void> {
    const h = socket.handshake;
    const sessionId = (h.auth as { sessionId?: unknown })?.sessionId;
    // Only a browser watches: an Origin header is required, and the cookie session, never a bearer token
    if (!h.headers.origin || !originAllowed(h.headers) || !originSchemeMatches(h.headers, h.secure)) return next(new Error('origin_not_allowed'));
    const token = sessionTokenFromHeaders(h.headers);
    if (!token) return next(new Error('Authentication required'));
    let payload;
    try { payload = verifyToken(token, d.jwtSecret); } catch { return next(new Error('Invalid token')); }
    if (!payload.jti) return next(new Error('Invalid token'));
    const limit = sessionLimitError(payload);
    if (limit) return next(new Error(limit));
    if (await isTokenBlacklisted(payload.jti)) return next(new Error('Token revoked'));
    const refused = await d.provenanceRefused(h.headers, { kind: 'user', id: payload.userId, serverId: null, boxId: null, generation: null, currentGeneration: null });
    if (refused) return next(new Error(refused));
    const user = (await d.db.query(`SELECT username, account_status, token_version, bot FROM users WHERE id = $1`, [payload.userId])).rows[0];
    if (!user || user.bot || (payload.tokenVersion ?? 0) !== user.token_version) return next(new Error('Token revoked'));
    if (user.account_status !== 'active') return next(new Error(`account_${user.account_status}`));
    const userId = payload.userId.trim();
    if (typeof sessionId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId)) { d.hub.refusedViewers++; return next(new Error('forbidden')); }
    // "No such session" and "not yours to watch" answer the same
    const role = await viewerRole(d.db, sessionId, userId);
    if (!role) { d.hub.refusedViewers++; return next(new Error('forbidden')); }
    socket.data.liveView = { sessionId, userId, username: user.username, role, sessionEndsMs: Number(sessionEndsAt(payload)) } satisfies LiveViewerInfo;
    // The same fields the chat socket carries, so a logout, a password change or a suspension drops this socket too
    socket.data.userId = userId;
    socket.data.isBot = false;
    socket.data.tokenVersion = payload.tokenVersion ?? 0;
    socket.data.jti = payload.jti;
    socket.data.cookieSession = true;
    socket.data.tokenExpiresAt = sessionEndsAt(payload);
    next();
}

export function liveConnection(hub: LiveHub, socket: Socket): void {
    if (socket.data.liveHost) { hub.registerHost(socket, socket.data.liveHost as LiveHostInfo); return; }
    const info = socket.data.liveView as LiveViewerInfo | undefined;
    if (info) hub.attachViewer(socket, info);
}

let current: LiveHub | null = null;
export const setLiveHub = (hub: LiveHub | null) => { current = hub; };
export const liveHub = (): LiveHub | null => current;

import type { Pool } from 'pg';
import type { Socket } from 'socket.io';
import { verifyToken, sessionEndsAt, sessionLimitError } from '../../auth/tokens';
import { isTokenBlacklisted } from '../../auth/token-blacklist';
import { verifyBotSecret } from '../../auth/bot-tokens';
import { originAllowed, originSchemeMatches, sessionTokenFromHeaders } from '../../auth/session-cookie';
import { generateUlid } from '../../utils/ulid';
import { postNotice, recheckLiveRows, type Notice } from '../agent-runs';
import { limitOf } from '../agent-budget-notice';
import { stampAuthority } from '../direct-agents';
import { socketAccountError } from '../gateway-access';
import type { ProvenanceCredential } from './provenance';
import { ByteMeter, INPUT_BURST_BYTES, INPUT_RATE_BYTES, MAX_COLS, MAX_INPUT_CHUNK, MAX_ROWS, MAX_BROWSER_BUFFER_BYTES, shellAudit } from './shell';
import { bufferedBytes } from './shell-hub';

/**
 * Live terminals, server side (docs/planning/live-terminals.md). A boxed Claude Code agent in "Live
 * terminal" mode runs its interactive CLI in a pseudo-terminal that its own agora-host (the agent's
 * Unix user, uid 1000) owns. This hub joins that host to the browsers that watch it, and delivers
 * chat messages to it.
 *
 *  - host socket (`auth.type = 'live'`): the box's agora-host, with its host token, through the box's
 *    edge. NOT the owner's terminal relay (another Unix user, a credential the agent cannot read).
 *  - viewer socket (`auth.type = 'live-view'`): a person's cookie session. The server owner may watch
 *    and, after a deliberate confirmation, type. People who can direct agents in the channel may
 *    watch, read-only. Nobody else is let in.
 *
 * THE SERVER ROUTES, THE CHANNEL ONLY CARRIES. A live session is an ordinary hosted session for the
 * server's routing (src/lib/agent-sessions.ts: mention, sole agent, thread follow-up, task thread,
 * protocol, handoff; mayDirect, termsAllow, owner-bot authority, the plan-owner rule, started_by, the
 * loop guard). Routing writes an inbox row; `dispatch()` below counts the wake (against the wake limit,
 * at that moment, server-side), then tells that session's agora-mcp to push exactly that message,
 * pinned to the session id. agora-mcp acknowledges it; what is not acknowledged is sent again, in
 * order, when the channel connection comes up. The hold while the owner has the controls is applied
 * here: held rows simply wait. Nothing a hook says can change a wake count or a limit.
 *
 * What is cooperative and what is enforced: the state shown to people (working, idle, waiting) and the
 * turn record come from hooks in the agent's own CLI and are display only. Wake counting, the hold, and
 * the run-time stop (Escape, Escape, Ctrl-C, then a restart of the CLI) are done by the server and the
 * host, not by anything the CLI reports.
 *
 * What the hub keeps: a bounded scrollback ring of the screen (memory only, never a database column,
 * never a log line), the session's state, who has the controls, and byte counts.
 */

export const LIVE_PROTOCOL = 1;
export const RING_BYTES = 256 * 1024;
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 32;
/** Output the agent's terminal may send, bytes per second, before the host is told to slow down. */
export const LIVE_RATE_BYTES = 2 * 1024 * 1024;
export const MAX_VIEWERS_PER_USER = 5;
export const MAX_VIEWERS_PER_SESSION = 25;
/** Turn rows kept per session (the oldest go). */
export const MAX_TURNS_PER_SESSION = 500;
const MAX_DB_IN_FLIGHT = 8;

const intEnv = (name: string, fallback: number) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 ? v : fallback; };
/** The owner's keyboard counts as "having the controls" this long after the last keystroke. */
export const controlIdleMs = () => intEnv('AGORA_LIVE_CONTROL_IDLE_MS', 20_000);
const syncMs = () => intEnv('AGORA_LIVE_SYNC_MS', 3_000);
const dispatchMs = () => intEnv('AGORA_LIVE_DISPATCH_MS', 1_000);
/** A session with a connected host but no channel connection after this long is reported. */
const channelGraceMs = () => intEnv('AGORA_LIVE_CHANNEL_GRACE_MS', 90_000);
/** How often the viewers' access and the host connections are checked again */
const accessRecheckMs = () => intEnv('AGORA_LIVE_ACCESS_RECHECK_MS', 15_000);
/** Between the steps of a run-time stop (Escape, Escape, Ctrl-C, restart) */
const escalateMs = () => intEnv('AGORA_LIVE_ESCALATE_MS', 15_000);
/** A pushed message not acknowledged by then is sent again */
const redeliverMs = () => intEnv('AGORA_LIVE_REDELIVER_MS', 30_000);
/** A message still undelivered after this long is said in the channel, once */
const undeliveredMs = () => intEnv('AGORA_LIVE_UNDELIVERED_MS', 10 * 60_000);
/** A host that keeps ignoring `live:pace` for this long is dropped */
const paceIgnoreMs = () => intEnv('AGORA_LIVE_PACE_IGNORE_MS', 10_000);
/** Control events a host may send: per second, and in a burst */
const eventRate = () => intEnv('AGORA_LIVE_EVENT_RATE', 20);
const eventBurst = () => intEnv('AGORA_LIVE_EVENT_BURST', 50);
/** The same notice for one session is said at most this often */
const noticeEveryMs = () => intEnv('AGORA_LIVE_NOTICE_EVERY_MS', 10 * 60_000);

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

/** A token bucket: `rate` a second, `burst` at once. */
export class Bucket {
    private tokens: number;
    private last: number;
    constructor(private rate: number, private burst: number, now = Date.now()) { this.tokens = burst; this.last = now; }
    take(now = Date.now()): boolean {
        this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
        this.last = now;
        if (this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }
}

export interface LiveHostInfo { hostId: string; boxId: string; serverId: string; generation: number }
export interface LiveViewerInfo { sessionId: string; userId: string; username: string; role: 'owner' | 'watcher'; sessionEndsMs: number; jti?: string; tokenVersion?: number }

interface Viewer {
    socket: Socket; info: LiveViewerInfo; confirmed: boolean; confirming?: boolean; inMeter: ByteMeter; bytesIn: number;
}

interface HostEntry { socket: Socket; info: LiveHostInfo; allowed: Set<string>; sent: string; bucket: Bucket; dbInFlight: number }

interface Sess {
    sessionId: string; boxId: string; serverId: string; channelId: string; botId: string; ownerId: string;
    profile: string; channelName: string;
    state: LiveState; note: string | null; stateAtMs: number; startedAtMs: number;
    ring: Ring; cols: number; rows: number;
    viewers: Map<string, Viewer>;
    lastOwnerInputMs: number; controlsBy: string | null; held: boolean; limitHeld: boolean;
    outMeter: ByteMeter; bytesOut: number; bytesIn: number;
    /** Over the output rate since (ms), while the host keeps ignoring `live:pace` */
    overSince: number | null;
    /** The open turn, if any; turn events of a session run one after another */
    turn: { startedMs: number } | null;
    turnChain: Promise<unknown>;
    /**
     * The run-time clock: started by the SERVER's own push of a delivery to this session (not by anything the agent reports), restarted by
     * the next delivery, ended by the agent's reported end of the turn. `step` is how far the stop has escalated.
     */
    run: { startedMs: number; step: number } | null;
    persisting: boolean; persistDirty: boolean;
    wakeLimit: number | null; turnLimitSec: number | null;
    channelNoticeSent: boolean;
    persisted: string;
    lastRedrawMs: number;
    /** When each kind of notice was last said for this session (ms) */
    noticeAt: Map<string, number>;
}

type Emit = (notices: Notice[]) => void;
export interface LiveDeps {
    /** Send an event to every socket of a bot (its `user:<id>` room) */
    emitToBot(botId: string, event: string, payload: unknown): void;
    /** (Unused: whether a session's Channel is connected is per session now, from `LiveHello`.) */
    botChannelConnected?(botId: string): boolean;
}

const isBytes = (d: unknown): d is Buffer | Uint8Array => d instanceof Uint8Array;
const dims = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max ? v as number : null;

/** One bucket per host id, kept across reconnects: dropping a host and letting it come back does not refill its budget. */
const hostBuckets = new Map<string, Bucket>();

export class LiveHub {
    private hosts = new Map<string, HostEntry>();
    private sessions = new Map<string, Sess>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private holdTimer: ReturnType<typeof setInterval> | null = null;
    private dispatchTimer: ReturnType<typeof setInterval> | null = null;
    private lastAccessCheckMs = 0;
    private dispatching = false;
    private pending = new Set<Promise<unknown>>();
    /** Counted, never logged: events from a viewer that may not send them, handshakes refused, hosts dropped. */
    deniedInput = 0;
    refusedViewers = 0;
    hostFloods = 0;
    droppedHostEvents = 0;
    maxViewerBuffer = MAX_BROWSER_BUFFER_BYTES;

    constructor(private db: Pool, private emit: Emit, private deps: LiveDeps) {}

    async start(): Promise<void> {
        // Migration 104 was changed in place before release: a development database made from an earlier version must be recreated.
        // Say so loudly rather than deliver nothing.
        await this.db.query('SELECT live_sent_at, live_wake_counted, hello FROM agent_inbox LIMIT 0')
            .then(() => this.db.query('SELECT agent_reported_clean FROM live_terminal_turns LIMIT 0'))
            .catch(err => { throw new Error(`live terminals: the database lacks migration 104 as it is now (${(err as Error).message}); recreate this development database`); });
        // A server that stopped mid-turn left open rows behind: nothing is running them now
        await this.db.query(`UPDATE live_terminal_turns SET ended_at = NOW(), end_signal = 'host_lost', unverified_reason = 'server_restarted' WHERE ended_at IS NULL`).catch(() => {});
        this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, syncMs());
        this.timer.unref();
        this.holdTimer = setInterval(() => { for (const s of this.sessions.values()) this.applyHold(s); }, 1_000);
        this.holdTimer.unref();
        this.dispatchTimer = setInterval(() => { void this.dispatch().catch(() => {}); }, dispatchMs());
        this.dispatchTimer.unref();
    }
    async stop(): Promise<void> {
        for (const t of [this.timer, this.holdTimer, this.dispatchTimer]) if (t) clearInterval(t);
        this.timer = this.holdTimer = this.dispatchTimer = null;
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
    /** Viewers of a session, and of it by one person (the handshake's caps). */
    viewerCount(sessionId: string, userId?: string): number {
        const s = this.sessions.get(sessionId);
        if (!s) return 0;
        let n = 0;
        for (const v of s.viewers.values()) if (!userId || v.info.userId === userId) n++;
        return n;
    }
    userViewerCount(userId: string): number {
        let n = 0;
        for (const s of this.sessions.values()) for (const v of s.viewers.values()) if (v.info.userId === userId) n++;
        return n;
    }
    /** Is this session's own Channel (its agora-mcp, which said `LiveHello`) connected right now? */
    sessionChannelConnected(sessionId: string): boolean { return (this.channelUp.get(sessionId)?.size ?? 0) > 0; }
    private channelUp = new Map<string, Set<string>>();
    private lastReplay = new Map<string, number>();
    /** agora-mcp of a live session connected (`LiveHello`): what was not acknowledged is sent again, in order. */
    liveChannelUp(botId: string, sessionId: unknown, socketId: string): void {
        if (typeof sessionId !== 'string') return;
        const s = this.sessions.get(sessionId);
        if (!s || s.botId !== botId) return;
        const set = this.channelUp.get(sessionId) ?? new Set<string>();
        set.add(socketId);
        this.channelUp.set(sessionId, set);
        const now = Date.now();
        if (now - (this.lastReplay.get(sessionId) ?? 0) < 2_000) return;
        this.lastReplay.set(sessionId, now);
        void this.track(this.db.query(`UPDATE agent_inbox SET live_sent_at = NULL WHERE session_id = $1 AND acked_at IS NULL AND batch_id IS NULL`, [sessionId])
            .then(() => this.dispatch())).catch(() => {});
    }
    liveChannelDown(socketId: string): void {
        for (const [id, set] of this.channelUp) { set.delete(socketId); if (set.size === 0) this.channelUp.delete(id); }
    }

    /** Does the hub hold a live socket for this box? (for the host's own check-in, and for tests) */
    hostCount(): number { return this.hosts.size; }

    // ─── What the box should be running ───

    /** The live sessions of these boxes' agents, as the hosts should run them, in one query. */
    private async desiredFor(boxIds: string[]): Promise<Map<string, Array<Record<string, any>>>> {
        const out = new Map<string, Array<Record<string, any>>>(boxIds.map(id => [id, []]));
        if (!boxIds.length) return out;
        const rows = (await this.db.query(
            `SELECT b.id AS box_id, s.id, s.channel_id, s.bot_id, s.native_session_id, s.wakes_used, c.name AS channel_name, p.name AS profile, p.wake_budget, p.model, p.effort,
                    p.run_timeout_sec, srv.owner_id, b.server_id
             FROM agent_boxes b
             JOIN agent_profiles p ON p.id = b.profile_id
             JOIN agent_sessions s ON s.profile_id = p.id AND s.live_mode AND s.state = 'live' AND s.thread_id IS NULL
             JOIN channels c ON c.id = s.channel_id
             JOIN servers srv ON srv.id = b.server_id
             WHERE b.id = ANY($1) AND b.desired_state = 'running' AND p.session_mode = 'live'`, [boxIds]
        )).rows;
        for (const r of rows) {
            out.get(r.box_id.trim())!.push({
                sessionId: r.id.trim(), channelId: r.channel_id.trim(), channelName: r.channel_name, botId: r.bot_id.trim(),
                conversation: r.native_session_id, profile: r.profile, ownerId: r.owner_id.trim(), serverId: r.server_id.trim(),
                model: r.model ?? null, effort: r.effort ?? null, wakesUsed: Number(r.wakes_used), wakeLimit: limitOf(r.wake_budget), turnLimitSec: limitOf(r.run_timeout_sec),
            });
        }
        return out;
    }

    /** Push the box's desired set to its host (when it changed), and bring our session records in line. */
    async syncBox(boxId: string, wanted?: Array<Record<string, any>>): Promise<void> {
        const h = this.hosts.get(boxId);
        if (!h || !h.socket.connected) return;
        const want = wanted ?? (await this.desiredFor([boxId])).get(boxId) ?? [];
        h.allowed = new Set(want.map(w => w.sessionId as string));
        for (const w of want) this.ensure(h.info, w as any);
        const wire = want.map(w => ({ sessionId: w.sessionId, channelId: w.channelId, channelName: w.channelName, botId: w.botId, conversation: w.conversation,
            model: w.model, effort: w.effort, profile: w.profile, cols: this.sessions.get(w.sessionId as string)?.cols ?? DEFAULT_COLS, rows: this.sessions.get(w.sessionId as string)?.rows ?? DEFAULT_ROWS }));
        const sent = JSON.stringify(wire.map(w => [w.sessionId, w.conversation, w.model, w.effort]));
        if (sent !== h.sent) { h.sent = sent; h.socket.emit('live:desired', { sessions: wire }); }
        // Sessions that are no longer wanted: their viewers are told, the record and its screen go
        for (const s of [...this.sessions.values()]) {
            if (s.boxId === boxId && !h.allowed.has(s.sessionId)) {
                await this.turnOp(s, () => this.closeTurns(s.sessionId, 'session_ended')).catch(() => {});
                this.dropViewers(s, 'session_ended');
                s.ring.clear();
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
                outMeter: new ByteMeter(LIVE_RATE_BYTES, LIVE_RATE_BYTES, 0), bytesOut: 0, bytesIn: 0, overSince: null, turn: null, turnChain: Promise.resolve(), run: null, persisting: false, persistDirty: false,
                wakeLimit: w.wakeLimit, turnLimitSec: w.turnLimitSec, channelNoticeSent: false, persisted: '', lastRedrawMs: 0, noticeAt: new Map(),
            };
            this.sessions.set(w.sessionId, s);
            // A row left open by an earlier life of this record (a restarted server, a lost host) belongs to no running turn
            const created = s;
            void this.track(this.turnOp(created, () => this.closeTurns(created.sessionId, 'host_lost'))).catch(() => {});
        }
        s.wakeLimit = w.wakeLimit; s.turnLimitSec = w.turnLimitSec;
        const limited = s.wakeLimit !== null && w.wakesUsed >= s.wakeLimit;
        if (limited !== s.limitHeld) {
            s.limitHeld = limited;
            this.applyHold(s);
            if (limited) void this.track(this.sayOnce(s, 'wake_limit', `**${s.profile}** has used its wake limit (${w.wakesUsed} of ${w.wakeLimit}). Further messages are held, not delivered, until the limit is lifted in Settings → Agents.`)).catch(() => {});
        }
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
        // A host being replaced (a rebuilt box, a connection that died): everything of it ends first, so nothing of the old host's turns
        // or clock survives into the new one's
        if (old && old.socket !== socket) { this.dropHost(old, 'replaced'); old.socket.disconnect(true); }
        for (const s of this.sessions.values()) if (s.boxId === info.boxId) this.endHostWork(s);
        let bucket = hostBuckets.get(info.hostId);
        if (!bucket) { bucket = new Bucket(eventRate(), eventBurst()); hostBuckets.set(info.hostId, bucket); }
        const entry: HostEntry = { socket, info, allowed: new Set<string>(), sent: '', bucket, dbInFlight: 0 };
        this.hosts.set(info.boxId, entry);
        const mine = (id: unknown): Sess | null => {
            if (typeof id !== 'string' || !entry.allowed.has(id)) return null;
            const s = this.sessions.get(id);
            return s && s.boxId === info.boxId ? s : null;
        };
        /** Every control event costs a token; a host that spends them all is dropped (counted, never logged) */
        const metered = <T>(fn: (m: T) => void) => (m: T) => {
            if (this.hosts.get(info.boxId) !== entry) return;
            if (!entry.bucket.take()) { this.hostFloods++; socket.emit('live:refused', { code: 'event_flood' }); socket.disconnect(true); return; }
            fn(m);
        };
        /** Database work for a host is bounded: more than a few in flight and the event is dropped */
        const dbWork = (work: () => Promise<unknown>) => {
            if (entry.dbInFlight >= MAX_DB_IN_FLIGHT) { this.droppedHostEvents++; return; }
            entry.dbInFlight++;
            void this.track(work()).catch(() => {}).finally(() => { entry.dbInFlight--; });
        };
        socket.on('live:output', (m: { sessionId?: unknown; data?: unknown }) => {
            const s = mine(m?.sessionId);
            if (!s || !isBytes(m.data) || m.data.byteLength === 0 || m.data.byteLength > 256 * 1024) return;
            this.onOutput(s, Buffer.from(m.data), entry);
        });
        // After a reconnect the host sends what its own ring holds; used only when ours is empty (the server restarted)
        socket.on('live:replay', metered((m: { sessionId?: unknown; data?: unknown }) => {
            const s = mine(m?.sessionId);
            if (!s || !isBytes(m.data) || m.data.byteLength > RING_BYTES || s.ring.length > 0) return;
            s.ring.push(Buffer.from(m.data));
        }));
        socket.on('live:state', metered((m: { sessionId?: unknown; state?: unknown; note?: unknown }) => {
            const s = mine(m?.sessionId);
            if (!s || !LIVE_STATES.includes(m.state as LiveState)) return;
            const note = typeof m.note === 'string' && (LIVE_NOTES as readonly string[]).includes(m.note) ? m.note : null;
            this.setState(s, m.state as LiveState, note);
        }));
        socket.on('live:turn', metered((m: { sessionId?: unknown; phase?: unknown; messageId?: unknown; branch?: unknown; sha?: unknown; signal?: unknown }) => {
            const s = mine(m?.sessionId);
            if (!s) return;
            const sha = typeof m.sha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(m.sha) ? m.sha : null;
            const branch = typeof m.branch === 'string' && m.branch.length <= 255 && !/[\0-\x1f]/.test(m.branch) ? m.branch : null;
            if (m.phase === 'start') {
                const messageId = typeof m.messageId === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(m.messageId) ? m.messageId : null;
                dbWork(() => this.turnOp(s, () => this.startTurn(s, messageId, branch, sha)));
            } else if (m.phase === 'end') {
                const signal = m.signal === 'stop_hook' ? 'stop_hook' : 'interrupted';
                dbWork(() => this.turnOp(s, () => this.endTurn(s, signal, branch, sha)));
            }
        }));
        socket.on('live:exited', metered((m: { sessionId?: unknown }) => {
            const s = mine(m?.sessionId);
            if (!s) return;
            dbWork(() => this.turnOp(s, () => this.endTurn(s, 'session_ended', null, null)));
            this.setState(s, 'restarting', 'exited');
        }));
        // (a replaced host was dropped when it was replaced: its late disconnect touches nothing of the new one)
        socket.on('disconnect', () => { if (this.hosts.get(info.boxId) === entry) this.dropHost(entry, 'disconnected'); });
        void this.track(this.syncBox(info.boxId)).catch(() => {});
        return true;
    }

    /** Open turns and the run-time clock of a session belong to the host that reported them: they end with it. */
    private endHostWork(s: Sess): void {
        s.turn = null;
        s.run = null;
        void this.track(this.turnOp(s, () => this.closeTurns(s.sessionId, 'host_lost'))).catch(() => {});
    }

    /** The one way a host ends: a disconnect, a replacement, a failed check. */
    private dropHost(entry: HostEntry, _reason: string): void {
        if (this.hosts.get(entry.info.boxId) === entry) this.hosts.delete(entry.info.boxId);
        for (const s of this.sessions.values()) {
            if (s.boxId !== entry.info.boxId) continue;
            this.endHostWork(s);
            this.setState(s, 'stopped', 'box_disconnected');
        }
    }

    private onOutput(s: Sess, data: Buffer, host: HostEntry): void {
        s.bytesOut += data.length;
        s.ring.push(data);
        const now = Date.now();
        if (!s.outMeter.add(data.length, now)) {
            // The host is told to slow down; one that keeps ignoring it is dropped (it is the agent's own process: never waited for)
            host.socket.emit('live:pace', { sessionId: s.sessionId, ms: 500 });
            s.overSince ??= now;
            if (now - s.overSince > paceIgnoreMs()) { this.hostFloods++; host.socket.emit('live:refused', { code: 'output_flood' }); host.socket.disconnect(true); return; }
        } else s.overSince = null;
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
            void this.track(this.sayOnce(s, 'waiting', `**${s.profile}** is waiting on you in its terminal${note === 'no_signal' ? ' (the CLI is showing a startup prompt)' : ''}. Open its terminal to answer.`)).catch(() => {});
        }
    }

    /** Writes the latest state; writes that arrive meanwhile are coalesced into one more. */
    private async persist(s: Sess): Promise<void> {
        if (s.persisting) { s.persistDirty = true; return; }
        s.persisting = true;
        try {
            do {
                s.persistDirty = false;
                const key = `${s.state}/${s.note}`;
                if (key === s.persisted) continue;
                s.persisted = key;
                await this.db.query(`UPDATE agent_sessions SET live_state = $2, live_note = $3, live_state_at = NOW() WHERE id = $1 AND live_mode`, [s.sessionId, s.state, s.note]);
            } while (s.persistDirty);
        } finally { s.persisting = false; }
    }

    private controlsActive(s: Sess, now = Date.now()): boolean {
        if (!s.lastOwnerInputMs || now - s.lastOwnerInputMs >= controlIdleMs()) return false;
        for (const v of s.viewers.values()) if (v.info.role === 'owner' && v.socket.connected && v.confirmed) return true;
        return false;
    }

    /** Recompute whether deliveries to this agent wait (the owner has the controls, or its wake limit is reached), and tell the viewers. */
    applyHold(s: Sess): void {
        const controls = this.controlsActive(s);
        const owner = controls ? [...s.viewers.values()].find(v => v.info.role === 'owner')?.info.username ?? null : null;
        const held = controls || s.limitHeld;
        const changed = held !== s.held || owner !== s.controlsBy;
        s.held = held; s.controlsBy = owner;
        if (!changed) return;
        this.toViewers(s, 'live:controls', { by: owner, held, reason: controls ? 'controls' : s.limitHeld ? 'wake_limit' : null });
    }

    private toViewers(s: Sess, event: string, payload: unknown): void {
        for (const v of s.viewers.values()) if (v.socket.connected) v.socket.emit(event, payload);
    }

    // ─── Delivery: the server routes, the Channel carries ───

    /** agora-mcp says it pushed a message into its CLI. Only the bot's own session can acknowledge, and only what was sent. */
    async ack(botId: string, sessionId: unknown, messageId: unknown): Promise<boolean> {
        if (typeof sessionId !== 'string' || typeof messageId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(messageId)) return false;
        const r = await this.db.query(
            `UPDATE agent_inbox i SET acked_at = NOW() FROM agent_sessions s
             WHERE s.id = i.session_id AND i.session_id = $1 AND i.message_id = $2 AND s.bot_id = $3 AND s.live_mode AND i.live_sent_at IS NOT NULL AND i.acked_at IS NULL`,
            [sessionId, messageId, botId]);
        return (r.rowCount ?? 0) > 0;
    }

    /**
     * Send what routing wrote for live sessions: in order, one wake each (counted here, against the wake limit
     * as it stands now), nothing while the owner has the controls or the wake limit is reached, and nothing to a
     * session whose channel connection is down (it waits, and is replayed when the connection returns).
     */
    async dispatch(): Promise<void> {
        if (this.dispatching || this.sessions.size === 0) return;
        this.dispatching = true;
        try {
            // Sessions that can take a push now: host and Channel connected, not held (the owner's controls, the wake limit)
            const ready = [...this.sessions.values()].filter(s => !s.held && this.hostConnected(s.boxId) && this.sessionChannelConnected(s.sessionId));
            if (!ready.length) return;
            // A per-session cap: one backlogged session does not starve the others
            const rows = (await this.db.query(
                `SELECT x.id, x.session_id, x.message_id, x.reason, x.hello, x.live_sent_at, x.live_wake_counted
                 FROM unnest($1::char(26)[]) AS sid(id)
                 CROSS JOIN LATERAL (SELECT i.* FROM agent_inbox i WHERE i.session_id = sid.id AND i.acked_at IS NULL AND i.batch_id IS NULL
                                     ORDER BY i.id LIMIT 20) x
                 ORDER BY x.session_id, x.id`, [ready.map(s => s.sessionId)])).rows;
            const bySession = new Map<string, any[]>();
            for (const r of rows) {
                const sid = r.session_id.trim();
                const list = bySession.get(sid) ?? [];
                list.push(r);
                bySession.set(sid, list);
            }
            for (const [sessionId, list] of bySession) {
                const s = this.sessions.get(sessionId);
                if (!s) continue;
                // The hello a /start posts and lurk reads are finished with, not pushed; everything else (notices to the agent, a subtask's summary) is
                const silent = list.filter(r => r.hello || r.reason === 'lurk');
                if (silent.length) await this.db.query(`UPDATE agent_inbox SET acked_at = NOW() WHERE id = ANY($1)`, [silent.map(r => r.id)]);
                const due = list.filter(r => !r.hello && r.reason !== 'lurk'
                    && !(r.live_sent_at && Date.now() - new Date(r.live_sent_at).getTime() < redeliverMs()));
                if (!due.length) continue;
                // The same checks the per-wake claim runs, now, before anything is pushed
                const client = await this.db.connect();
                let kept: Awaited<ReturnType<typeof recheckLiveRows>> = [];
                let notices: Notice[] = [];
                try {
                    await client.query('BEGIN');
                    kept = await recheckLiveRows(client, sessionId, due.map(r => r.id), notices);
                    await client.query('COMMIT');
                } catch (err) { await client.query('ROLLBACK').catch(() => {}); kept = []; notices = []; } finally { client.release(); }
                if (notices.length) this.emit(notices);
                for (const k of kept) {
                    if (s.held) break;
                    const row = k.row;
                    if (!row.live_wake_counted && !(await this.countWake(s, row.id))) break;
                    const e = k.entry;
                    this.deps.emitToBot(s.botId, 'LiveDeliver', {
                        sessionId, channelId: s.channelId, channelName: s.channelName,
                        // The authority the server stamped on the message (the per-wake claim's own value); the owner's own bot is marked as such;
                        // a notice written by the server has none
                        authority: e.authority ?? (e.ownerBot ? 'director' : 'system'),
                        ownerBot: !!e.ownerBot, ownerBotDirect: !!e.ownerBotDirect, reason: e.reason,
                        message: { id: e.messageId, content: e.content ?? '', authorId: e.authorId, authorUsername: e.authorName ?? 'agora', authorBot: e.authorBot,
                            channelId: s.channelId, threadId: e.threadId, createdAt: e.createdAt },
                    });
                    await this.db.query(`UPDATE agent_inbox SET live_sent_at = NOW() WHERE id = $1`, [row.id]);
                    // The server's clock for the run-time limit starts here, and starts again at the next delivery (a resend of the
                    // same message, because its acknowledgement was slow, is not a new delivery)
                    if (!row.live_sent_at) s.run = { startedMs: Date.now(), step: 0 };
                }
            }
        } finally { this.dispatching = false; }
    }

    /** One wake for this delivery, if the wake limit allows it now. False: the session is held at its limit (said once). */
    private async countWake(s: Sess, inboxId: string): Promise<boolean> {
        const client = await this.db.connect();
        let notices: Notice[] = [];
        let ok = false;
        try {
            await client.query('BEGIN');
            const row = (await client.query(
                `SELECT x.wakes_used, p.wake_budget FROM agent_sessions x JOIN agent_profiles p ON p.id = x.profile_id WHERE x.id = $1 FOR UPDATE OF x`, [s.sessionId])).rows[0];
            const limit = limitOf(row?.wake_budget);
            s.wakeLimit = limit;
            if (limit !== null && Number(row.wakes_used) >= limit) {
                if (!s.limitHeld) {
                    s.limitHeld = true;
                    void this.track(this.sayOnce(s, 'wake_limit', `**${s.profile}** has used its wake limit (${row.wakes_used} of ${limit}). Further messages are held, not delivered, until the limit is lifted in Settings → Agents.`)).catch(() => {});
                }
            } else {
                await client.query(`UPDATE agent_sessions SET wakes_used = wakes_used + 1, last_active_at = NOW() WHERE id = $1`, [s.sessionId]);
                await client.query(`UPDATE agent_inbox SET live_wake_counted = TRUE WHERE id = $1`, [inboxId]);
                if (s.limitHeld) s.limitHeld = false;
                ok = true;
            }
            await client.query('COMMIT');
        } catch { await client.query('ROLLBACK').catch(() => {}); notices = []; ok = false; } finally { client.release(); }
        if (notices.length) this.emit(notices);
        this.applyHold(s);
        return ok;
    }

    // ─── Turns (the agent's own report; display and timing only: no limit depends on it) ───

    /** A session's turn events run one after another, in the order they arrived. */
    private turnOp<T>(s: Sess, fn: () => Promise<T>): Promise<T | void> {
        const next = s.turnChain.then(fn, fn);
        s.turnChain = next.catch(() => {});
        return next.catch(() => {});
    }

    private async closeTurns(sessionId: string, signal: string): Promise<void> {
        await this.db.query(
            `UPDATE live_terminal_turns SET ended_at = NOW(), end_signal = $2, agent_reported_clean = FALSE, unverified_reason = COALESCE(unverified_reason, 'no_idle_signal')
             WHERE session_id = $1 AND ended_at IS NULL`, [sessionId, signal]);
    }

    private async startTurn(s: Sess, claimedMessageId: string | null, branch: string | null, sha: string | null): Promise<void> {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            // An earlier open row is closed in this same transaction: there is never more than one
            await client.query(
                `UPDATE live_terminal_turns SET ended_at = NOW(), end_signal = 'host_lost', agent_reported_clean = FALSE, unverified_reason = 'superseded'
                 WHERE session_id = $1 AND ended_at IS NULL`, [s.sessionId]);
            // A turn "from a message" must be one the server itself delivered to this session; anything else is a typed turn
            const messageId = claimedMessageId && (await client.query(
                `SELECT 1 FROM agent_inbox WHERE session_id = $1 AND message_id = $2 AND live_sent_at IS NOT NULL`, [s.sessionId, claimedMessageId])).rows.length ? claimedMessageId : null;
            await client.query(
                `INSERT INTO live_terminal_turns (id, session_id, server_id, channel_id, message_id, source, branch, start_sha)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [generateUlid(), s.sessionId, s.serverId, s.channelId, messageId, messageId ? 'message' : 'typed', branch, sha]);
            await client.query(
                `DELETE FROM live_terminal_turns WHERE session_id = $1 AND id NOT IN (SELECT id FROM live_terminal_turns WHERE session_id = $1 ORDER BY id DESC LIMIT ${MAX_TURNS_PER_SESSION})`, [s.sessionId]);
            await client.query('COMMIT');
            s.turn = { startedMs: Date.now() };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally { client.release(); }
    }

    private async endTurn(s: Sess, signal: 'stop_hook' | 'interrupted' | 'session_ended' | 'host_lost', branch: string | null, sha: string | null): Promise<void> {
        // Written first; the in-memory turn goes only after the row did
        await this.db.query(
            `UPDATE live_terminal_turns SET ended_at = NOW(), end_signal = $2::text, end_sha = $3::text, branch = COALESCE(branch, $4::text),
                    agent_reported_clean = ($2::text = 'stop_hook' AND start_sha IS NOT NULL AND $3::text IS NOT NULL),
                    unverified_reason = CASE WHEN $2::text <> 'stop_hook' THEN 'no_idle_signal' WHEN start_sha IS NULL OR $3::text IS NULL THEN 'no_commit_read' ELSE NULL END
             WHERE session_id = $1 AND ended_at IS NULL`, [s.sessionId, signal, sha, branch]);
        // The agent's reported end ends the clock the server started at a delivery, if the ended turn began after that delivery
        // (the end of an older turn, a typed one, does not stop a clock a newer delivery started)
        const began = s.turn?.startedMs ?? null;
        s.turn = null;
        if (signal === 'stop_hook' && s.run && began !== null && began >= s.run.startedMs) s.run = null;
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
    /** A notice of one kind for one session at most every ten minutes: a host cannot flood a channel. */
    private async sayOnce(s: Sess, kind: string, text: string): Promise<void> {
        const now = Date.now();
        if (now - (s.noticeAt.get(kind) ?? 0) < noticeEveryMs()) return;
        s.noticeAt.set(kind, now);
        await this.say(s, text);
    }

    // ─── Viewers ───

    attachViewer(socket: Socket, info: LiveViewerInfo): void {
        const s = this.sessions.get(info.sessionId);
        if (!s || !socket.connected) { this.refusedViewers++; socket.emit('live:exit', { reason: 'not_running' }); setTimeout(() => socket.disconnect(true), 50).unref(); return; }
        if (s.viewers.size >= MAX_VIEWERS_PER_SESSION) { this.refusedViewers++; socket.emit('live:exit', { reason: 'too_many_viewers' }); setTimeout(() => socket.disconnect(true), 50).unref(); return; }
        const v: Viewer = { socket, info, confirmed: false, inMeter: new ByteMeter(INPUT_RATE_BYTES, INPUT_BURST_BYTES, INPUT_BURST_BYTES), bytesIn: 0 };
        s.viewers.set(socket.id, v);
        socket.emit('live:ready', {
            role: info.role, state: s.state, note: s.note, cols: s.cols, rows: s.rows, profile: s.profile, channelName: s.channelName,
            controlsBy: s.controlsBy, held: s.held, hostConnected: this.hostConnected(s.boxId),
        });
        const snap = s.ring.snapshot();
        if (snap.length) socket.emit('live:replay', snap);
        // A viewer joining a screen the CLI draws only when told to gets it redrawn (at most every 5 s)
        const nowMs = Date.now();
        if (nowMs - s.lastRedrawMs > 5_000) { s.lastRedrawMs = nowMs; this.hosts.get(s.boxId)?.socket.emit('live:redraw', { sessionId: s.sessionId }); }
        // Everything below is accepted from the owner's confirmed socket only
        socket.on('live:take', (m: { ack?: unknown }) => {
            if (info.role !== 'owner') { this.deniedInput++; return; }
            if (m?.ack !== true || v.confirmed || v.confirming) return;
            v.confirming = true;
            // The audit entry is written first: typing is not unlocked until it is on record
            void this.track(this.audit(s, info.userId, 'live_terminal_take')).then(() => {
                if (!socket.connected) return;
                v.confirmed = true;
                socket.emit('live:taken', {});
            }).catch(() => { v.confirming = false; });
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
        } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    }

    // ─── The sweep ───

    async sweep(): Promise<void> {
        if (this.sweeping) return;
        this.sweeping = true;
        try { await this.sweepOnce(); } finally { this.sweeping = false; }
    }
    private sweeping = false;

    private async sweepOnce(): Promise<void> {
        const now = Date.now();
        // One query for every connected box's desired sessions
        const boxIds = [...this.hosts.keys()];
        if (boxIds.length) {
            const wanted = await this.desiredFor(boxIds).catch(() => null);
            if (wanted) for (const boxId of boxIds) await this.syncBox(boxId, wanted.get(boxId) ?? []).catch(() => {});
        }
        for (const s of this.sessions.values()) {
            // Run-time limit: Escape, then Escape again, then Ctrl-C, then the CLI is stopped and started again (resumed).
            // Enforced here and by the host: nothing the CLI reports can stop it.
            if (s.run && s.turnLimitSec !== null && this.hostConnected(s.boxId)) {
                const over = now - s.run.startedMs - s.turnLimitSec * 1000;
                const step = over < 0 ? 0 : Math.min(4, 1 + Math.floor(over / Math.max(1, escalateMs())));
                if (step > s.run.step) {
                    s.run.step = step;
                    this.hosts.get(s.boxId)?.socket.emit('live:interrupt', { sessionId: s.sessionId, step });
                    const what = ['', 'was interrupted (Escape)', 'was interrupted again (Escape)', 'was interrupted with Ctrl-C', 'ignored the interrupts: its CLI is being stopped and started again with its conversation resumed'][step];
                    void this.track(this.say(s, `**${s.profile}**'s turn passed its run-time limit (${s.turnLimitSec >= 60 ? `${Math.round(s.turnLimitSec / 60)} min` : `${s.turnLimitSec} s`}) and ${what}.`)).catch(() => {});
                    if (step === 4) s.run = null;
                }
            }
            // The Channel is the only delivery road: say so when it is not connected, never type instead
            const alive = (s.state === 'idle' || s.state === 'working') && this.hostConnected(s.boxId);
            if (alive && !this.sessionChannelConnected(s.sessionId)) {
                if (now - s.stateAtMs > channelGraceMs() && s.note !== 'channel_unavailable') {
                    s.note = 'channel_unavailable';
                    this.toViewers(s, 'live:state', { state: s.state, note: s.note });
                    void this.track(this.persist(s)).catch(() => {});
                    if (!s.channelNoticeSent) {
                        s.channelNoticeSent = true;
                        void this.track(this.sayOnce(s, 'channel', `**${s.profile}**'s live terminal is running, but its Claude Code Channel is not connected, so chat messages cannot reach it. `
                            + 'They are kept and delivered when it connects; they are not typed into the terminal. Open the terminal to see why (the channel flag may have been refused, or a startup prompt is waiting).')).catch(() => {});
                    }
                }
            } else if (alive && s.note === 'channel_unavailable') { s.note = null; this.toViewers(s, 'live:state', { state: s.state, note: null }); void this.track(this.persist(s)).catch(() => {}); }
            for (const [id, v] of s.viewers) {
                if (v.info.sessionEndsMs <= now) this.dropViewer(s, id, 'session_ended');
            }
            this.applyHold(s);
            // Memory of a session whose host is gone for good (a deleted box) is let go
            if (!this.hosts.has(s.boxId) && s.viewers.size === 0 && now - s.stateAtMs > 10 * 60_000) { s.ring.clear(); this.sessions.delete(s.sessionId); }
        }
        await this.warnUndelivered().catch(() => {});
        if (now - this.lastAccessCheckMs < accessRecheckMs()) return;
        this.lastAccessCheckMs = now;
        await this.revalidate().catch(() => {});
    }

    /** One notice when messages for a live session have waited too long to be delivered. */
    private async warnUndelivered(): Promise<void> {
        const ids = [...this.sessions.keys()];
        if (!ids.length) return;
        const rows = (await this.db.query(
            `SELECT session_id, count(*)::int AS n FROM agent_inbox
             WHERE session_id = ANY($1) AND acked_at IS NULL AND batch_id IS NULL AND reason IN ('direct', 'protocol', 'handoff')
               AND created_at < NOW() - make_interval(secs => $2) GROUP BY session_id`, [ids, undeliveredMs() / 1000])).rows;
        for (const r of rows) {
            const s = this.sessions.get(r.session_id.trim());
            if (s) void this.track(this.sayOnce(s, 'undelivered', `${r.n} message${r.n === 1 ? '' : 's'} for **${s.profile}** could not be delivered to its terminal yet. They are kept and delivered, in order, when its Claude Code Channel connects.`)).catch(() => {});
        }
    }

    /** Hosts and viewers are checked again against the database (a revoked host, a rebuilt box, a viewer whose access or cookie session ended). */
    private async revalidate(): Promise<void> {
        const hostIds = [...this.hosts.values()].map(h => h.info.hostId);
        if (hostIds.length) {
            const rows = (await this.db.query(
                `SELECT h.id, h.revoked_at, b.id AS box_id, b.generation, b.desired_state
                 FROM agent_hosts h LEFT JOIN agent_boxes b ON b.id = h.box_id WHERE h.id = ANY($1)`, [hostIds])).rows;
            const byHost = new Map<string, any>(rows.map((r: any) => [r.id.trim(), r]));
            for (const [boxId, h] of [...this.hosts]) {
                const r = byHost.get(h.info.hostId);
                if (!r || r.revoked_at || !r.box_id || Number(r.generation) !== h.info.generation || r.desired_state !== 'running') {
                    this.dropHost(h, 'host_changed');
                    h.socket.emit('live:refused', { code: 'host_changed' });
                    h.socket.disconnect(true);
                }
            }
        }
        // Viewers: the same account check the gateway uses (token version, account status), the cookie session's blacklist, and the role
        const checked = new Map<string, boolean>();
        for (const s of this.sessions.values()) {
            for (const [id, v] of [...s.viewers]) {
                const key = `${v.info.userId}:${v.info.jti ?? ''}:${v.info.tokenVersion ?? 0}`;
                let ok = checked.get(key);
                if (ok === undefined) {
                    ok = !(await socketAccountError(this.db, v.info.userId, false, v.info.tokenVersion ?? 0).catch(() => 'error'))
                        && !(v.info.jti && await isTokenBlacklisted(v.info.jti).catch(() => false));
                    checked.set(key, ok);
                }
                if (!ok) { this.dropViewer(s, id, 'access_changed'); continue; }
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
    if (!row) return next(new Error('Invalid host token'));
    // (the box signature rule first, from the row alone: it needs no secret)
    const refused = await d.provenanceRefused(socket.handshake.headers, {
        kind: 'host', id: row.id.trim(), serverId: row.server_id.trim(), boxId: row.box_id?.trim() || null,
        generation: intOrNull(row.box_generation), currentGeneration: intOrNull(row.box_current_generation),
    });
    if (refused) return next(new Error(refused));
    // Live terminals are for boxes: on a machine this would be a pty on the owner's own computer
    if (row.kind !== 'box' || !row.box_id || row.desired_state === 'deleted') return next(new Error('box_hosts_only'));
    // A host socket of a generation the box has left is refused (an old container still running)
    if (Number(row.box_generation) !== Number(row.box_current_generation)) return next(new Error('box_changed'));
    const protocol = Number.isInteger(auth.liveProtocol) ? Math.min(auth.liveProtocol as number, LIVE_PROTOCOL) : 0;
    if (protocol < LIVE_PROTOCOL) return next(new Error('unsupported_protocol'));
    // A box that already has its host is answered before the (slow) secret check: a second socket costs nothing
    if (d.hub.hostConnected(row.box_id.trim(), Number(row.box_generation))) return next(new Error('host_already_connected'));
    if (!await verifyBotSecret(m[2], row.secret_hash)) return next(new Error('Invalid host token'));
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
    // Caps: a person and a session can only hold so many open pages
    if (d.hub.viewerCount(sessionId, userId) >= MAX_VIEWERS_PER_USER || d.hub.viewerCount(sessionId) >= MAX_VIEWERS_PER_SESSION) { d.hub.refusedViewers++; return next(new Error('too_many_viewers')); }
    socket.data.liveView = { sessionId, userId, username: user.username, role, sessionEndsMs: Number(sessionEndsAt(payload)), jti: payload.jti, tokenVersion: payload.tokenVersion ?? 0 } satisfies LiveViewerInfo;
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

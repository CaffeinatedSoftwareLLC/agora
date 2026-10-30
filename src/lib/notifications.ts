import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { Client } from 'pg';
import type { Server } from 'socket.io';
import { generateUlid } from '../utils/ulid';
import { loadChannelPermissions } from './channel-access';
import { Permissions } from '../permissions';

/**
 * Notifications (docs/notifications.md).
 *
 * notify() runs in the transaction of the action that caused the notification: an approval
 * card, a mention, a session notice, a card moving to Review, a DONE or BLOCK in a thread.
 * It writes one row per recipient and one push_outbox row per push device, then calls
 * pg_notify. Postgres delivers a NOTIFY only when its transaction commits, so the API
 * process, which LISTENs (startNotificationListener), emits NotificationCreate to the
 * recipient's user room after commit, whichever process wrote it (API, cap-gateway or the
 * runner). The push sender (src/workers/push-sender.ts) drains the outbox.
 *
 * A notification carries a type, a short label and a UI path, never message text.
 */

export const NOTIFICATION_TYPES = ['approval', 'mention', 'session', 'review', 'collab'] as const;
export type NotificationType = typeof NOTIFICATION_TYPES[number];

/** The NOTIFY channel; payloads are the public notification plus its user id. */
export const NOTIFY_CHANNEL = 'agora_notifications';
/** A repeat for the same user, type, channel and thread within this window is dropped while unread. */
export const DEDUPE_SECONDS = 120;

export interface PublicNotification {
    id: string;
    type: NotificationType;
    label: string;
    url: string;
    serverId: string | null;
    channelId: string | null;
    threadId: string | null;
    readAt: string | null;
    createdAt: string;
}

export function notificationJson(r: any): PublicNotification {
    return {
        id: r.id.trim(), type: r.type, label: r.label, url: r.url,
        serverId: r.server_id?.trim() ?? null, channelId: r.channel_id?.trim() ?? null, threadId: r.thread_id?.trim() ?? null,
        readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(),
    };
}

/** The UI path a notification opens: the channel, with the thread panel open for a thread. */
export function notificationUrl(channelId: string, threadId?: string | null): string {
    return `/app/${channelId.trim()}${threadId ? `?thread=${threadId.trim()}` : ''}`;
}

/** Labels are at most 120 characters (the relay's limit for title and body). */
function clip(label: string): string {
    return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}

/** The instance setting that lists allowed push relays; empty means app push is off. */
export async function allowedRelays(db: any): Promise<string[]> {
    const res = await db.query(`SELECT value FROM instance_settings WHERE key = 'push.allowed_relays'`);
    const v = res.rows[0]?.value;
    return Array.isArray(v) ? v.filter((s: unknown): s is string => typeof s === 'string') : [];
}

/** An https origin with nothing after it, as the relay contract requires. */
export function isHttpsOrigin(value: string): boolean {
    try {
        const u = new URL(value);
        return u.protocol === 'https:' && u.origin === value && !u.username && !u.password;
    } catch {
        return false;
    }
}

export function handleHash(handle: string): string {
    return createHash('sha256').update(handle).digest('hex');
}

/**
 * Run fn as the service role (no RLS) on the caller's connection, inside a savepoint, then
 * restore the caller's role. Recipients' preferences, devices and permissions are hidden
 * from app_user, and app_user cannot insert notifications at all. A failure rolls back to
 * the savepoint and returns `fallback`, so a notification problem never fails the action
 * that caused it. The caller's client must be inside a transaction.
 */
export async function withService<T>(c: any, fn: () => Promise<T>, fallback: T, log?: (err: unknown) => void): Promise<T> {
    const role = (await c.query('SELECT current_user AS role')).rows[0].role as string;
    await c.query('SAVEPOINT notifications_write');
    try {
        await c.query('SET LOCAL ROLE NONE');
        const result = await fn();
        await c.query(`SET LOCAL ROLE "${role.split('"').join('""')}"`);
        await c.query('RELEASE SAVEPOINT notifications_write');
        return result;
    } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT notifications_write');
        await c.query('RELEASE SAVEPOINT notifications_write');
        (log ?? defaultLog)(err);
        return fallback;
    }
}

function defaultLog(err: unknown) {
    console.warn('Notification not created:', err instanceof Error ? err.message : err);
}

export interface NotifyInput {
    type: NotificationType;
    /** Candidate user ids; bots, inactive accounts, users who can't see the channel and the excluded are dropped. */
    recipients: string[];
    channelId: string;
    threadId?: string | null;
    /** Built from the channel name: (channel) => "Approval waiting in #general". */
    label: (channel: string) => string;
    /** Never notified, e.g. the person who acted. */
    exclude?: (string | null | undefined)[];
    /** Extra permission a recipient needs in the channel besides ViewChannel. */
    requires?: 'manage_bots';
}

/** Create notifications; returns the user ids notified. Never throws. */
export async function notify(c: any, input: NotifyInput): Promise<string[]> {
    if (input.recipients.length === 0) return [];
    return withService(c, () => insertNotifications(c, input), []);
}

async function insertNotifications(c: any, input: NotifyInput): Promise<string[]> {
    const channelId = input.channelId.trim();
    const threadId = input.threadId?.trim() || null;
    const exclude = new Set(input.exclude?.filter(Boolean).map(id => id!.trim()));
    const ids = [...new Set(input.recipients.map(id => id.trim()))].filter(id => !exclude.has(id));
    if (ids.length === 0) return [];

    const channel = (await c.query('SELECT name, server_id FROM channels WHERE id = $1', [channelId])).rows[0];
    if (!channel) return [];
    const label = clip(input.label(channel.name));
    const url = notificationUrl(channelId, threadId);

    // Humans with an active account who have not switched this type off
    const candidates = await c.query(
        `SELECT u.id, COALESCE(p.app_push, true) AS app_push FROM users u
         LEFT JOIN notification_preferences p ON p.user_id = u.id
         WHERE u.id = ANY($1::char(26)[]) AND u.bot = false AND u.account_status = 'active'
           AND COALESCE((p.types ->> $2)::boolean, true)`,
        [ids, input.type]
    );
    const relays = await allowedRelays(c);
    const notified: string[] = [];
    for (const row of candidates.rows) {
        const userId = row.id.trim();
        // Nobody hears about a channel they can't see, whoever the caller named
        const perms = await loadChannelPermissions(c, channelId, userId);
        if ('error' in perms || !(perms.perms & Permissions.ViewChannel)) continue;
        if (input.requires === 'manage_bots' && !(perms.perms & (Permissions.ManageBots | Permissions.Administrator))) continue;

        const repeat = await c.query(
            `SELECT 1 FROM notifications WHERE user_id = $1 AND type = $2 AND channel_id = $3 AND thread_id IS NOT DISTINCT FROM $4
               AND read_at IS NULL AND created_at > NOW() - make_interval(secs => $5) LIMIT 1`,
            [userId, input.type, channelId, threadId, DEDUPE_SECONDS]
        );
        if (repeat.rows.length > 0) continue;

        const id = generateUlid();
        const inserted = await c.query(
            `INSERT INTO notifications (id, user_id, server_id, channel_id, thread_id, type, label, url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [id, userId, channel.server_id, channelId, threadId, input.type, label, url]
        );
        if (row.app_push && relays.length > 0) {
            await c.query(
                `INSERT INTO push_outbox (id, device_id, notification_id)
                 SELECT gen_ulid(), d.id, $2 FROM push_devices d WHERE d.user_id = $1 AND d.relay = ANY($3::text[])`,
                [userId, id, relays]
            );
        }
        // Delivered by Postgres only if this transaction commits
        await c.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, JSON.stringify({ userId, notification: notificationJson(inserted.rows[0]) })]);
        notified.push(userId);
    }
    return notified;
}

/**
 * For callers that write with a pool and no transaction of their own (runtime submitRun):
 * notify in a short transaction of its own. Never throws.
 */
export async function inOwnTransaction(pool: { connect(): Promise<any> }, fn: (c: any) => Promise<unknown>): Promise<void> {
    let c: any;
    try {
        c = await pool.connect();
        await c.query('BEGIN');
        await fn(c);
        await c.query('COMMIT');
    } catch (err) {
        await c?.query('ROLLBACK').catch(() => {});
        defaultLog(err);
    } finally {
        c?.release();
    }
}

// ─── Recipients ───

/** The server owner of a channel. */
async function channelOwner(c: any, channelId: string): Promise<string[]> {
    const row = await c.query('SELECT s.owner_id FROM channels ch JOIN servers s ON s.id = ch.server_id WHERE ch.id = $1', [channelId]);
    return row.rows[0]?.owner_id ? [row.rows[0].owner_id.trim()] : [];
}

/** The owner and every human holding DirectAgents in the channel (src/lib/direct-agents.ts). */
async function ownerAndDirectors(c: any, channelId: string): Promise<string[]> {
    const ch = await c.query('SELECT server_id FROM channels WHERE id = $1', [channelId]);
    if (!ch.rows[0]?.server_id) return [];
    const members = await c.query(
        `SELECT sm.user_id FROM server_members sm JOIN users u ON u.id = sm.user_id
         WHERE sm.server_id = $1 AND u.bot = false AND u.account_status = 'active'`,
        [ch.rows[0].server_id]
    );
    const out = await channelOwner(c, channelId);
    for (const m of members.rows) {
        const perms = await loadChannelPermissions(c, channelId, m.user_id.trim());
        const need = Permissions.DirectAgents | Permissions.ViewChannel;
        if (!('error' in perms) && (perms.perms & need) === need) out.push(m.user_id.trim());
    }
    return out;
}

/** Every human member of the channel's server; notify() then keeps those with the required permission. */
async function serverMembers(c: any, channelId: string): Promise<string[]> {
    const rows = await c.query(
        `SELECT sm.user_id FROM channels ch JOIN server_members sm ON sm.server_id = ch.server_id WHERE ch.id = $1`,
        [channelId]
    );
    return rows.rows.map((r: any) => r.user_id.trim());
}

// ─── One helper per notification source ───

/**
 * An approval card was posted. Recipients are the people who can answer it, as the
 * answering routes decide:
 * - 'run' (agent_run_approval) and 'relay' (agent_permission_relay): the server owner.
 * - 'tool' (agent_tool_approval): the owner and directors. A live request on a subscription
 *   profile only the owner can release, on a siwc profile only its plan owner.
 * - 'code' (runtime_approval): members with Manage Bots or Administrator.
 */
export async function notifyApproval(c: any, input: { kind: 'run' | 'relay' | 'tool' | 'code'; channelId: string; threadId?: string | null; sessionId?: string; live?: boolean }): Promise<string[]> {
    return withService(c, async () => {
        let recipients: string[];
        if (input.kind === 'run' || input.kind === 'relay') {
            recipients = await channelOwner(c, input.channelId);
        } else if (input.kind === 'code') {
            recipients = await serverMembers(c, input.channelId);
        } else {
            const p = input.sessionId ? (await c.query(
                `SELECT p.auth_mode, p.plan_owner_id FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id WHERE s.id = $1`,
                [input.sessionId]
            )).rows[0] : null;
            if (input.live && p?.auth_mode === 'subscription') recipients = await channelOwner(c, input.channelId);
            else if (input.live && p?.auth_mode === 'siwc') recipients = p.plan_owner_id ? [p.plan_owner_id.trim()] : [];
            else recipients = await ownerAndDirectors(c, input.channelId);
        }
        return insertNotifications(c, {
            type: 'approval', recipients, channelId: input.channelId, threadId: input.threadId,
            label: ch => `Approval waiting in #${ch}`, requires: input.kind === 'code' ? 'manage_bots' : undefined,
        });
    }, []);
}

/** People @mentioned by name in a message (not @everyone); the author is never notified. */
export async function notifyMentions(c: any, input: { channelId: string; threadId?: string | null; authorId: string; userIds: string[] }): Promise<string[]> {
    return notify(c, {
        type: 'mention', recipients: input.userIds, channelId: input.channelId, threadId: input.threadId, exclude: [input.authorId],
        label: ch => input.threadId ? `You were mentioned in a thread in #${ch}` : `You were mentioned in #${ch}`,
    });
}

/** blocked: a wake failed for good or a run posted nothing; budget: shelved by its budget; credit: the provider's usage or rate limit. */
export type SessionAlert = 'blocked' | 'budget' | 'credit';

/** A session can't go on: to the person who started it, or the owner when nobody did. */
export async function notifySession(c: any, sessionId: string, alert: SessionAlert): Promise<string[]> {
    return withService(c, async () => {
        const s = (await c.query(
            `SELECT s.channel_id, s.started_by, srv.owner_id, p.name,
                    (SELECT u.bot = false AND u.account_status = 'active' FROM users u WHERE u.id = s.started_by) AS starter_ok
             FROM agent_sessions s JOIN servers srv ON srv.id = s.server_id JOIN agent_profiles p ON p.id = s.profile_id
             WHERE s.id = $1`,
            [sessionId]
        )).rows[0];
        if (!s?.channel_id) return [];
        const to = s.starter_ok ? s.started_by.trim() : s.owner_id.trim();
        const what = alert === 'budget' ? 'used up its budget' : alert === 'credit' ? 'hit its usage limit' : 'is blocked';
        return insertNotifications(c, {
            type: 'session', recipients: [to], channelId: s.channel_id,
            label: ch => `${s.name} ${what} in #${ch}`,
        });
    }, []);
}

/** A task card moved to Review: to the person who created it, unless they moved it. */
export async function notifyReview(c: any, input: { channelId: string; threadId?: string | null; createdBy: string | null; actorId?: string | null }): Promise<string[]> {
    if (!input.createdBy) return [];
    return notify(c, {
        type: 'review', recipients: [input.createdBy], channelId: input.channelId, threadId: input.threadId, exclude: [input.actorId],
        label: ch => `Task ready for review in #${ch}`,
    });
}

/** An agora-collab DONE or BLOCK in a thread: to the person who started the thread. */
export async function notifyCollab(c: any, input: { channelId: string; threadId: string; starterId: string | null; authorId: string; outcome: 'done' | 'block' }): Promise<string[]> {
    if (!input.starterId) return [];
    return notify(c, {
        type: 'collab', recipients: [input.starterId], channelId: input.channelId, threadId: input.threadId, exclude: [input.authorId],
        label: ch => input.outcome === 'done' ? `Collaboration finished in #${ch}` : `Collaboration blocked in #${ch}`,
    });
}

/** The outcome a protocol message reports, if it is one the thread starter hears about. */
export function collabOutcome(protocol: { state?: string; decision?: string } | null): 'done' | 'block' | null {
    if (!protocol) return null;
    if (protocol.state === 'DONE') return 'done';
    if (protocol.state === 'BLOCK' || (protocol.state === 'DECIDE' && protocol.decision === 'BLOCK')) return 'block';
    return null;
}

// ─── Delivery after commit ───

/** Fired in the API process for every committed notification (the push sender listens). */
export const notificationEvents = new EventEmitter();

/**
 * LISTEN for committed notifications and emit each to its user's room as NotificationCreate.
 * Reconnects after a lost connection. Returns a closer.
 */
export function startNotificationListener(io: Server, dbUrl: string | undefined, log?: { warn: (...a: unknown[]) => void }): () => Promise<void> {
    let client: Client | null = null;
    let stopped = false;
    let retry: NodeJS.Timeout | null = null;

    const connect = async () => {
        if (stopped) return;
        const c = new Client({ connectionString: dbUrl });
        client = c;
        c.on('notification', msg => {
            if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return;
            let parsed: { userId?: string; notification?: PublicNotification };
            try { parsed = JSON.parse(msg.payload); } catch { return; }
            if (!parsed.userId || !parsed.notification) return;
            io.to(`user:${parsed.userId}`).emit('NotificationCreate', parsed.notification);
            notificationEvents.emit('created', parsed.notification);
        });
        const reconnect = (err?: unknown) => {
            if (stopped || client !== c) return;
            client = null;
            log?.warn({ err }, 'Notification listener lost its connection; reconnecting');
            c.end().catch(() => {});
            retry = setTimeout(() => { void connect(); }, 5000);
            retry.unref();
        };
        c.on('error', reconnect);
        c.on('end', () => reconnect());
        try {
            await c.connect();
            await c.query(`LISTEN ${NOTIFY_CHANNEL}`);
        } catch (err) {
            reconnect(err);
        }
    };
    void connect();

    return async () => {
        stopped = true;
        if (retry) clearTimeout(retry);
        const c = client;
        client = null;
        if (c) await c.end().catch(() => {});
    };
}

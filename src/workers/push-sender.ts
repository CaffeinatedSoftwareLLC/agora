import type { Pool } from 'pg';
import { config } from '../config';
import { decryptString } from '../lib/encryption';
import { allowedRelays, notificationEvents, type NotificationType } from '../lib/notifications';
import { relayPush } from '../lib/push-relay';

/**
 * Push sender: drains push_outbox (written by notify() with each notification) by POSTing
 * to each device's relay. Runs in the API process, woken by every committed notification
 * and by a timer for retries. Rows are leased with FOR UPDATE SKIP LOCKED, so two API
 * processes never send the same row at once.
 *
 * Relay answers (mobile-apps.md section 8):
 * - 2xx: sent; the device's last_ok_at is updated.
 * - 410: the phone's token is gone; the device is deleted.
 * - 401/403: the relay doesn't know the handle, or it belongs to another instance origin;
 *   the device is deleted and a warning logged.
 * - 429, 5xx, network errors: retried with backoff, at most MAX_ATTEMPTS times.
 * - any other status: dropped.
 * A send whose notification is older than STALE_MINUTES, whose relay is no longer allowed or
 * whose user turned app push off is dropped. Handles are never logged.
 */

export const MAX_ATTEMPTS = 5;
const BATCH = 50;
const LEASE_SECONDS = 120;
const STALE_MINUTES = 60;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 15 * 60;

const TITLES: Record<NotificationType, string> = {
    approval: 'Approval waiting',
    mention: 'Mention',
    session: 'Agent session',
    review: 'Ready for review',
    collab: 'Collaboration',
};

interface Log { warn: (...a: unknown[]) => void; info?: (...a: unknown[]) => void }

/** Seconds before retry number `attempts` (1-based), doubling from 30 s, capped at 15 min. */
export function backoffSeconds(attempts: number, retryAfter: number | null): number {
    const backoff = Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempts - 1));
    return retryAfter ? Math.min(MAX_BACKOFF_SECONDS, Math.max(backoff, retryAfter)) : backoff;
}

/** Take one batch of due rows and send each once. Returns how many rows it took. */
export async function drainPushOutbox(db: Pool, log: Log): Promise<number> {
    const leased = await db.query(
        `WITH due AS (
             SELECT id FROM push_outbox WHERE next_attempt_at <= NOW()
             ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
         )
         UPDATE push_outbox o SET attempts = o.attempts + 1, next_attempt_at = NOW() + make_interval(secs => ${LEASE_SECONDS})
         FROM due WHERE o.id = due.id
         RETURNING o.id, o.attempts, o.device_id, o.notification_id`
    );
    if (leased.rows.length === 0) return 0;

    const relays = new Set(await allowedRelays(db));
    for (const row of leased.rows) {
        const info = (await db.query(
            `SELECT d.id AS device_id, d.relay, d.instance_origin, d.handle_enc, d.handle_iv, d.handle_tag,
                    n.type, n.label, n.url, n.created_at < NOW() - make_interval(mins => ${STALE_MINUTES}) AS stale,
                    COALESCE(p.app_push, true) AS app_push
             FROM push_devices d JOIN notifications n ON n.id = $2
             LEFT JOIN notification_preferences p ON p.user_id = d.user_id
             WHERE d.id = $1`,
            [row.device_id, row.notification_id]
        )).rows[0];
        if (!info || info.stale || !info.app_push || !relays.has(info.relay)) {
            await db.query('DELETE FROM push_outbox WHERE id = $1', [row.id]);
            continue;
        }
        const deviceId = info.device_id.trim();
        let status: number;
        let retryAfter: number | null = null;
        try {
            const handle = decryptString(info.handle_enc, config.encryptionKey, info.handle_iv, info.handle_tag);
            const res = await relayPush(info.relay, handle, {
                instance: info.instance_origin, type: info.type, title: TITLES[info.type as NotificationType] ?? 'Agora',
                body: info.label, url: info.url,
            });
            status = res.status;
            retryAfter = res.retryAfterSeconds;
        } catch (err) {
            // Network error or timeout: retried like a 5xx
            status = 0;
            log.warn({ deviceId, relay: info.relay, err: err instanceof Error ? err.name : 'error' }, 'Push relay unreachable');
        }

        if (status >= 200 && status < 300) {
            await db.query('DELETE FROM push_outbox WHERE id = $1', [row.id]);
            await db.query('UPDATE push_devices SET last_ok_at = NOW() WHERE id = $1', [deviceId]);
        } else if (status === 410 || status === 401 || status === 403) {
            // The outbox rows for the device go with it (ON DELETE CASCADE)
            await db.query('DELETE FROM push_devices WHERE id = $1', [deviceId]);
            if (status !== 410) log.warn({ deviceId, relay: info.relay, status }, 'Push relay refused the handle; device removed');
        } else if (status === 0 || status === 429 || status >= 500) {
            if (row.attempts >= MAX_ATTEMPTS) {
                await db.query('DELETE FROM push_outbox WHERE id = $1', [row.id]);
                log.warn({ deviceId, relay: info.relay, status }, 'Push dropped after retries');
            } else {
                await db.query(`UPDATE push_outbox SET next_attempt_at = NOW() + make_interval(secs => $2) WHERE id = $1`,
                    [row.id, backoffSeconds(row.attempts, retryAfter)]);
            }
        } else {
            await db.query('DELETE FROM push_outbox WHERE id = $1', [row.id]);
            log.warn({ deviceId, relay: info.relay, status }, 'Push relay rejected the push');
        }
    }
    return leased.rows.length;
}

/**
 * Start the sender: drain at once whenever a notification commits, and every
 * `intervalMs` for retries. Returns a stopper that waits for a drain in flight.
 */
export function startPushSender(opts: { db: Pool; log: Log; intervalMs?: number }): () => Promise<void> {
    let running: Promise<void> | null = null;
    let again = false;
    let stopped = false;
    const drain = () => {
        if (stopped) return;
        if (running) { again = true; return; }
        running = (async () => {
            do {
                again = false;
                try {
                    while (!stopped && await drainPushOutbox(opts.db, opts.log) > 0) { /* until nothing is due */ }
                } catch (err) {
                    opts.log.warn({ err }, 'Push sender failed');
                }
            } while (again && !stopped);
        })().finally(() => { running = null; });
    };
    notificationEvents.on('created', drain);
    const timer = setInterval(drain, opts.intervalMs ?? 15_000);
    timer.unref();
    drain();
    return async () => {
        stopped = true;
        clearInterval(timer);
        notificationEvents.off('created', drain);
        await running;
    };
}

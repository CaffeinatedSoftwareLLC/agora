import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { decryptString, encryptString } from '../lib/encryption';
import { allowedRelays, handleHash, isHttpsOrigin, notificationJson, NOTIFICATION_TYPES, withService } from '../lib/notifications';
import { relayForget } from '../lib/push-relay';
import { generateUlid } from '../utils/ulid';

/**
 * The signed-in person's notifications, notification preferences and push devices
 * (docs/notifications.md). Bots have none of these: every route here is for people.
 * RLS limits each table to the caller's own rows; the queries also filter on the caller.
 */

const ID = { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-Z]{26}$' } as const;
/** Most push devices one account can register. */
export const MAX_DEVICES = 20;

async function humansOnly(request: FastifyRequest, reply: FastifyReply) {
    if (request.isBot) return reply.status(403).send({ error: 'humans_only' });
}

async function unreadCount(db: any, userId: string): Promise<number> {
    const res = await db.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
    return res.rows[0].n;
}

/**
 * The origin this instance is reached at, as the app registered it with the relay: the
 * request's Origin header (the page inside the app), else the first https CORS_ORIGIN.
 */
function instanceOrigin(request: FastifyRequest): string | null {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && isHttpsOrigin(origin)) return origin;
    const configured = (config.corsOrigin ?? '').split(',').map(s => s.trim().replace(/\/+$/, '')).find(isHttpsOrigin);
    return configured ?? null;
}

function deviceJson(r: any) {
    return {
        id: r.id.trim(), relay: r.relay, platform: r.platform, label: r.label,
        createdAt: r.created_at, lastOkAt: r.last_ok_at ?? null,
    };
}

export async function notificationRoutes(app: FastifyInstance) {
    // GET /me/notifications?limit&before → { notifications, unread, hasMore }  (newest first)
    app.get('/me/notifications', {
        preHandler: humansOnly,
        schema: {
            querystring: {
                type: 'object', additionalProperties: false,
                properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, before: ID, unread: { type: 'boolean' } },
            },
        },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const { limit = 30, before, unread } = request.query as { limit?: number; before?: string; unread?: boolean };
        const rows = await db.query(
            `SELECT * FROM notifications WHERE user_id = $1 AND ($2::text IS NULL OR id < $2) AND (NOT $3 OR read_at IS NULL)
             ORDER BY id DESC LIMIT $4`,
            [request.userId, before ?? null, !!unread, limit + 1]
        );
        return reply.send({
            notifications: rows.rows.slice(0, limit).map(notificationJson),
            unread: await unreadCount(db, request.userId),
            hasMore: rows.rows.length > limit,
        });
    });

    // POST /me/notifications/:id/read → { id, readAt, unread }
    app.post('/me/notifications/:id/read', {
        preHandler: humansOnly,
        schema: { params: { type: 'object', properties: { id: ID } } },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const { id } = request.params as { id: string };
        const res = await db.query(
            `UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING read_at`,
            [id, request.userId]
        );
        if (res.rows.length === 0) return reply.status(404).send({ error: 'notification_not_found' });
        const unread = await unreadCount(db, request.userId);
        // The user's other tabs and devices drop it from their badge too
        request.pendingEvents ??= [];
        request.pendingEvents.push({ room: `user:${request.userId.trim()}`, event: 'NotificationRead', data: { ids: [id], unread } });
        return reply.send({ id, readAt: res.rows[0].read_at, unread });
    });

    // POST /me/notifications/read-all → { updated, unread: 0 }
    app.post('/me/notifications/read-all', { preHandler: humansOnly }, async (request, reply) => {
        const db = request.dbClient!;
        const res = await db.query(
            `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
            [request.userId]
        );
        request.pendingEvents ??= [];
        request.pendingEvents.push({ room: `user:${request.userId.trim()}`, event: 'NotificationRead', data: { all: true, unread: 0 } });
        return reply.send({ updated: res.rowCount ?? 0, unread: 0 });
    });

    // GET /me/notification-preferences → { types: { approval: true, ... }, appPush }
    app.get('/me/notification-preferences', { preHandler: humansOnly }, async (request, reply) => {
        const row = (await request.dbClient!.query(
            'SELECT types, app_push FROM notification_preferences WHERE user_id = $1', [request.userId]
        )).rows[0];
        return reply.send(preferencesJson(row));
    });

    // PUT /me/notification-preferences { types?, appPush? } → the full preferences
    const typeFlags = Object.fromEntries(NOTIFICATION_TYPES.map(t => [t, { type: 'boolean' }]));
    app.put('/me/notification-preferences', {
        preHandler: humansOnly,
        schema: {
            body: {
                type: 'object', additionalProperties: false, minProperties: 1,
                properties: {
                    types: { type: 'object', additionalProperties: false, properties: typeFlags },
                    appPush: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const body = request.body as { types?: Record<string, boolean>; appPush?: boolean };
        const row = (await db.query(
            `INSERT INTO notification_preferences (user_id, types, app_push) VALUES ($1, $2::jsonb, COALESCE($3, true))
             ON CONFLICT (user_id) DO UPDATE SET types = notification_preferences.types || $2::jsonb,
                 app_push = COALESCE($3, notification_preferences.app_push), updated_at = NOW()
             RETURNING types, app_push`,
            [request.userId, JSON.stringify(body.types ?? {}), body.appPush ?? null]
        )).rows[0];
        return reply.send(preferencesJson(row));
    });

    // POST /me/push-devices { relay, handle, platform, label } → 201 { id }
    app.post('/me/push-devices', {
        preHandler: humansOnly,
        schema: {
            body: {
                type: 'object', additionalProperties: false, required: ['relay', 'handle', 'platform', 'label'],
                properties: {
                    relay: { type: 'string', minLength: 9, maxLength: 255 },
                    // 32 random bytes as base64url
                    handle: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
                    platform: { type: 'string', enum: ['android', 'ios'] },
                    label: { type: 'string', minLength: 1, maxLength: 100 },
                },
            },
        },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const userId = request.userId;
        const body = request.body as { relay: string; handle: string; platform: string; label: string };
        const relay = body.relay.replace(/\/+$/, '');
        if (!isHttpsOrigin(relay) || !(await allowedRelays(db)).includes(relay)) {
            return reply.status(403).send({ error: 'relay_not_allowed' });
        }
        const origin = instanceOrigin(request);
        if (!origin) return reply.status(400).send({ error: 'instance_origin_unknown' });
        const label = body.label.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100) || body.platform;

        const hash = handleHash(body.handle);
        const enc = encryptString(body.handle, config.encryptionKey);
        // As the service role: a handle registered before by another account on this phone
        // moves to this account (the relay hands out one handle per phone and instance).
        const result = await withService<{ id: string } | { error: 'too_many_devices' | 'failed' }>(db, async () => {
            const count = await db.query(
                'SELECT COUNT(*)::int AS n FROM push_devices WHERE user_id = $1 AND NOT (relay = $2 AND handle_hash = $3)',
                [userId, relay, hash]
            );
            if (count.rows[0].n >= MAX_DEVICES) return { error: 'too_many_devices' };
            const row = (await db.query(
                `INSERT INTO push_devices (id, user_id, relay, instance_origin, handle_enc, handle_iv, handle_tag, handle_hash, platform, label)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (relay, handle_hash) DO UPDATE SET user_id = EXCLUDED.user_id, instance_origin = EXCLUDED.instance_origin,
                     handle_enc = EXCLUDED.handle_enc, handle_iv = EXCLUDED.handle_iv, handle_tag = EXCLUDED.handle_tag,
                     platform = EXCLUDED.platform, label = EXCLUDED.label
                 RETURNING id, (SELECT user_id FROM push_devices WHERE relay = $3 AND handle_hash = $8) AS previous_user`,
                [generateUlid(), userId, relay, origin, enc.encrypted, enc.iv, enc.authTag, hash, body.platform, label]
            )).rows[0];
            // Sends queued for the previous account must not reach the new one's phone
            if (row.previous_user && row.previous_user.trim() !== userId.trim()) {
                await db.query('DELETE FROM push_outbox WHERE device_id = $1', [row.id]);
            }
            return { id: row.id.trim() };
        }, { error: 'failed' }, err => request.log.error({ err }, 'Push device registration failed'));

        if ('error' in result) {
            return result.error === 'too_many_devices'
                ? reply.status(409).send({ error: 'too_many_devices' })
                : reply.status(500).send({ error: 'registration_failed' });
        }
        return reply.status(201).send({ id: result.id });
    });

    // GET /me/push-devices → { devices }  (never the handle)
    app.get('/me/push-devices', { preHandler: humansOnly }, async (request, reply) => {
        const rows = await request.dbClient!.query(
            `SELECT id, relay, platform, label, created_at, last_ok_at FROM push_devices WHERE user_id = $1 ORDER BY id`,
            [request.userId]
        );
        return reply.send({ devices: rows.rows.map(deviceJson) });
    });

    // DELETE /me/push-devices/:id → 204; the relay is told to forget the handle after commit
    app.delete('/me/push-devices/:id', {
        preHandler: humansOnly,
        schema: { params: { type: 'object', properties: { id: ID } } },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const { id } = request.params as { id: string };
        const res = await db.query(
            `DELETE FROM push_devices WHERE id = $1 AND user_id = $2 RETURNING relay, handle_enc, handle_iv, handle_tag`,
            [id, request.userId]
        );
        const device = res.rows[0];
        if (!device) return reply.status(404).send({ error: 'device_not_found' });
        const handle = decryptString(device.handle_enc, config.encryptionKey, device.handle_iv, device.handle_tag);
        (request.afterCommit ??= []).push(async () => {
            const r = await relayForget(device.relay, handle);
            if (r.status !== 204 && r.status !== 401) request.log.warn({ deviceId: id, relay: device.relay, status: r.status }, 'Push relay did not forget the handle');
        });
        return reply.status(204).send();
    });
}

function preferencesJson(row: { types?: Record<string, unknown>; app_push?: boolean } | undefined) {
    const types = Object.fromEntries(NOTIFICATION_TYPES.map(t => [t, row?.types?.[t] !== false]));
    return { types, appPush: row?.app_push ?? true };
}

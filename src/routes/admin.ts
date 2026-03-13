import { FastifyInstance } from 'fastify';
import { requireInstanceAdmin } from '../auth/middleware';
import { generateUlid } from '../utils/ulid';
import { hmacIp, encryptIp, decryptIp } from '../auth/crypto';
import { getFileSettings, invalidateSettingsCache } from '../lib/settings';

async function logAdminAction(
    db: any,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    changes?: Record<string, any>
) {
    await db.query(
        `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, changes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [generateUlid(), actorId, action, targetType, targetId, changes ? JSON.stringify(changes) : null]
    );
}

export async function adminRoutes(app: FastifyInstance) {

    // GET /admin/stats
    app.get('/admin/stats', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const db = request.dbClient!;

        const [usersRes, pendingRes, serversRes] = await Promise.all([
            db.query('SELECT COUNT(*)::int AS count FROM users'),
            db.query("SELECT COUNT(*)::int AS count FROM users WHERE account_status = 'pending'"),
            db.query('SELECT COUNT(*)::int AS count FROM servers'),
        ]);

        return reply.send({
            totalUsers: usersRes.rows[0].count,
            pendingCount: pendingRes.rows[0].count,
            serverCount: serversRes.rows[0].count,
        });
    });

    // GET /admin/pending-users
    app.get('/admin/pending-users', {
        preHandler: [requireInstanceAdmin],
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    page: { type: 'integer', minimum: 1, default: 1 },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                },
            },
        },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const { page = 1, limit = 20 } = request.query as any;
        const offset = (page - 1) * limit;

        const [usersRes, countRes] = await Promise.all([
            db.query(
                `SELECT id, username, email, created_at
                 FROM users WHERE account_status = 'pending'
                 ORDER BY created_at ASC LIMIT $1 OFFSET $2`,
                [limit, offset]
            ),
            db.query("SELECT COUNT(*)::int AS count FROM users WHERE account_status = 'pending'"),
        ]);

        const users = usersRes.rows.map((row: any) => ({
            id: row.id.trim(),
            username: row.username,
            email: row.email,
            createdAt: row.created_at,
        }));

        return reply.send({ users, total: countRes.rows[0].count, page, limit });
    });

    // POST /admin/approve-user/:id
    app.post('/admin/approve-user/:id', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const db = request.dbClient!;
        const userId = request.userId;
        const { id: targetId } = request.params as any;

        // Atomic: only transitions pending → active, returns the row if successful
        const updateRes = await db.query(
            `UPDATE users SET account_status = 'active'
             WHERE id = $1 AND account_status = 'pending'
             RETURNING id, username, email`,
            [targetId]
        );

        if (updateRes.rowCount === 0) {
            // Distinguish not-found from wrong-status
            const exists = await db.query('SELECT account_status FROM users WHERE id = $1', [targetId]);
            if (exists.rows.length === 0) {
                return reply.status(404).send({ error: 'user_not_found' });
            }
            return reply.status(409).send({ error: 'user_not_pending' });
        }

        const row = updateRes.rows[0];

        // Auto-join the approved user to the instance server
        const serverIdResult = await db.query(
            "SELECT value FROM instance_config WHERE key = 'instance_server_id'"
        );
        const instanceServerId = serverIdResult.rows[0]?.value;
        if (instanceServerId) {
            await db.query(
                `INSERT INTO server_members (server_id, user_id)
                 VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [instanceServerId, targetId]
            );
        }

        await logAdminAction(db, userId, 'user_approve', 'user', targetId, {
            before: { accountStatus: 'pending' },
            after: { accountStatus: 'active' },
        });

        return reply.send({
            user: {
                id: row.id.trim(),
                username: row.username,
                email: row.email,
                accountStatus: 'active',
            },
        });
    });

    // POST /admin/reject-user/:id
    app.post('/admin/reject-user/:id', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const db = request.dbClient!;
        const userId = request.userId;
        const { id: targetId } = request.params as any;

        // Atomic: only deletes if pending, returns the row for audit logging
        const deleteRes = await db.query(
            `DELETE FROM users WHERE id = $1 AND account_status = 'pending' RETURNING username`,
            [targetId]
        );

        if (deleteRes.rowCount === 0) {
            const exists = await db.query('SELECT account_status FROM users WHERE id = $1', [targetId]);
            if (exists.rows.length === 0) {
                return reply.status(404).send({ error: 'user_not_found' });
            }
            return reply.status(409).send({ error: 'user_not_pending' });
        }

        await logAdminAction(db, userId, 'user_reject', 'user', targetId, {
            username: deleteRes.rows[0].username,
        });

        return reply.send({ success: true });
    });

    // GET /admin/users
    app.get('/admin/users', {
        preHandler: [requireInstanceAdmin],
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    page: { type: 'integer', minimum: 1, default: 1 },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                    status: { type: 'string', enum: ['active', 'pending', 'suspended'] },
                    search: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const { page = 1, limit = 20, status, search } = request.query as any;
        const offset = (page - 1) * limit;

        const conditions: string[] = [];
        const params: any[] = [];
        let paramIdx = 1;

        if (status) {
            conditions.push(`account_status = $${paramIdx++}`);
            params.push(status);
        }

        if (search) {
            conditions.push(`(username ILIKE $${paramIdx} OR email ILIKE $${paramIdx})`);
            params.push(`%${search}%`);
            paramIdx++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const ipKey = app.ipEncryptionKey as Buffer;

        const [usersRes, countRes] = await Promise.all([
            db.query(
                `SELECT id, username, email, account_status, is_instance_admin, created_at, last_ip_encrypted
                 FROM users ${whereClause}
                 ORDER BY created_at ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
                [...params, limit, offset]
            ),
            db.query(
                `SELECT COUNT(*)::int AS count FROM users ${whereClause}`,
                params
            ),
        ]);

        const users = usersRes.rows.map((row: any) => ({
            id: row.id.trim(),
            username: row.username,
            email: row.email,
            accountStatus: row.account_status,
            isInstanceAdmin: row.is_instance_admin,
            createdAt: row.created_at,
            lastIp: row.last_ip_encrypted ? decryptIp(row.last_ip_encrypted, ipKey) : null,
        }));

        return reply.send({ users, total: countRes.rows[0].count, page, limit });
    });

    // POST /admin/users/:id/ban (and backwards-compat /suspend alias)
    const banHandler = async (request: any, reply: any) => {
        const db = request.dbClient!;
        const userId = request.userId;
        const { id: targetId } = request.params as any;

        if (userId === targetId) {
            return reply.status(400).send({ error: 'cannot_suspend_self' });
        }

        const checkRes = await db.query(
            'SELECT is_instance_admin FROM users WHERE id = $1',
            [targetId]
        );

        if (checkRes.rows.length === 0) {
            return reply.status(404).send({ error: 'user_not_found' });
        }

        if (checkRes.rows[0].is_instance_admin) {
            return reply.status(400).send({ error: 'cannot_suspend_admin' });
        }

        const updateRes = await db.query(
            `UPDATE users SET account_status = 'suspended'
             WHERE id = $1 AND account_status = 'active'
             RETURNING id, username, email`,
            [targetId]
        );

        if (updateRes.rowCount === 0) {
            return reply.status(409).send({ error: 'user_not_active' });
        }

        const row = updateRes.rows[0];

        await logAdminAction(db, userId, 'user_ban', 'user', targetId, {
            before: { accountStatus: 'active' },
            after: { accountStatus: 'suspended' },
        });

        request.pendingDisconnects = [targetId];

        return reply.send({
            user: {
                id: row.id.trim(),
                username: row.username,
                email: row.email,
                accountStatus: 'suspended',
            },
        });
    };

    app.post('/admin/users/:id/ban', {
        preHandler: [requireInstanceAdmin],
    }, banHandler);

    // Backwards-compat alias — TODO: remove /suspend alias after v0.1.0 release
    app.post('/admin/users/:id/suspend', {
        preHandler: [requireInstanceAdmin],
    }, banHandler);

    // POST /admin/users/:id/ip-ban
    app.post('/admin/users/:id/ip-ban', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const db = request.dbClient!;
        const userId = request.userId;
        const ipKey = app.ipEncryptionKey as Buffer;
        const { id: targetId } = request.params as any;

        if (userId === targetId) {
            return reply.status(400).send({ error: 'cannot_suspend_self' });
        }

        const checkRes = await db.query(
            'SELECT is_instance_admin, last_ip_hmac, last_ip_encrypted, account_status FROM users WHERE id = $1',
            [targetId]
        );

        if (checkRes.rows.length === 0) {
            return reply.status(404).send({ error: 'user_not_found' });
        }

        if (checkRes.rows[0].is_instance_admin) {
            return reply.status(400).send({ error: 'cannot_suspend_admin' });
        }

        const targetUser = checkRes.rows[0];

        if (!targetUser.last_ip_hmac || !targetUser.last_ip_encrypted) {
            return reply.status(400).send({ error: 'no_ip_recorded' });
        }

        // Upsert IP ban — clears expires_at so expired bans become active again
        await db.query(
            `INSERT INTO ip_bans (id, ip_hmac, ip_encrypted, reason, banned_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (ip_hmac) DO UPDATE SET
                 expires_at = NULL,
                 ip_encrypted = EXCLUDED.ip_encrypted,
                 banned_by = EXCLUDED.banned_by`,
            [generateUlid(), targetUser.last_ip_hmac, targetUser.last_ip_encrypted, null, userId]
        );

        // Ban account if active
        let accountBanned = false;
        if (targetUser.account_status === 'active') {
            await db.query(
                `UPDATE users SET account_status = 'suspended' WHERE id = $1`,
                [targetId]
            );
            accountBanned = true;
            request.pendingDisconnects = [targetId];
        }

        await logAdminAction(db, userId, 'user_ip_ban', 'user', targetId, {
            ipBanned: true,
            accountBanned,
        });

        // Fetch updated user for response
        const userRes = await db.query(
            'SELECT id, username, email, account_status FROM users WHERE id = $1',
            [targetId]
        );
        const row = userRes.rows[0];

        return reply.send({
            user: {
                id: row.id.trim(),
                username: row.username,
                email: row.email,
                accountStatus: row.account_status,
            },
            accountBanned,
            ipBanned: true,
        });
    });

    // GET /admin/ip-bans
    app.get('/admin/ip-bans', {
        preHandler: [requireInstanceAdmin],
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    page: { type: 'integer', minimum: 1, default: 1 },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                },
            },
        },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const ipKey = app.ipEncryptionKey as Buffer;
        const { page = 1, limit = 20 } = request.query as any;
        const offset = (page - 1) * limit;

        const [bansRes, countRes] = await Promise.all([
            db.query(
                `SELECT id, ip_encrypted, reason, banned_by, created_at, expires_at
                 FROM ip_bans ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
                [limit, offset]
            ),
            db.query('SELECT COUNT(*)::int AS count FROM ip_bans'),
        ]);

        const bans = bansRes.rows.map((row: any) => ({
            id: row.id.trim(),
            ip: decryptIp(row.ip_encrypted, ipKey),
            reason: row.reason,
            bannedBy: row.banned_by?.trim() ?? null,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
        }));

        return reply.send({ bans, total: countRes.rows[0].count, page, limit });
    });

    // DELETE /admin/ip-bans/:id
    app.delete('/admin/ip-bans/:id', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const db = request.dbClient!;
        const userId = request.userId;
        const { id: banId } = request.params as any;

        const deleteRes = await db.query(
            'DELETE FROM ip_bans WHERE id = $1 RETURNING id',
            [banId]
        );

        if (deleteRes.rowCount === 0) {
            return reply.status(404).send({ error: 'ip_ban_not_found' });
        }

        await logAdminAction(db, userId, 'ip_ban_remove', 'ip_ban', banId);

        return reply.send({ success: true });
    });

    // PATCH /admin/instance
    app.patch('/admin/instance', {
        preHandler: [requireInstanceAdmin],
        schema: {
            body: {
                type: 'object',
                properties: {
                    instanceName: { type: 'string', minLength: 1, maxLength: 100 },
                    registrationPolicy: { type: 'string', enum: ['open', 'invite_only', 'approval'] },
                },
                anyOf: [
                    { required: ['instanceName'] },
                    { required: ['registrationPolicy'] },
                ],
            },
        },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const userId = request.userId;
        const { instanceName, registrationPolicy } = request.body as any;

        // Pre-check: verify all requested config keys exist before making any changes
        // (prevents partial writes when one key is present but the other is missing)
        const keysToUpdate: string[] = [];
        if (instanceName !== undefined) keysToUpdate.push('instance_name');
        if (registrationPolicy !== undefined) keysToUpdate.push('registration_policy');

        const existsRes = await db.query(
            `SELECT key FROM instance_config WHERE key = ANY($1)`,
            [keysToUpdate]
        );

        if (existsRes.rows.length !== keysToUpdate.length) {
            const existingKeys = new Set(existsRes.rows.map((r: any) => r.key));
            const missingKey = keysToUpdate.find(k => !existingKeys.has(k));
            return reply.status(500).send({ error: 'config_key_missing', key: missingKey });
        }

        // All keys verified — safe to update
        const changes: Record<string, any> = {};

        if (instanceName !== undefined) {
            await db.query(
                "UPDATE instance_config SET value = $1 WHERE key = 'instance_name'",
                [instanceName]
            );
            changes.instanceName = instanceName;
        }

        if (registrationPolicy !== undefined) {
            await db.query(
                "UPDATE instance_config SET value = $1 WHERE key = 'registration_policy'",
                [registrationPolicy]
            );
            changes.registrationPolicy = registrationPolicy;
        }

        await logAdminAction(db, userId, 'instance_update', 'instance', null, changes);

        // Fetch current config to return
        const configRes = await db.query(
            "SELECT key, value FROM instance_config WHERE key IN ('instance_name', 'registration_policy')"
        );

        const config: Record<string, string> = {};
        for (const row of configRes.rows) {
            config[row.key] = row.value;
        }

        return reply.send({
            instanceName: config.instance_name,
            registrationPolicy: config.registration_policy,
        });
    });

    // GET /admin/settings/files
    app.get('/admin/settings/files', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const db = request.dbClient!;
        const settings = await getFileSettings(db);
        return reply.send(settings);
    });

    // PATCH /admin/settings/files
    app.patch('/admin/settings/files', {
        preHandler: [requireInstanceAdmin],
        schema: {
            body: {
                type: 'object',
                properties: {
                    'files.max_size_bytes': { type: 'number', minimum: 1024, maximum: 104857600 },
                    'files.allowed_extensions': {
                        type: 'array',
                        items: { type: 'string', pattern: '^[a-z0-9]+$' },
                    },
                    'files.retention_days': {
                        oneOf: [
                            { type: 'null' },
                            { type: 'integer', minimum: 1, maximum: 3650 },
                        ],
                    },
                    'files.storage_quota_bytes': {
                        oneOf: [
                            { type: 'null' },
                            { type: 'integer', minimum: 1 },
                        ],
                    },
                    'files.exif_strip': { type: 'boolean' },
                },
                additionalProperties: false,
            },
        },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const userId = request.userId;
        const body = request.body as Record<string, any>;

        for (const [key, value] of Object.entries(body)) {
            await db.query(
                `INSERT INTO instance_settings (key, value) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = $2`,
                [key, JSON.stringify(value)]
            );
        }

        invalidateSettingsCache();

        await logAdminAction(db, userId, 'file_settings_update', 'instance_settings', null, body);

        return reply.send({ success: true });
    });

    // GET /admin/storage
    app.get('/admin/storage', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const db = request.dbClient!;

        const statsRes = await db.query(`
            SELECT
                COUNT(*)::int as total_files,
                COALESCE(SUM(size_bytes), 0)::bigint as total_bytes,
                COUNT(*) FILTER (WHERE mime_type LIKE 'image/%')::int as image_count,
                COALESCE(SUM(size_bytes) FILTER (WHERE mime_type LIKE 'image/%'), 0)::bigint as image_bytes,
                COUNT(*) FILTER (WHERE expires_at IS NOT NULL)::int as expiring_files
            FROM files
            WHERE deleted_at IS NULL
        `);

        const stats = statsRes.rows[0];
        const settings = await getFileSettings(db);
        const quotaBytes = settings['files.storage_quota_bytes'] ?? null;

        return reply.send({
            totalFiles: stats.total_files,
            totalBytes: String(stats.total_bytes),
            imageCount: stats.image_count,
            imageBytes: String(stats.image_bytes),
            expiringFiles: stats.expiring_files,
            quotaBytes: quotaBytes != null ? String(quotaBytes) : null,
            quotaUsedPercent: quotaBytes != null ? Number(((BigInt(stats.total_bytes) * 10000n) / BigInt(quotaBytes)) ) / 100 : null,
        });
    });
}

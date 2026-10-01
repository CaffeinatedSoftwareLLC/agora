import { FastifyInstance } from 'fastify';
import { requireInstanceAdmin } from '../auth/middleware';
import { generateUlid } from '../utils/ulid';
import { getFileSettings, invalidateSettingsCache } from '../lib/settings';
import { codeRetentionDays, countRunsPrunedBy } from '../runtime/service';

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

        const [usersRes, countRes] = await Promise.all([
            db.query(
                `SELECT id, username, email, account_status, is_instance_admin, created_at
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
        }));

        return reply.send({ users, total: countRes.rows[0].count, page, limit });
    });

    // POST /admin/users/:id/ban
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

    // GET /admin/settings/ai — instance-wide AI settings
    app.get('/admin/settings/ai', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const db = request.dbClient!;
        const res = await db.query("SELECT value FROM instance_settings WHERE key = 'ai.allow_private_base_urls'");
        return reply.send({ allowPrivateBaseUrls: res.rows[0]?.value === true });
    });

    // PATCH /admin/settings/ai
    app.patch('/admin/settings/ai', {
        preHandler: [requireInstanceAdmin],
        schema: {
            body: {
                type: 'object',
                required: ['allowPrivateBaseUrls'],
                additionalProperties: false,
                properties: {
                    allowPrivateBaseUrls: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const { allowPrivateBaseUrls } = request.body as any;
        await db.query(
            `INSERT INTO instance_settings (key, value) VALUES ('ai.allow_private_base_urls', $1)
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
            [JSON.stringify(allowPrivateBaseUrls)]
        );
        await logAdminAction(db, request.userId, 'ai_settings_update', 'instance_settings', null, { allowPrivateBaseUrls });
        return reply.send({ allowPrivateBaseUrls });
    });

    // GET /admin/settings/runtime — sandbox code retention
    app.get('/admin/settings/runtime', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const days = await codeRetentionDays(app.db);
        return reply.send({ codeRetentionDays: days });
    });

    // PATCH /admin/settings/runtime — shortening retention needs confirm=true once the
    // caller has seen how many runs would lose their code (spec §9.1)
    app.patch('/admin/settings/runtime', {
        preHandler: [requireInstanceAdmin],
        schema: {
            body: {
                type: 'object', required: ['codeRetentionDays'], additionalProperties: false,
                properties: {
                    codeRetentionDays: { oneOf: [{ type: 'null' }, { type: 'integer', minimum: 1, maximum: 3650 }] },
                    confirm: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        const db = request.dbClient!;
        const { codeRetentionDays: days, confirm } = request.body as { codeRetentionDays: number | null; confirm?: boolean };
        const current = await codeRetentionDays(app.db);
        const shortening = days !== null && (current === null || days < current);
        if (shortening) {
            const affected = await countRunsPrunedBy(app.db, days);
            if (affected > 0 && !confirm) {
                return reply.status(409).send({
                    error: 'confirmation_required',
                    affectedRuns: affected,
                    message: `Code for ${affected} run(s) older than ${days} day(s) will be permanently deleted at the next cleanup. Resend with confirm: true to proceed.`,
                });
            }
        }
        await db.query(
            `INSERT INTO instance_settings (key, value) VALUES ('runtime.code_retention_days', $1)
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
            [JSON.stringify(days)]
        );
        await logAdminAction(db, request.userId, 'runtime_settings_update', 'instance_settings', null, { codeRetentionDays: days, previous: current });
        return reply.send({ codeRetentionDays: days });
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

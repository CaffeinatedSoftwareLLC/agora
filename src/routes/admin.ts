import { FastifyInstance } from 'fastify';
import { requireInstanceAdmin } from '../auth/middleware';
import { generateUlid } from '../utils/ulid';

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
        const db = (request as any).dbClient;

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
        const db = (request as any).dbClient;
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
        const db = (request as any).dbClient;
        const userId = (request as any).userId;
        const { id: targetId } = request.params as any;

        const userRes = await db.query(
            'SELECT account_status, username, email FROM users WHERE id = $1',
            [targetId]
        );

        if (userRes.rows.length === 0) {
            return reply.status(404).send({ error: 'user_not_found' });
        }

        if (userRes.rows[0].account_status !== 'pending') {
            return reply.status(409).send({ error: 'user_not_pending' });
        }

        await db.query(
            "UPDATE users SET account_status = 'active' WHERE id = $1",
            [targetId]
        );

        await logAdminAction(db, userId, 'user_approve', 'user', targetId, {
            before: { accountStatus: 'pending' },
            after: { accountStatus: 'active' },
        });

        return reply.send({
            user: {
                id: targetId.trim ? targetId.trim() : targetId,
                username: userRes.rows[0].username,
                email: userRes.rows[0].email,
                accountStatus: 'active',
            },
        });
    });

    // POST /admin/reject-user/:id
    app.post('/admin/reject-user/:id', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const db = (request as any).dbClient;
        const userId = (request as any).userId;
        const { id: targetId } = request.params as any;

        const userRes = await db.query(
            'SELECT account_status, username FROM users WHERE id = $1',
            [targetId]
        );

        if (userRes.rows.length === 0) {
            return reply.status(404).send({ error: 'user_not_found' });
        }

        if (userRes.rows[0].account_status !== 'pending') {
            return reply.status(409).send({ error: 'user_not_pending' });
        }

        await db.query('DELETE FROM users WHERE id = $1', [targetId]);

        await logAdminAction(db, userId, 'user_reject', 'user', targetId, {
            username: userRes.rows[0].username,
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
        const db = (request as any).dbClient;
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

    // POST /admin/users/:id/suspend
    app.post('/admin/users/:id/suspend', {
        preHandler: [requireInstanceAdmin],
    }, async (request, reply) => {
        const db = (request as any).dbClient;
        const userId = (request as any).userId;
        const { id: targetId } = request.params as any;

        // Cannot suspend yourself
        if (userId === targetId) {
            return reply.status(400).send({ error: 'cannot_suspend_self' });
        }

        const userRes = await db.query(
            'SELECT account_status, is_instance_admin, username, email FROM users WHERE id = $1',
            [targetId]
        );

        if (userRes.rows.length === 0) {
            return reply.status(404).send({ error: 'user_not_found' });
        }

        if (userRes.rows[0].is_instance_admin) {
            return reply.status(400).send({ error: 'cannot_suspend_admin' });
        }

        if (userRes.rows[0].account_status !== 'active') {
            return reply.status(409).send({ error: 'user_not_active' });
        }

        await db.query(
            "UPDATE users SET account_status = 'suspended' WHERE id = $1",
            [targetId]
        );

        await logAdminAction(db, userId, 'user_suspend', 'user', targetId, {
            before: { accountStatus: 'active' },
            after: { accountStatus: 'suspended' },
        });

        return reply.send({
            user: {
                id: targetId.trim ? targetId.trim() : targetId,
                username: userRes.rows[0].username,
                email: userRes.rows[0].email,
                accountStatus: 'suspended',
            },
        });
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
        const db = (request as any).dbClient;
        const userId = (request as any).userId;
        const { instanceName, registrationPolicy } = request.body as any;

        const fieldMap: Record<string, string> = {
            instanceName: 'instance_name',
            registrationPolicy: 'registration_policy',
        };

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
}

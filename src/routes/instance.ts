import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { hashPassword } from '../auth/passwords';
import { generateToken } from '../auth/tokens';
import { getSetupToken } from '../instance/setup-token';
import { resetInitializedCache } from '../instance/check-initialized';
import { DEFAULT_EVERYONE_PERMS } from '../permissions';

export async function instanceRoutes(app: FastifyInstance) {

    // GET /instance/status — unauthenticated, returns instance config
    app.get('/instance/status', async (request) => {
        const db = (request as any).dbClient;

        const result = await db.query(
            "SELECT key, value FROM instance_config WHERE key IN ('setup_complete', 'registration_policy', 'instance_name')"
        );

        const config: Record<string, string> = {};
        for (const row of result.rows) {
            config[row.key] = row.value;
        }

        return {
            initialized: config.setup_complete === 'true',
            registrationPolicy: config.registration_policy ?? 'open',
            instanceName: config.instance_name ?? 'Agora',
        };
    });

    // POST /instance/setup — one-time setup, creates admin + default server
    app.post('/instance/setup', {
        schema: {
            body: {
                type: 'object',
                required: ['setupToken', 'username', 'email', 'password'],
                properties: {
                    setupToken: { type: 'string', minLength: 1 },
                    username: { type: 'string', minLength: 1, maxLength: 32 },
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', minLength: 8 },
                    instanceName: { type: 'string', minLength: 1, maxLength: 100 },
                    registrationPolicy: { type: 'string', enum: ['open', 'invite_only', 'approval'] },
                },
            },
        },
    }, async (request, reply) => {
        const db = (request as any).dbClient;
        const {
            setupToken,
            username,
            email,
            password,
            instanceName,
            registrationPolicy,
        } = request.body as any;

        // 1. Acquire advisory lock to serialize concurrent setup attempts.
        //    Uses pg_advisory_xact_lock (released on COMMIT/ROLLBACK) so the lock
        //    works even if the setup_complete row is missing (partial migration / data damage).
        await db.query("SELECT pg_advisory_xact_lock(hashtext('instance_setup'))");

        const setupCheck = await db.query(
            "SELECT value FROM instance_config WHERE key = 'setup_complete'"
        );
        if (setupCheck.rows.length > 0 && setupCheck.rows[0].value === 'true') {
            return reply.status(409).send({ error: 'instance_already_initialized' });
        }

        // 2. Verify setup token
        const expectedToken = await getSetupToken();
        if (setupToken !== expectedToken) {
            return reply.status(403).send({ error: 'invalid_setup_token' });
        }

        // 3. Race guard — ensure no users exist (belt-and-suspenders behind the row lock)
        const userCount = await db.query('SELECT COUNT(*)::int AS count FROM users');
        if (userCount.rows[0].count > 0) {
            return reply.status(409).send({ error: 'instance_already_initialized' });
        }

        // 4. Create admin user
        const userId = generateUlid();
        const passwordHash = await hashPassword(password);

        await db.query('SAVEPOINT instance_setup');
        try {
            await db.query(
                `INSERT INTO users (id, username, email, password_hash, is_instance_admin)
                 VALUES ($1, $2, $3, $4, true)`,
                [userId, username, email, passwordHash]
            );

            // 5. Create default server (same pattern as servers.ts)
            const serverId = generateUlid();
            const roleId = generateUlid();
            const channelId = generateUlid();

            // 5a. Create @everyone role
            await db.query(
                `INSERT INTO roles (id, server_id, name, is_everyone, permissions, position)
                 VALUES ($1, $2, $3, true, $4, 0)`,
                [roleId, serverId, '@everyone', Number(DEFAULT_EVERYONE_PERMS)]
            );

            // 5b. Create server
            await db.query(
                `INSERT INTO servers (id, name, owner_id, everyone_role_id)
                 VALUES ($1, $2, $3, $4)`,
                [serverId, instanceName ?? 'Agora', userId, roleId]
            );

            // 5c. Add admin as member
            await db.query(
                `INSERT INTO server_members (server_id, user_id)
                 VALUES ($1, $2)`,
                [serverId, userId]
            );

            // 5d. Create #general channel
            await db.query(
                `INSERT INTO channels (id, channel_type, server_id, name, position)
                 VALUES ($1, 3, $2, $3, 0)`,
                [channelId, serverId, 'general']
            );

            // 6. Update instance_config
            await db.query(
                `INSERT INTO instance_config (key, value) VALUES
                    ('setup_complete', 'true'),
                    ('instance_name', $1),
                    ('registration_policy', $2)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                [instanceName ?? 'Agora', registrationPolicy ?? 'open']
            );

            await db.query('RELEASE SAVEPOINT instance_setup');
        } catch (err) {
            await db.query('ROLLBACK TO SAVEPOINT instance_setup');
            throw err;
        }

        // 7. Reset the initialized cache so subsequent requests see the change
        resetInitializedCache();

        // 8. Generate access token
        const accessToken = generateToken({ userId }, (app as any).jwtSecret);

        return reply.status(201).send({
            user: {
                id: userId,
                username,
                isInstanceAdmin: true,
            },
            accessToken,
        });
    });
}

import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { generateUlid } from '../utils/ulid';
import { DEFAULT_EVERYONE_PERMS } from '../permissions';

export async function serverRoutes(app: FastifyInstance) {
    const db = (app as any).db;

    // POST /servers → 201 { id, name, ownerId, everyoneRoleId }
    app.post('/servers', async (request, reply) => {
        const { name } = request.body as any;
        const userId = (request as any).userId;

        if (!name) {
            return reply.status(400).send({ error: 'Missing required field: name' });
        }

        const serverId = generateUlid();
        const roleId = generateUlid();
        const channelId = generateUlid();

        const client = await db.connect();
        try {
            await client.query('BEGIN');

            // Create @everyone role (DEFERRABLE FK allows this before server exists)
            await client.query(
                `INSERT INTO roles (id, server_id, name, is_everyone, permissions, position)
                 VALUES ($1, $2, $3, true, $4, 0)`,
                [roleId, serverId, '@everyone', Number(DEFAULT_EVERYONE_PERMS)]
            );

            // Create server
            await client.query(
                `INSERT INTO servers (id, name, owner_id, everyone_role_id)
                 VALUES ($1, $2, $3, $4)`,
                [serverId, name, userId, roleId]
            );

            // Create #general channel
            await client.query(
                `INSERT INTO channels (id, channel_type, server_id, name, position)
                 VALUES ($1, 3, $2, $3, 0)`,
                [channelId, serverId, 'general']
            );

            // Add creator as member
            await client.query(
                `INSERT INTO server_members (server_id, user_id)
                 VALUES ($1, $2)`,
                [serverId, userId]
            );

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        return reply.status(201).send({
            id: serverId,
            name,
            ownerId: userId,
            everyoneRoleId: roleId,
        });
    });

    // GET /servers/:id/channels → 200 [{ id, name, channelType }]
    app.get('/servers/:id/channels', async (request, reply) => {
        const { id: serverId } = request.params as any;
        const userId = (request as any).userId;

        // Check membership
        const member = await db.query(
            'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
            [serverId, userId]
        );
        if (member.rows.length === 0) {
            return reply.status(403).send({ error: 'Not a member of this server' });
        }

        const result = await db.query(
            'SELECT id, name, channel_type FROM channels WHERE server_id = $1 ORDER BY position',
            [serverId]
        );

        const channels = result.rows.map((row: any) => ({
            id: row.id,
            name: row.name,
            channelType: row.channel_type,
        }));

        return reply.status(200).send(channels);
    });

    // POST /servers/:id/invites → 201 { code }
    app.post('/servers/:id/invites', async (request, reply) => {
        const { id: serverId } = request.params as any;
        const userId = (request as any).userId;

        // Generate short invite code (8 hex chars, max 12 per spec)
        const code = crypto.randomBytes(4).toString('hex');

        await db.query(
            `INSERT INTO server_invites (code, server_id, creator_id)
             VALUES ($1, $2, $3)`,
            [code, serverId, userId]
        );

        return reply.status(201).send({ code });
    });

    // POST /invites/:code → 200 { serverId, userId }
    app.post('/invites/:code', async (request, reply) => {
        const { code } = request.params as any;
        const userId = (request as any).userId;

        const invite = await db.query(
            'SELECT server_id FROM server_invites WHERE code = $1',
            [code]
        );

        if (invite.rows.length === 0) {
            return reply.status(404).send({ error: 'Invite not found' });
        }

        const serverId = invite.rows[0].server_id;

        // Add as member (ignore if already member)
        await db.query(
            `INSERT INTO server_members (server_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [serverId, userId]
        );

        // Increment use count
        await db.query(
            'UPDATE server_invites SET use_count = use_count + 1 WHERE code = $1',
            [code]
        );

        return reply.status(200).send({
            serverId: serverId.trim(),
            userId: userId.trim(),
        });
    });
}

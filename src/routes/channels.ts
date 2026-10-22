import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { Permissions } from '../permissions';
import { loadAndComputePermissions } from './bots';

// ─── PreHandler: require ManageChannels permission ───

async function requireManageChannels(request: FastifyRequest, reply: FastifyReply) {
    // Bots never create, edit or delete channels, whatever roles or overrides they hold.
    // The bot route allowlist (src/auth/middleware.ts) refuses them first; this is the backstop.
    if (request.isBot) {
        return reply.status(403).send({ error: 'Bots cannot manage channels' });
    }
    const { id: serverId } = request.params as any;
    const userId = request.userId;
    const db = request.dbClient!;

    const member = await db.query(
        'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    );
    if (member.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this server' });
    }

    // The owner holds every bit and Administrator implies this one
    const perms = await loadAndComputePermissions(db, userId, serverId);
    if (!(perms & Permissions.ManageChannels) && !(perms & Permissions.Administrator)) {
        return reply.status(403).send({ error: 'Missing ManageChannels permission' });
    }
}

export async function channelRoutes(app: FastifyInstance) {

    // POST /servers/:id/channels → 201 { id, name, channelType, serverId }
    app.post('/servers/:id/channels', {
        preHandler: [requireManageChannels],
        schema: {
            body: {
                type: 'object',
                required: ['name', 'channelType'],
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                    channelType: { type: 'integer', enum: [3, 5] },
                },
            },
        },
    }, async (request, reply) => {
        const { id: serverId } = request.params as any;
        const { name, channelType } = request.body as any;
        const db = request.dbClient!;

        const channelId = generateUlid();

        await db.query(
            `INSERT INTO channels (id, channel_type, server_id, name, position)
             VALUES ($1, $2, $3, $4, 0)`,
            [channelId, channelType, serverId, name]
        );

        return reply.status(201).send({
            id: channelId.trim(),
            name,
            channelType,
            serverId: typeof serverId === 'string' ? serverId.trim() : serverId,
        });
    });
}

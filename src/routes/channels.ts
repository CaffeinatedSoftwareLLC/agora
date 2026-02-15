import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';

export async function channelRoutes(app: FastifyInstance) {

    // POST /servers/:id/channels → 201 { id, name, channelType, serverId }
    app.post('/servers/:id/channels', {
        schema: {
            body: {
                type: 'object',
                required: ['name', 'channelType'],
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                    channelType: { type: 'integer', enum: [3, 4, 5] },
                },
            },
        },
    }, async (request, reply) => {
        const { id: serverId } = request.params as any;
        const userId = (request as any).userId;
        const { name, channelType } = request.body as any;
        const db = (request as any).dbClient;

        // Check membership
        const member = await db.query(
            'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
            [serverId, userId]
        );
        if (member.rows.length === 0) {
            return reply.status(403).send({ error: 'Not a member of this server' });
        }

        const channelId = generateUlid();

        await db.query(
            `INSERT INTO channels (id, channel_type, server_id, name, position)
             VALUES ($1, $2, $3, $4, 0)`,
            [channelId, channelType, serverId, name]
        );

        return reply.status(201).send({
            id: channelId,
            name,
            channelType,
            serverId,
        });
    });
}

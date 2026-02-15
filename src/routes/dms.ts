import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';

export async function dmRoutes(app: FastifyInstance) {

    // POST /channels/dm → 201 { id, channelType }
    app.post('/channels/dm', {
        schema: {
            body: {
                type: 'object',
                required: ['recipientId'],
                properties: {
                    recipientId: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const userId = (request as any).userId;
        const { recipientId } = request.body as any;
        const db = (request as any).dbClient;

        // Can't DM yourself
        if (userId.trim() === recipientId.trim()) {
            return reply.status(400).send({ error: 'Cannot create DM with yourself' });
        }

        // Verify recipient exists
        const recipientCheck = await db.query(
            'SELECT id FROM users WHERE id = $1',
            [recipientId]
        );
        if (recipientCheck.rows.length === 0) {
            return reply.status(404).send({ error: 'Recipient not found' });
        }

        // Normalize ordering: user_a < user_b (lexicographic on trimmed values)
        const [userA, userB] = [userId.trim(), recipientId.trim()].sort();

        // Use SAVEPOINT for sub-transaction within the per-request transaction
        await db.query('SAVEPOINT dm_create');

        try {
            // Try to find existing DM pair
            const existing = await db.query(
                'SELECT channel_id FROM dm_pairs WHERE user_a = $1 AND user_b = $2',
                [userA, userB]
            );

            if (existing.rows.length > 0) {
                const channelId = existing.rows[0].channel_id.trim();
                await db.query('RELEASE SAVEPOINT dm_create');
                return reply.status(201).send({
                    id: channelId,
                    channelType: 1,
                });
            }

            // Create new DM channel
            const channelId = generateUlid();

            await db.query(
                `INSERT INTO channels (id, channel_type)
                 VALUES ($1, 1)`,
                [channelId]
            );

            // Insert dm_pair
            await db.query(
                `INSERT INTO dm_pairs (user_a, user_b, channel_id)
                 VALUES ($1, $2, $3)`,
                [userA, userB, channelId]
            );

            // Add both users as channel members
            await db.query(
                `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
                [channelId, userA]
            );
            await db.query(
                `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
                [channelId, userB]
            );

            await db.query('RELEASE SAVEPOINT dm_create');

            return reply.status(201).send({
                id: channelId.trim(),
                channelType: 1,
            });
        } catch (err: any) {
            await db.query('ROLLBACK TO SAVEPOINT dm_create');
            throw err;
        }
    });
}

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
            // Create channel speculatively — will be rolled back if pair already exists
            const channelId = generateUlid();

            await db.query(
                `INSERT INTO channels (id, channel_type) VALUES ($1, 1)`,
                [channelId]
            );

            // Atomic upsert: ON CONFLICT returns nothing, so we SELECT after
            const inserted = await db.query(
                `INSERT INTO dm_pairs (user_a, user_b, channel_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_a, user_b) DO NOTHING
                 RETURNING channel_id`,
                [userA, userB, channelId]
            );

            if (inserted.rows.length > 0) {
                // We won the race — wire up channel members
                await db.query(
                    `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
                    [channelId, userA]
                );
                await db.query(
                    `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
                    [channelId, userB]
                );

                // Fetch usernames for the DMCreated events
                const usersResult = await db.query(
                    'SELECT id, username FROM users WHERE id = ANY($1)',
                    [[userA, userB]]
                );
                const usersById = new Map(usersResult.rows.map((u: any) => [u.id.trim(), u.username]));

                await db.query('RELEASE SAVEPOINT dm_create');

                // Queue DMCreated events so both users' sockets join the new channel room
                const trimmedId = channelId.trim();
                const pendingEvents = (request as any).pendingEvents = (request as any).pendingEvents || [];
                pendingEvents.push({
                    room: `user:${userA}`,
                    event: 'DMCreated',
                    data: { channelId: trimmedId, name: usersById.get(userB) || '' },
                });
                pendingEvents.push({
                    room: `user:${userB}`,
                    event: 'DMCreated',
                    data: { channelId: trimmedId, name: usersById.get(userA) || '' },
                });

                return reply.status(201).send({
                    id: trimmedId,
                    channelType: 1,
                });
            }

            // Lost the race — rollback the speculative channel, return existing pair
            await db.query('ROLLBACK TO SAVEPOINT dm_create');

            const existing = await db.query(
                'SELECT channel_id FROM dm_pairs WHERE user_a = $1 AND user_b = $2',
                [userA, userB]
            );

            return reply.status(201).send({
                id: existing.rows[0].channel_id.trim(),
                channelType: 1,
            });
        } catch (err: any) {
            await db.query('ROLLBACK TO SAVEPOINT dm_create');
            throw err;
        }
    });
}

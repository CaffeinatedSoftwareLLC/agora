import { FastifyInstance } from 'fastify';

export async function userRoutes(app: FastifyInstance) {

    // GET /users/search?q=<prefix> → 200 [{ id, username }]
    app.get('/users/search', {
        schema: {
            querystring: {
                type: 'object',
                required: ['q'],
                properties: {
                    q: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const { q } = request.query as any;
        const userId = request.userId;
        const db = request.dbClient!;

        const result = await db.query(
            `SELECT id, username FROM users
             WHERE username ILIKE $1 AND id != $2 AND bot = false
             LIMIT 20`,
            [q + '%', userId]
        );

        const users = result.rows.map((row: any) => ({
            id: row.id.trim(),
            username: row.username,
        }));

        return reply.status(200).send(users);
    });
}

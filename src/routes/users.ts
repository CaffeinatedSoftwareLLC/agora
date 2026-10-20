import { FastifyInstance } from 'fastify';
import { asService } from '../lib/agent-sessions';

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

    // ─── UI preferences of the signed-in person (not bots) ───
    // Known keys only, so the column can't become a dumping ground for client data.

    // GET /users/@me/preferences → 200 { palette?, readAloud? }
    app.get('/users/@me/preferences', async (request, reply) => {
        if (request.isBot) return reply.status(403).send({ error: 'forbidden' });
        const db = request.dbClient!;
        const row = await asService(db, () => db.query('SELECT preferences FROM users WHERE id = $1', [request.userId]));
        return reply.send(row.rows[0]?.preferences ?? {});
    });

    // PATCH /users/@me/preferences { palette?, readAloud? } → 200 merged preferences
    app.patch('/users/@me/preferences', {
        schema: {
            body: {
                type: 'object',
                additionalProperties: false,
                minProperties: 1,
                properties: {
                    palette: { type: 'string', enum: ['aegean', 'terracotta'] },
                    // Read agents' new replies aloud: never, on phones (touch screens), or on every device
                    readAloud: { type: 'string', enum: ['off', 'phone', 'all'] },
                },
            },
        },
    }, async (request, reply) => {
        if (request.isBot) return reply.status(403).send({ error: 'forbidden' });
        // Fastify strips unknown properties before this runs; a body left with no known key is refused
        if (Object.keys(request.body as object).length === 0) return reply.status(400).send({ error: 'no known preference keys' });
        const db = request.dbClient!;
        // Each person writes only their own row; run past RLS with the id pinned to the caller
        const row = await asService(db, () => db.query(
            `UPDATE users SET preferences = preferences || $2::jsonb WHERE id = $1 RETURNING preferences`,
            [request.userId, JSON.stringify(request.body)]
        ));
        return reply.send(row.rows[0]?.preferences ?? {});
    });
}

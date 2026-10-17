import { FastifyInstance } from 'fastify';
import { canViewChannel } from '../lib/channel-access';
import { listDirectors } from '../lib/direct-agents';

export async function directorRoutes(app: FastifyInstance) {
    // GET /channels/:id/directors → 200 { directors: [{ userId, username, bot, authority }] }
    // Who may give agents instructions in this channel right now (src/lib/direct-agents.ts).
    // Agents call it through agora-mcp's who_directs.
    app.get('/channels/:id/directors', async (request, reply) => {
        const { id: channelId } = request.params as { id: string };
        const access = await canViewChannel(request.dbClient!, channelId, request.userId, !!request.isBot);
        if (!access.allowed) return reply.status(access.status ?? 403).send({ error: access.error ?? 'forbidden' });

        // Read with the server's own pool: bots can't see roles or membership under RLS
        const directors = await listDirectors((app as any).db, channelId);
        return reply.status(200).send({ directors });
    });
}

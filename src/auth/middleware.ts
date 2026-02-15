import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './tokens';

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.slice(7);
    try {
        const payload = verifyToken(token, (request.server as any).jwtSecret);
        (request as any).userId = payload.userId;
    } catch {
        return reply.status(401).send({ error: 'Invalid token' });
    }
}

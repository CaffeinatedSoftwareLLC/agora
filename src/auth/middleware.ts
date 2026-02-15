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

    // Check account_status — reject non-active users
    const db = (request as any).dbClient;
    const result = await db.query(
        'SELECT account_status FROM users WHERE id = $1',
        [(request as any).userId]
    );

    if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid token' });
    }

    const status = result.rows[0].account_status;
    if (status === 'pending') {
        return reply.status(403).send({ error: 'account_pending' });
    }
    if (status === 'suspended') {
        return reply.status(403).send({ error: 'account_suspended' });
    }
}

export async function requireInstanceAdmin(request: FastifyRequest, reply: FastifyReply) {
    const db = (request as any).dbClient;
    const userId = (request as any).userId;

    const result = await db.query(
        'SELECT is_instance_admin FROM users WHERE id = $1',
        [userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_instance_admin) {
        return reply.status(403).send({ error: 'insufficient_permissions' });
    }

    (request as any).isInstanceAdmin = true;
}

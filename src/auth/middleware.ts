import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, extractToken } from './tokens';
import { isTokenBlacklisted } from './token-blacklist';
import { parseBotToken, verifyBotSecret } from './bot-tokens';

const BOT_ALLOWED_ROUTES = new Set([
    'GET /channels/:id/messages',
    'POST /channels/:id/messages',
    'PATCH /channels/:id/messages/:msgId',
    'DELETE /channels/:id/messages/:msgId',
    'POST /channels/:id/messages/:msgId/replies',
    'GET /channels/:id/messages/:msgId/replies',
    'GET /channels/:id/threads',
    'GET /bots/@me/cursors',
    'PUT /bots/@me/cursors/:channelId',
    'GET /bots/@me',
]);

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;

    // Bot token auth path
    if (authHeader?.startsWith('Bot ')) {
        const raw = authHeader.slice(4);
        const parsed = parseBotToken(raw);
        if (!parsed) {
            return reply.status(401).send({ error: 'Malformed bot token' });
        }

        const db = request.dbClient!;

        // O(1) lookup by primary key
        const tokenRow = await db.query(
            'SELECT id, bot_id, secret_hash FROM bot_tokens WHERE id = $1 AND revoked_at IS NULL',
            [parsed.tokenId]
        );
        if (!tokenRow.rows[0]) {
            return reply.status(401).send({ error: 'Invalid bot token' });
        }

        const valid = await verifyBotSecret(parsed.secret, tokenRow.rows[0].secret_hash);
        if (!valid) {
            return reply.status(401).send({ error: 'Invalid bot token' });
        }

        // Route allowlist check
        const routeKey = `${request.method} ${request.routeOptions.url}`;
        if (!BOT_ALLOWED_ROUTES.has(routeKey)) {
            return reply.status(403).send({ error: 'Bots cannot access this endpoint' });
        }

        request.userId = tokenRow.rows[0].bot_id;
        request.isBot = true;

        // Update last_used_at (fire and forget)
        db.query('UPDATE bot_tokens SET last_used_at = NOW() WHERE id = $1', [parsed.tokenId]);
        return;
    }

    // Existing JWT auth path
    const token = extractToken(request.headers.authorization);
    if (!token) {
        return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    }

    let payload;
    try {
        payload = verifyToken(token, request.server.jwtSecret);
        request.userId = payload.userId;
    } catch {
        return reply.status(401).send({ error: 'Invalid token' });
    }

    // Check token blacklist (logout revocation)
    if (payload.jti && await isTokenBlacklisted(payload.jti)) {
        return reply.status(401).send({ error: 'Token revoked' });
    }

    // Check account_status — reject non-active users
    const db = request.dbClient!;
    const result = await db.query(
        'SELECT account_status FROM users WHERE id = $1',
        [request.userId]
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
    const db = request.dbClient!;
    const userId = request.userId;

    const result = await db.query(
        'SELECT is_instance_admin FROM users WHERE id = $1',
        [userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_instance_admin) {
        return reply.status(403).send({ error: 'insufficient_permissions' });
    }

    request.isInstanceAdmin = true;
}

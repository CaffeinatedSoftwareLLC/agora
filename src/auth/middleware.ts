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
    // File search returns names, tags and scores, never file content
    'GET /channels/:id/files/search',
    'PATCH /channels/:id/messages/:msgId/thread',
    'GET /bots/@me/cursors',
    'PUT /bots/@me/cursors/:channelId',
    'GET /bots/@me/thread-cursors',
    'PUT /bots/@me/thread-cursors/:threadId',
    'GET /bots/@me',
    'POST /runtime/runs',
    'GET /runtime/runs/:id',
    'GET /runtime/runs/:id/code',
]);

// Writes a paused bot may still make: read-cursor updates, so reading keeps working
const BOT_PAUSED_ALLOWED_WRITES = new Set([
    'PUT /bots/@me/cursors/:channelId',
    'PUT /bots/@me/thread-cursors/:threadId',
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
            `SELECT t.id, t.bot_id, t.secret_hash, u.bot_paused_at, u.bot_paused_reason
             FROM bot_tokens t
             JOIN users u ON u.id = t.bot_id
             WHERE t.id = $1 AND t.revoked_at IS NULL`,
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

        // Paused bots are read-only until resumed
        if (tokenRow.rows[0].bot_paused_at && request.method !== 'GET' && !BOT_PAUSED_ALLOWED_WRITES.has(routeKey)) {
            return reply.status(423).send({
                error: 'bot_paused',
                reason: tokenRow.rows[0].bot_paused_reason || null,
                pausedAt: tokenRow.rows[0].bot_paused_at,
            });
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

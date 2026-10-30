import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, extractToken, sessionLimitError, sessionNeedsRenewal, generateSessionToken } from './tokens';
import { isTokenBlacklisted } from './token-blacklist';
import { parseBotToken, verifyBotSecret } from './bot-tokens';
import { checkTokenUse, clientName, CLIENT_HEADER, TOKEN_BINDING_COLUMNS } from './token-binding';
import { isSafeMethod, sessionTokenFromHeaders, setSessionCookies, validCsrf } from './session-cookie';

/**
 * Sent by the UI on its own timers (polling). Such requests are not user activity,
 * so they never renew a cookie session; a tab left open does not keep it alive.
 */
export const BACKGROUND_HEADER = 'x-agora-background';

// Channel creation, edits and deletion are never on this list: bots don't manage channels
// (src/routes/channels.ts refuses them as well).
const BOT_ALLOWED_ROUTES = new Set([
    'GET /channels/:id/file-reservations',
    'POST /channels/:id/file-reservations',
    // Ownership handoffs (#84, src/routes/handoffs.ts)
    'POST /channels/:id/handoffs',
    'POST /channels/:id/handoffs/:offerId',
    'GET /channels/:id/threads/:threadId/handoffs',
    'GET /channels/:id/messages',
    'GET /channels/:id/attention',
    'POST /channels/:id/messages',
    'PATCH /channels/:id/messages/:msgId',
    'DELETE /channels/:id/messages/:msgId',
    'POST /channels/:id/messages/:msgId/replies',
    'GET /channels/:id/messages/:msgId/replies',
    'GET /channels/:id/threads',
    // Who may give agents instructions in the channel
    'GET /channels/:id/directors',
    // The channel's project context (agora-mcp's project_context); changing it is for people only
    'GET /channels/:id/project',
    // Agent sessions: the route itself requires can_direct for anything but listing
    'POST /channels/:id/agent-commands',
    // Task board (docs/task-board.md): reading is open to the channel, changes need can_direct
    'GET /channels/:id/tasks',
    'POST /channels/:id/tasks',
    'PATCH /channels/:id/tasks/:taskId',
    'POST /channels/:id/tasks/:taskId/start',
    // Subtask delegation: only during the bot's own hosted run in the channel
    'POST /channels/:id/subtasks',
    // File search returns names, tags and scores, never file content
    'GET /channels/:id/files/search',
    // Files in channels the bot can access: the extracted text, the image (scaled for a model),
    // and the file itself. Paused bots get the text only (the routes refuse the rest)
    'GET /files/:fileId/text',
    'GET /files/:fileId/image',
    'GET /files/:fileId',
    'POST /files/upload',
    'PATCH /channels/:id/messages/:msgId/thread',
    // Claude Code Channel: relay a permission prompt as an owner-only card, and read its answer
    'POST /channels/:id/permission-relays',
    'GET /channels/:id/permission-relays/:requestId',
    // Canvas artifacts: read what agents and people posted (docs/canvas-and-preview.md)
    'GET /channels/:id/artifacts',
    'GET /channels/:id/artifacts/:artifactId',
    'GET /channels/:id/artifacts/:artifactId/versions/:version',
    // Browser preview of the bot's own hosted session, and the screenshot it posted
    'POST /channels/:id/browser-previews',
    'GET /channels/:id/browser-previews/:previewId',
    'GET /channels/:id/browser-previews/:previewId/screenshot',
    'GET /bots/@me/cursors',
    'GET /bots/@me/attention-cursors',
    'PUT /bots/@me/attention-cursors/:channelId',
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
    'PUT /bots/@me/attention-cursors/:channelId',
    'PUT /bots/@me/cursors/:channelId',
    'PUT /bots/@me/thread-cursors/:threadId',
]);

/** Routes an agent host may call, and the only routes its token is good for. */
function isAgentHostRoute(request: FastifyRequest): boolean {
    return (request.routeOptions.url ?? '').startsWith('/agent-hosts/@me/');
}

/** ah_<hostId>.<secret>, the same shape as a bot token. */
function parseAgentHostToken(raw: string): { hostId: string; secret: string } | null {
    if (!raw.startsWith('ah_')) return null;
    const dot = raw.indexOf('.');
    if (dot === -1) return null;
    const hostId = raw.slice(3, dot);
    const secret = raw.slice(dot + 1);
    if (hostId.length !== 26 || !secret) return null;
    return { hostId, secret };
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;

    // Agent host token: valid only on /agent-hosts/@me/*. A host never acts as a user,
    // so no userId is set and the request runs without an RLS identity; the host routes
    // scope every query to the host's own server.
    if (authHeader?.startsWith('AgentHost ')) {
        const parsed = parseAgentHostToken(authHeader.slice('AgentHost '.length));
        if (!parsed) return reply.status(401).send({ error: 'Malformed host token' });
        const db = request.dbClient!;
        const row = await db.query(
            `SELECT id, server_id, secret_hash FROM agent_hosts WHERE id = $1 AND revoked_at IS NULL`,
            [parsed.hostId]
        );
        if (!row.rows[0] || !await verifyBotSecret(parsed.secret, row.rows[0].secret_hash)) {
            return reply.status(401).send({ error: 'Invalid host token' });
        }
        if (!isAgentHostRoute(request)) {
            return reply.status(403).send({ error: 'Host tokens cannot access this endpoint' });
        }
        request.agentHost = { id: row.rows[0].id.trim(), serverId: row.rows[0].server_id.trim() };
        db.query('UPDATE agent_hosts SET last_seen_at = NOW() WHERE id = $1', [parsed.hostId]);
        return;
    }
    if (isAgentHostRoute(request)) {
        return reply.status(403).send({ error: 'This endpoint needs a host token' });
    }

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
            `SELECT t.id, t.bot_id, t.secret_hash, u.bot_paused_at, u.bot_paused_reason,
                    u.account_status, u.server_id, o.account_status AS owner_status, ${TOKEN_BINDING_COLUMNS}
             FROM bot_tokens t
             JOIN users u ON u.id = t.bot_id
             LEFT JOIN users o ON o.id = u.bot_owner_id
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

        // Same account rules as the gateway (socketAccountError): the bot and its owner
        // must both be active, and a missing owner fails closed
        const { account_status: botStatus, owner_status: ownerStatus } = tokenRow.rows[0];
        if (botStatus !== 'active') {
            return reply.status(403).send({ error: `account_${botStatus}` });
        }
        if (ownerStatus !== 'active') {
            return reply.status(403).send({ error: 'bot_owner_inactive' });
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

        // A token bound to another agent's client is refused (#39); records the use either way
        const use = await checkTokenUse(db, {
            tokenId: parsed.tokenId,
            botId: tokenRow.rows[0].bot_id.trim(),
            serverId: tokenRow.rows[0].server_id?.trim() || null,
            row: tokenRow.rows[0],
            client: clientName(request.headers[CLIENT_HEADER]),
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
        });
        if (!use.ok) {
            return reply.status(403).send({ error: 'token_bound_to_other_client', boundClient: use.boundClient, message: use.message });
        }

        request.userId = tokenRow.rows[0].bot_id;
        request.isBot = true;
        return;
    }

    // JWT auth path: an Authorization header (API clients) or, when there is none,
    // the browser's httpOnly session cookie
    const headerToken = extractToken(authHeader);
    const cookieToken = authHeader ? null : sessionTokenFromHeaders(request.headers);
    const token = headerToken ?? cookieToken;
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

    // A browser sends the session cookie on its own, so state-changing requests made
    // with it must also carry the session's CSRF token (see session-cookie.ts)
    if (cookieToken) {
        request.cookieAuth = true;
        const limit = sessionLimitError(payload);
        if (limit) return reply.status(401).send({ error: limit });
        if (!isSafeMethod(request.method) && !(payload.jti && validCsrf(request, payload.jti, request.server.jwtSecret))) {
            return reply.status(403).send({ error: 'csrf_failed' });
        }
    }

    // Check account_status — reject non-active users
    const db = request.dbClient!;
    const result = await db.query(
        'SELECT account_status, token_version FROM users WHERE id = $1',
        [request.userId]
    );

    if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid token' });
    }

    if ((payload.tokenVersion ?? 0) !== result.rows[0].token_version) {
        return reply.status(401).send({ error: 'Token revoked' });
    }

    const status = result.rows[0].account_status;
    if (status === 'pending') {
        return reply.status(403).send({ error: 'account_pending' });
    }
    if (status === 'suspended') {
        return reply.status(403).send({ error: 'account_suspended' });
    }

    // Sliding renewal: activity on a cookie session pushes its idle deadline out again,
    // never past 30 days from login. Same jti, so CSRF and revocation are unchanged.
    if (cookieToken && request.headers[BACKGROUND_HEADER] !== '1' && sessionNeedsRenewal(payload)) {
        const renewed = generateSessionToken(
            { userId: payload.userId, tokenVersion: payload.tokenVersion ?? 0 },
            request.server.jwtSecret,
            { jti: payload.jti, authTime: payload.authTime ?? payload.iat },
        );
        setSessionCookies(reply, renewed.token, renewed.jti, renewed.exp, request.server.jwtSecret);
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

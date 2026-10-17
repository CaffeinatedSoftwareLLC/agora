import { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { generateToken, verifyToken, extractToken } from '../auth/tokens';
import { blacklistToken } from '../auth/token-blacklist';
import { generateUlid } from '../utils/ulid';
import type { LoginLimiter } from '../auth/login-limit';
import { requireAuth } from '../auth/middleware';

export async function authRoutes(app: FastifyInstance) {
    // POST /auth/register — policy-aware registration
    app.post('/auth/register', {
        config: {
            rateLimit: {
                max: 5,
                timeWindow: '1 hour',
            },
        },
        schema: {
            body: {
                type: 'object',
                required: ['username', 'email', 'password'],
                properties: {
                    username: { type: 'string', minLength: 1, maxLength: 32 },
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', minLength: 8, maxLength: 1024 },
                    inviteCode: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const { username, email, password, inviteCode } = request.body as any;
        const db = request.dbClient!;

        // Read registration policy from instance_config
        const policyResult = await db.query(
            "SELECT value FROM instance_config WHERE key = 'registration_policy'"
        );
        const policy = policyResult.rows[0]?.value ?? 'open';

        // invite_only requires an invite code
        if (policy === 'invite_only' && !inviteCode) {
            return reply.status(400).send({ error: 'invite_code_required' });
        }

        // Validate invite code if provided for invite_only
        // Uses FOR UPDATE to lock the row and prevent concurrent registrations
        // from exceeding max_uses (race condition guard)
        let invite: any = null;
        if (policy === 'invite_only') {
            const inviteResult = await db.query(
                `SELECT code, server_id, max_uses, use_count, expires_at
                 FROM server_invites
                 WHERE code = $1
                 FOR UPDATE`,
                [inviteCode]
            );
            if (inviteResult.rows.length === 0) {
                return reply.status(404).send({ error: 'invalid_invite_code' });
            }
            invite = inviteResult.rows[0];

            // Check if invite is expired
            if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
                return reply.status(404).send({ error: 'invalid_invite_code' });
            }

            // Check if invite has reached max uses
            if (invite.max_uses !== null && invite.use_count >= invite.max_uses) {
                return reply.status(404).send({ error: 'invalid_invite_code' });
            }
        }

        // Determine account_status based on policy
        const accountStatus = policy === 'approval' ? 'pending' : 'active';

        const id = generateUlid();
        const passwordHash = await hashPassword(password);

        try {
            await db.query(
                'INSERT INTO users (id, username, email, password_hash, account_status) VALUES ($1, $2, $3, $4, $5)',
                [id, username, email, passwordHash, accountStatus]
            );
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'username_or_email_taken' });
            }
            throw err;
        }

        // For open policy: auto-join the instance server
        if (policy === 'open') {
            const serverIdResult = await db.query(
                "SELECT value FROM instance_config WHERE key = 'instance_server_id'"
            );
            const instanceServerId = serverIdResult.rows[0]?.value;
            if (instanceServerId) {
                await db.query(
                    `INSERT INTO server_members (server_id, user_id)
                     VALUES ($1, $2)
                     ON CONFLICT DO NOTHING`,
                    [instanceServerId, id]
                );
            }
        }

        // For invite_only: add user to the invite's server and increment use_count
        if (policy === 'invite_only' && invite) {
            const serverId = invite.server_id;

            await db.query(
                `INSERT INTO server_members (server_id, user_id)
                 VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [serverId, id]
            );

            await db.query(
                'UPDATE server_invites SET use_count = use_count + 1 WHERE code = $1',
                [inviteCode]
            );
        }

        // For approval policy: return user info with pending status but NO token
        if (policy === 'approval') {
            return reply.status(201).send({
                user: { id, username },
                status: 'pending',
            });
        }

        // For open and invite_only: return token
        const token = generateToken({ userId: id }, app.jwtSecret);

        return reply.status(201).send({
            user: { id, username },
            accessToken: token,
        });
    });

    // POST /auth/login — `login` is a username or an email (`email` is the older name for the field)
    app.post('/auth/login', {
        schema: {
            body: {
                type: 'object',
                required: ['password'],
                anyOf: [{ required: ['login'] }, { required: ['email'] }],
                properties: {
                    login: { type: 'string', minLength: 1, maxLength: 255 },
                    email: { type: 'string', minLength: 1, maxLength: 255 },
                    password: { type: 'string', minLength: 1, maxLength: 1024 },
                },
            },
        },
    }, async (request, reply) => {
        const body = request.body as { login?: string; email?: string; password: string };
        const identifier = (body.login ?? body.email ?? '').trim();
        const { password } = body;
        const db = request.dbClient!;
        const limiter: LoginLimiter | null = (app as any).loginLimiter;

        // Limits are checked before any password is hashed. If Redis can't be reached
        // the login is refused rather than let through unlimited.
        if (limiter) {
            try {
                if (!await limiter.takeGlobalAttempt()) {
                    return reply.status(429).header('Retry-After', '60').send({ error: 'too_many_attempts' });
                }
            } catch (err) {
                request.log.error({ err }, 'login limit unavailable');
                return reply.status(503).send({ error: 'login_unavailable' });
            }
        }

        // Match the identifier against both columns, ignoring case. A username may look
        // like someone else's email (or differ from another only by case), so there can
        // be more than one candidate: the password decides which account it is. Exact
        // matches and email matches are tried first. Bots have no password and never log in.
        const result = await db.query(
            `SELECT id, username, password_hash, account_status, is_instance_admin, token_version
             FROM users
             WHERE bot = false AND password_hash IS NOT NULL
               AND (lower(email) = lower($1) OR lower(username) = lower($1))
             ORDER BY (email = $1) DESC, (username = $1) DESC, (lower(email) = lower($1)) DESC, id
             LIMIT 5`,
            [identifier]
        );

        // Every matched account is charged, not just the one the password would
        // unlock, so an ambiguous identifier can't be used to dodge a lock.
        const candidateIds = result.rows.map((r: any) => r.id.trim());
        if (limiter) {
            try {
                if (await limiter.reserveAttempt(candidateIds)) {
                    request.log.warn({ userIds: candidateIds }, 'login refused: too many attempts');
                    return reply.status(429)
                        .header('Retry-After', String(limiter.lockSeconds))
                        .send({ error: 'too_many_attempts' });
                }
            } catch (err) {
                request.log.error({ err }, 'login limit unavailable');
                return reply.status(503).send({ error: 'login_unavailable' });
            }
        }

        let user: any = null;
        for (const candidate of result.rows) {
            if (await verifyPassword(password, candidate.password_hash)) {
                user = candidate;
                break;
            }
        }

        if (!user) {
            return reply.status(401).send({ error: 'invalid_credentials' });
        }

        if (limiter) {
            await limiter.clearFailures(user.id).catch(() => { /* expires on its own */ });
        }

        // Check account status after credential verification
        if (user.account_status === 'pending') {
            return reply.status(403).send({ error: 'account_pending' });
        }
        if (user.account_status === 'suspended') {
            return reply.status(403).send({ error: 'account_suspended' });
        }

        const token = generateToken({ userId: user.id.trim(), tokenVersion: user.token_version }, app.jwtSecret);

        return reply.status(200).send({
            user: { id: user.id.trim(), username: user.username, isInstanceAdmin: user.is_instance_admin },
            accessToken: token,
        });
    });

    // POST /auth/logout — revoke the current token
    app.post('/auth/logout', async (request, reply) => {
        const raw = extractToken(request.headers.authorization);
        if (!raw) {
            return reply.status(401).send({ error: 'Missing token' });
        }

        try {
            const payload = verifyToken(raw, app.jwtSecret);
            if (payload.jti && payload.exp) {
                await blacklistToken(payload.jti, payload.exp);
                request.gatewayAccessChanged = true;
            }
        } catch {
            // Token is already invalid/expired — nothing to revoke
        }

        return reply.status(200).send({ success: true });
    });

    // Revoking all sessions includes this one. Only the authenticated user's row is updated.
    app.post('/auth/logout-all', { preHandler: [requireAuth] }, async (request, reply) => {
        await request.dbClient!.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [request.userId]);
        request.gatewayAccessChanged = true;
        return reply.status(200).send({ success: true });
    });
}

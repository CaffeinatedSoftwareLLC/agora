import { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { generateToken } from '../auth/tokens';
import { generateUlid } from '../utils/ulid';

export async function authRoutes(app: FastifyInstance) {
    // POST /auth/register — policy-aware registration
    app.post('/auth/register', {
        schema: {
            body: {
                type: 'object',
                required: ['username', 'email', 'password'],
                properties: {
                    username: { type: 'string', minLength: 1, maxLength: 32 },
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', minLength: 8 },
                    inviteCode: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const { username, email, password, inviteCode } = request.body as any;
        const db = (request as any).dbClient;

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
        const token = generateToken({ userId: id }, (app as any).jwtSecret);

        return reply.status(201).send({
            user: { id, username },
            accessToken: token,
        });
    });

    // POST /auth/login
    app.post('/auth/login', async (request, reply) => {
        const { email, password } = request.body as any;
        const db = (request as any).dbClient;

        const result = await db.query(
            'SELECT id, username, password_hash, account_status, is_instance_admin FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return reply.status(401).send({ error: 'invalid_credentials' });
        }

        const user = result.rows[0];
        const valid = await verifyPassword(password, user.password_hash);

        if (!valid) {
            return reply.status(401).send({ error: 'invalid_credentials' });
        }

        // Check account status after credential verification
        if (user.account_status === 'pending') {
            return reply.status(403).send({ error: 'account_pending' });
        }
        if (user.account_status === 'suspended') {
            return reply.status(403).send({ error: 'account_suspended' });
        }

        const token = generateToken({ userId: user.id.trim() }, (app as any).jwtSecret);

        return reply.status(200).send({
            user: { id: user.id.trim(), username: user.username, isInstanceAdmin: user.is_instance_admin },
            accessToken: token,
        });
    });
}

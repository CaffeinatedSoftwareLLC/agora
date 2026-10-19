import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { requireAuth } from '../auth/middleware';
import { relyingParty, saveCeremony, takeCeremony } from '../auth/passkeys';
import { deliverToken } from '../auth/session-cookie';
import type { LoginLimiter } from '../auth/login-limit';
import { generateUlid } from '../utils/ulid';
import { config } from '../config';

/**
 * Passkeys (#78): optional, alongside passwords. All WebAuthn verification is done by
 * @simplewebauthn/server. Challenges live in Redis for 5 minutes and are single use
 * (see src/auth/passkeys.ts). Signing in with a passkey gives the same session as a
 * password login.
 */

const MAX_PASSKEYS_PER_USER = 20;

// The browser's PublicKeyCredential JSON. The library validates its contents; the
// schema only bounds the shape and size of what reaches it.
const b64url = { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[A-Za-z0-9_-]+={0,2}$' };
const credentialSchema = {
    type: 'object',
    required: ['id', 'rawId', 'type', 'response'],
    properties: {
        id: b64url,
        rawId: b64url,
        type: { type: 'string', const: 'public-key' },
        authenticatorAttachment: { type: 'string', maxLength: 32 },
        clientExtensionResults: { type: 'object' },
        response: {
            type: 'object',
            required: ['clientDataJSON'],
            properties: {
                clientDataJSON: { type: 'string', minLength: 1, maxLength: 8192 },
                attestationObject: { type: 'string', maxLength: 32768 },
                authenticatorData: { type: 'string', maxLength: 8192 },
                signature: { type: 'string', maxLength: 4096 },
                userHandle: { type: 'string', maxLength: 512 },
                transports: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 32 } },
                publicKeyAlgorithm: { type: 'integer' },
                publicKey: { type: 'string', maxLength: 4096 },
            },
        },
    },
};

function humanOnly(request: FastifyRequest, reply: FastifyReply): boolean {
    if (request.isBot || !request.userId) {
        reply.status(403).send({ error: 'forbidden' });
        return false;
    }
    return true;
}

function rowToPasskey(row: any) {
    return {
        id: row.id.trim(),
        name: row.name,
        rpId: row.rp_id,
        deviceType: row.device_type,
        backedUp: row.backed_up,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
    };
}

export async function passkeyRoutes(app: FastifyInstance) {
    // GET /auth/passkeys: the signed-in user's passkeys
    app.get('/auth/passkeys', { preHandler: [requireAuth] }, async (request, reply) => {
        if (!humanOnly(request, reply)) return;
        const rows = await request.dbClient!.query(
            `SELECT id, name, rp_id, device_type, backed_up, created_at, last_used_at
             FROM user_passkeys WHERE user_id = $1 ORDER BY created_at`,
            [request.userId]
        );
        return { passkeys: rows.rows.map(rowToPasskey) };
    });

    // POST /auth/passkeys/register/options: start adding a passkey for the signed-in user
    app.post('/auth/passkeys/register/options', {
        preHandler: [requireAuth],
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        if (!humanOnly(request, reply)) return;
        const rp = relyingParty(request);
        if (!rp) return reply.status(400).send({ error: 'origin_not_allowed' });
        const db = request.dbClient!;
        const user = await db.query('SELECT username FROM users WHERE id = $1', [request.userId]);
        if (!user.rows[0]) return reply.status(401).send({ error: 'Invalid token' });
        const existing = await db.query(
            'SELECT credential_id, transports FROM user_passkeys WHERE user_id = $1',
            [request.userId]
        );
        if (existing.rows.length >= MAX_PASSKEYS_PER_USER) {
            return reply.status(409).send({ error: 'too_many_passkeys' });
        }
        const options = await generateRegistrationOptions({
            rpName: config.webauthn.rpName,
            rpID: rp.rpID,
            userName: user.rows[0].username,
            // The user handle a discoverable credential returns at sign-in: our user id
            userID: new TextEncoder().encode(request.userId.trim()),
            attestationType: 'none',
            // Don't register the same authenticator twice
            excludeCredentials: existing.rows.map((r: any) => ({
                id: r.credential_id,
                transports: r.transports as AuthenticatorTransportFuture[],
            })),
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        });
        const flowId = await saveCeremony({
            purpose: 'register', challenge: options.challenge, origin: rp.origin, rpID: rp.rpID, userId: request.userId.trim(),
        });
        return { flowId, options };
    });

    // POST /auth/passkeys/register/verify: finish adding a passkey
    app.post('/auth/passkeys/register/verify', {
        preHandler: [requireAuth],
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['flowId', 'response'],
                additionalProperties: false,
                properties: {
                    flowId: { type: 'string', minLength: 1, maxLength: 64 },
                    name: { type: 'string', minLength: 1, maxLength: 64 },
                    response: credentialSchema,
                },
            },
        },
    }, async (request, reply) => {
        if (!humanOnly(request, reply)) return;
        const body = request.body as { flowId: string; name?: string; response: any };
        const ceremony = await takeCeremony(body.flowId, 'register');
        // A flow belongs to the user who started it
        if (!ceremony || ceremony.userId !== request.userId.trim()) {
            return reply.status(400).send({ error: 'challenge_invalid' });
        }
        let verification;
        try {
            verification = await verifyRegistrationResponse({
                response: body.response,
                expectedChallenge: ceremony.challenge,
                expectedOrigin: ceremony.origin,
                expectedRPID: ceremony.rpID,
                requireUserVerification: true,
            });
        } catch (err) {
            request.log.info({ err }, 'passkey registration rejected');
            return reply.status(400).send({ error: 'passkey_invalid' });
        }
        if (!verification.verified || !verification.registrationInfo) {
            return reply.status(400).send({ error: 'passkey_invalid' });
        }
        const info = verification.registrationInfo;
        const name = body.name?.trim() || 'Passkey';
        const id = generateUlid();
        try {
            await request.dbClient!.query('SAVEPOINT add_passkey');
            const row = await request.dbClient!.query(
                `INSERT INTO user_passkeys
                     (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, rp_id, name)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING id, name, rp_id, device_type, backed_up, created_at, last_used_at`,
                [id, request.userId, info.credential.id, Buffer.from(info.credential.publicKey), info.credential.counter,
                 info.credential.transports ?? [], info.credentialDeviceType, info.credentialBackedUp, ceremony.rpID, name]
            );
            await request.dbClient!.query('RELEASE SAVEPOINT add_passkey');
            return reply.status(201).send({ passkey: rowToPasskey(row.rows[0]) });
        } catch (err: any) {
            await request.dbClient!.query('ROLLBACK TO SAVEPOINT add_passkey');
            if (err.code === '23505') return reply.status(409).send({ error: 'passkey_exists' });
            throw err;
        }
    });

    // DELETE /auth/passkeys/:id: remove one of your own passkeys
    app.delete('/auth/passkeys/:id', {
        preHandler: [requireAuth],
        schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 26, maxLength: 26 } } } },
    }, async (request, reply) => {
        if (!humanOnly(request, reply)) return;
        const { id } = request.params as { id: string };
        // Scoped to the caller explicitly as well as by RLS: someone else's id is a 404
        const result = await request.dbClient!.query(
            'DELETE FROM user_passkeys WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, request.userId]
        );
        if (!result.rows.length) return reply.status(404).send({ error: 'not_found' });
        return reply.status(204).send();
    });

    // POST /auth/passkeys/login/options: start signing in. With no `login`, any
    // discoverable passkey for this hostname may answer (username-less sign-in).
    app.post('/auth/passkeys/login/options', {
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                additionalProperties: false,
                properties: { login: { type: 'string', minLength: 1, maxLength: 255 } },
            },
        },
    }, async (request, reply) => {
        const rp = relyingParty(request);
        if (!rp) return reply.status(400).send({ error: 'origin_not_allowed' });
        const login = (request.body as { login?: string } | undefined)?.login?.trim();
        let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];
        let userId: string | undefined;
        if (login) {
            const rows = await request.dbClient!.query(
                `SELECT u.id, p.credential_id, p.transports
                 FROM users u JOIN user_passkeys p ON p.user_id = u.id
                 WHERE u.bot = false AND p.rp_id = $2
                   AND (lower(u.username) = lower($1) OR lower(u.email) = lower($1))`,
                [login, rp.rpID]
            );
            // Exactly one account: offer its passkeys. Otherwise (none, or an ambiguous
            // identifier) fall back to a discoverable-credential prompt, which looks the
            // same, so the response doesn't tell anyone whether the account exists.
            const owners = new Set(rows.rows.map((r: any) => r.id.trim()));
            if (owners.size === 1) {
                userId = [...owners][0] as string;
                allowCredentials = rows.rows.map((r: any) => ({ id: r.credential_id, transports: r.transports }));
            }
        }
        const options = await generateAuthenticationOptions({
            rpID: rp.rpID,
            allowCredentials,
            userVerification: 'required',
        });
        const flowId = await saveCeremony({ purpose: 'login', challenge: options.challenge, origin: rp.origin, rpID: rp.rpID, userId });
        return { flowId, options };
    });

    // POST /auth/passkeys/login/verify: finish signing in; same session as a password login
    app.post('/auth/passkeys/login/verify', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object',
                required: ['flowId', 'response'],
                additionalProperties: false,
                properties: {
                    flowId: { type: 'string', minLength: 1, maxLength: 64 },
                    response: credentialSchema,
                },
            },
        },
    }, async (request, reply) => {
        const body = request.body as { flowId: string; response: any };
        const db = request.dbClient!;
        const limiter: LoginLimiter | null = (app as any).loginLimiter;
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

        const ceremony = await takeCeremony(body.flowId, 'login');
        if (!ceremony) return reply.status(400).send({ error: 'challenge_invalid' });

        const found = await db.query(
            `SELECT p.id, p.user_id, p.credential_id, p.public_key, p.counter, p.transports, p.rp_id,
                    u.username, u.account_status, u.is_instance_admin, u.token_version, u.bot
             FROM user_passkeys p JOIN users u ON u.id = p.user_id
             WHERE p.credential_id = $1`,
            [body.response.id]
        );
        const passkey = found.rows[0];
        const ownerId: string | undefined = passkey?.user_id.trim();
        const userHandle: string | undefined = body.response.response?.userHandle;
        if (
            !passkey || passkey.bot
            || passkey.rp_id !== ceremony.rpID
            || (ceremony.userId && ceremony.userId !== ownerId)
            || (userHandle && Buffer.from(userHandle, 'base64url').toString('utf8') !== ownerId)
        ) {
            return reply.status(401).send({ error: 'invalid_credentials' });
        }

        let verification;
        try {
            verification = await verifyAuthenticationResponse({
                response: body.response,
                expectedChallenge: ceremony.challenge,
                expectedOrigin: ceremony.origin,
                expectedRPID: ceremony.rpID,
                requireUserVerification: true,
                credential: {
                    id: passkey.credential_id,
                    publicKey: new Uint8Array(passkey.public_key),
                    counter: Number(passkey.counter),
                    transports: passkey.transports,
                },
            });
        } catch (err) {
            // Includes a signature counter that went backwards (a cloned authenticator)
            request.log.info({ err }, 'passkey sign-in rejected');
            return reply.status(401).send({ error: 'invalid_credentials' });
        }
        if (!verification.verified) return reply.status(401).send({ error: 'invalid_credentials' });

        const info = verification.authenticationInfo;
        await db.query(
            `UPDATE user_passkeys SET counter = $2, backed_up = $3, device_type = $4, last_used_at = NOW() WHERE id = $1`,
            [passkey.id, info.newCounter, info.credentialBackedUp, info.credentialDeviceType]
        );

        if (passkey.account_status === 'pending') return reply.status(403).send({ error: 'account_pending' });
        if (passkey.account_status === 'suspended') return reply.status(403).send({ error: 'account_suspended' });

        return reply.status(200).send({
            user: { id: ownerId, username: passkey.username, isInstanceAdmin: passkey.is_instance_admin },
            ...deliverToken(request, reply, { userId: ownerId!, tokenVersion: passkey.token_version }, app.jwtSecret),
        });
    });
}

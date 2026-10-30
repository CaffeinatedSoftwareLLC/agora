import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { verifyPassword } from '../auth/passwords';
import { relyingParty, saveCeremony, takeCeremony } from '../auth/passkeys';
import { clearSessionCookies } from '../auth/session-cookie';
import type { LoginLimiter } from '../auth/login-limit';
import { credentialSchema } from './passkeys';
import { deleteAccount, deletedAccountMessages, deletionBlockers } from '../lib/account-deletion';

/**
 * Self-service account deletion (docs/account-deletion.md). People only; a bot is deleted
 * by its server's admins. Deleting needs the account's password or one of its passkeys,
 * and the username typed out.
 */

function humanOnly(request: FastifyRequest, reply: FastifyReply): boolean {
    if (request.isBot || !request.userId) {
        reply.status(403).send({ error: 'forbidden' });
        return false;
    }
    return true;
}

export async function accountDeletionRoutes(app: FastifyInstance) {
    // GET /users/@me/deletion → what deleting would do now, and what stops it
    app.get('/users/@me/deletion', async (request, reply) => {
        if (!humanOnly(request, reply)) return reply;
        const db = request.dbClient!;
        const blockers = await deletionBlockers(db, request.userId);
        const passkeys = await db.query('SELECT count(*)::int AS n FROM user_passkeys WHERE user_id = $1', [request.userId]);
        const bots = await db.query(
            'SELECT id, username, server_id FROM users WHERE bot AND bot_owner_id = $1 ORDER BY username',
            [request.userId]
        );
        return reply.send({
            deletedAccountMessages: await deletedAccountMessages(db),
            passkeys: passkeys.rows[0].n,
            ownedServers: blockers.ownedServers,
            lastAdmin: blockers.lastAdmin,
            ownedBots: bots.rows.map((b: any) => ({ id: b.id.trim(), username: b.username, serverId: b.server_id?.trim() ?? null })),
        });
    });

    // POST /users/@me/deletion/passkey-options → { flowId, options } for a passkey assertion
    // that DELETE /users/@me accepts instead of the password
    app.post('/users/@me/deletion/passkey-options', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        if (!humanOnly(request, reply)) return reply;
        const rp = relyingParty(request);
        if (!rp) return reply.status(400).send({ error: 'origin_not_allowed' });
        const rows = await request.dbClient!.query(
            'SELECT credential_id, transports FROM user_passkeys WHERE user_id = $1 AND rp_id = $2',
            [request.userId, rp.rpID]
        );
        if (!rows.rows.length) return reply.status(404).send({ error: 'no_passkeys' });
        const options = await generateAuthenticationOptions({
            rpID: rp.rpID,
            allowCredentials: rows.rows.map((r: any) => ({ id: r.credential_id, transports: r.transports as AuthenticatorTransportFuture[] })),
            userVerification: 'required',
        });
        const flowId = await saveCeremony({
            purpose: 'reauth', challenge: options.challenge, origin: rp.origin, rpID: rp.rpID, userId: request.userId.trim(),
        });
        return { flowId, options };
    });

    // DELETE /users/@me { confirm, password | passkey } → 200 { deleted, deletedAccountMessages }
    app.delete('/users/@me', {
        config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
        schema: {
            body: {
                type: 'object',
                required: ['confirm'],
                additionalProperties: false,
                anyOf: [{ required: ['password'] }, { required: ['passkey'] }],
                properties: {
                    // The account's username, typed out
                    confirm: { type: 'string', minLength: 1, maxLength: 64 },
                    password: { type: 'string', minLength: 1, maxLength: 1024 },
                    passkey: {
                        type: 'object',
                        required: ['flowId', 'response'],
                        additionalProperties: false,
                        properties: {
                            flowId: { type: 'string', minLength: 1, maxLength: 64 },
                            response: credentialSchema,
                        },
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!humanOnly(request, reply)) return reply;
        const body = request.body as { confirm: string; password?: string; passkey?: { flowId: string; response: any } };
        const db = request.dbClient!;
        const userId = request.userId.trim();

        const user = (await db.query('SELECT username, password_hash FROM users WHERE id = $1 AND NOT bot', [userId])).rows[0];
        if (!user) return reply.status(401).send({ error: 'Invalid token' });
        if (body.confirm.trim() !== user.username) return reply.status(400).send({ error: 'confirmation_mismatch' });

        const reauth = body.passkey
            ? await passkeyReauth(request, userId, body.passkey)
            : await passwordReauth(app, request, userId, user.password_hash, body.password!);
        if (reauth !== 'ok') {
            if (reauth === 'locked') return reply.status(429).send({ error: 'too_many_attempts' });
            if (reauth === 'unavailable') return reply.status(503).send({ error: 'login_unavailable' });
            return reply.status(403).send({ error: reauth });
        }

        const blockers = await deletionBlockers(db, userId, true);
        if (blockers.lastAdmin) return reply.status(409).send({ error: 'last_admin' });
        if (blockers.ownedServers.length) {
            return reply.status(409).send({ error: 'owns_servers', servers: blockers.ownedServers });
        }

        const policy = await deletedAccountMessages(db);
        const result = await deleteAccount(db, userId, policy);

        // After COMMIT: sockets of the person and of their bots are re-checked and dropped
        // (the user row and the bot tokens are gone), events go out, file blobs are removed.
        request.gatewayAccessChanged = true;
        request.pendingEvents ??= [];
        request.pendingEvents.push(...result.events);
        request.pendingBlobRemovals = result.blobKeys;
        if (request.cookieAuth) clearSessionCookies(reply);
        request.log.info({ messages: policy, messagesRemoved: result.messagesRemoved, botsPaused: result.botsPaused }, 'account deleted');
        return reply.send({ deleted: true, deletedAccountMessages: policy });
    });
}

type Reauth = 'ok' | 'reauth_failed' | 'challenge_invalid' | 'locked' | 'unavailable';

/** Password check, counted against the same per-account limit as POST /auth/login. */
async function passwordReauth(app: FastifyInstance, request: FastifyRequest, userId: string, hash: string | null, password: string): Promise<Reauth> {
    const limiter: LoginLimiter | null = (app as any).loginLimiter;
    if (limiter) {
        try {
            if (await limiter.reserveAttempt([userId])) return 'locked';
        } catch (err) {
            request.log.error({ err }, 'login limit unavailable');
            return 'unavailable';
        }
    }
    if (!hash || !await verifyPassword(password, hash)) return 'reauth_failed';
    if (limiter) await limiter.clearFailures(userId).catch(() => { /* expires on its own */ });
    return 'ok';
}

/** A fresh assertion from one of the caller's own passkeys, for a reauth ceremony they started. */
async function passkeyReauth(request: FastifyRequest, userId: string, passkey: { flowId: string; response: any }): Promise<Reauth> {
    const ceremony = await takeCeremony(passkey.flowId, 'reauth');
    if (!ceremony || ceremony.userId !== userId) return 'challenge_invalid';
    const found = await request.dbClient!.query(
        `SELECT id, credential_id, public_key, counter, transports FROM user_passkeys
         WHERE credential_id = $1 AND user_id = $2 AND rp_id = $3`,
        [passkey.response.id, userId, ceremony.rpID]
    );
    const row = found.rows[0];
    if (!row) return 'reauth_failed';
    try {
        const verification = await verifyAuthenticationResponse({
            response: passkey.response,
            expectedChallenge: ceremony.challenge,
            expectedOrigin: ceremony.origin,
            expectedRPID: ceremony.rpID,
            requireUserVerification: true,
            credential: {
                id: row.credential_id,
                publicKey: new Uint8Array(row.public_key),
                counter: Number(row.counter),
                transports: row.transports,
            },
        });
        return verification.verified ? 'ok' : 'reauth_failed';
    } catch (err) {
        request.log.info({ err }, 'passkey reauth rejected');
        return 'reauth_failed';
    }
}

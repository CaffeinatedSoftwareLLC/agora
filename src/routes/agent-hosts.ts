import { randomBytes } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { hashPassword } from '../auth/passwords';
import { isServerOwner } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { claimNext, complete, fail, heartbeat, type Notice } from '../lib/agent-runs';

/**
 * Agent hosts and profiles (docs/planning/agent-sessions-wbs.md).
 *
 * Owner routes, with a user's JWT: register and revoke hosts, and manage the profiles that
 * /start uses. Host routes under /agent-hosts/@me/*, with the host's own token: claim work,
 * heartbeat, complete, fail.
 */

const ID = { type: 'string', minLength: 26, maxLength: 26 } as const;

async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const { serverId } = request.params as any;
    if (!request.userId || request.isBot) {
        reply.status(403).send({ error: 'forbidden' });
        return null;
    }
    if (!await isServerOwner(request.dbClient!, serverId, request.userId)) {
        reply.status(403).send({ error: 'Only the server owner can manage agent hosts and profiles' });
        return null;
    }
    return serverId;
}

function hostJson(r: any) {
    return {
        id: r.id.trim(), name: r.name, createdAt: r.created_at,
        lastSeenAt: r.last_seen_at ?? null, revokedAt: r.revoked_at ?? null,
    };
}

function profileJson(r: any) {
    return {
        id: r.id.trim(), name: r.name, botId: r.bot_id.trim(), hostId: r.host_id.trim(),
        adapter: r.adapter, model: r.model ?? null, effort: r.effort ?? null, workdirAlias: r.workdir_alias,
        wakeBudget: r.wake_budget, tokenBudget: Number(r.token_budget), runTimeoutSec: r.run_timeout_sec,
        generation: r.generation, createdAt: r.created_at, updatedAt: r.updated_at,
    };
}

const profileFields = {
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]*$', minLength: 1, maxLength: 32 },
    botId: ID,
    hostId: ID,
    adapter: { type: 'string', enum: ['codex', 'claude'] },
    model: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
    effort: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'xhigh', null] },
    workdirAlias: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1, maxLength: 64 },
    wakeBudget: { type: 'integer', minimum: 1, maximum: 100000 },
    tokenBudget: { type: 'integer', minimum: 1 },
    runTimeoutSec: { type: 'integer', minimum: 60, maximum: 7200 },
} as const;

/** The bot belongs to this server and the host is this server's and not revoked. */
async function checkRefs(db: any, serverId: string, botId?: string, hostId?: string): Promise<string | null> {
    if (botId) {
        const bot = await db.query(`SELECT 1 FROM users WHERE id = $1 AND bot = true AND server_id = $2`, [botId, serverId]);
        if (bot.rows.length === 0) return 'Unknown bot';
    }
    if (hostId) {
        const host = await db.query(`SELECT 1 FROM agent_hosts WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL`, [hostId, serverId]);
        if (host.rows.length === 0) return 'Unknown host';
    }
    return null;
}

/** Queue system notices written by a host call for broadcast after the response. */
function queueNotices(request: FastifyRequest, notices: Notice[]) {
    if (notices.length === 0) return;
    request.pendingEvents ??= [];
    for (const n of notices) {
        request.pendingEvents.push({ room: `channel:${n.channelId}`, event: 'Message', data: n.event });
    }
}

/** Host routes don't use the per-request transaction: commit it now and give the client back. */
async function releaseRequestClient(request: FastifyRequest) {
    const client = request.dbClient;
    if (!client) return;
    request.dbClient = null;
    try {
        await client.query('COMMIT');
        request.txCommitted = true;
    } catch {
        await client.query('ROLLBACK').catch(() => {});
        request.txCommitted = false;
    }
    client.release();
}

export async function agentHostRoutes(app: FastifyInstance) {
    // ─── Hosts (owner) ───

    // POST /servers/:serverId/agent-hosts → 201 { host, token } (the token is shown once)
    app.post('/servers/:serverId/agent-hosts', {
        schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 64 } } } },
    }, async (request, reply) => {
        const serverId = await requireOwner(request, reply);
        if (!serverId) return reply;
        const { name } = request.body as any;
        const db = request.dbClient!;
        const id = generateUlid();
        const secret = randomBytes(32).toString('hex');
        const secretHash = await hashPassword(secret);
        try {
            const row = await asService(db, () => db.query(
                `INSERT INTO agent_hosts (id, server_id, name, secret_hash, created_by)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [id, serverId, name, secretHash, request.userId]
            ));
            return reply.status(201).send({ host: hostJson(row.rows[0]), token: `ah_${id}.${secret}` });
        } catch (err: any) {
            if (err.code === '23505') return reply.status(409).send({ error: 'A host with this name exists' });
            throw err;
        }
    });

    // GET /servers/:serverId/agent-hosts → 200 [host]
    app.get('/servers/:serverId/agent-hosts', async (request, reply) => {
        const serverId = await requireOwner(request, reply);
        if (!serverId) return reply;
        const db = request.dbClient!;
        const rows = await asService(db, () => db.query(
            `SELECT * FROM agent_hosts WHERE server_id = $1 ORDER BY created_at`, [serverId]
        ));
        return reply.send(rows.rows.map(hostJson));
    });

    // DELETE /servers/:serverId/agent-hosts/:hostId → 204 (revoke; its token stops working at once)
    app.delete('/servers/:serverId/agent-hosts/:hostId', async (request, reply) => {
        const serverId = await requireOwner(request, reply);
        if (!serverId) return reply;
        const { hostId } = request.params as any;
        const db = request.dbClient!;
        const row = await asService(db, () => db.query(
            `UPDATE agent_hosts SET revoked_at = NOW() WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL RETURNING id`,
            [hostId, serverId]
        ));
        if (row.rows.length === 0) return reply.status(404).send({ error: 'Host not found' });
        return reply.status(204).send();
    });

    // ─── Profiles (owner) ───

    // POST /servers/:serverId/agent-profiles → 201 profile
    app.post('/servers/:serverId/agent-profiles', {
        schema: {
            body: {
                type: 'object',
                required: ['name', 'botId', 'hostId', 'adapter', 'workdirAlias'],
                additionalProperties: false,
                properties: profileFields,
            },
        },
    }, async (request, reply) => {
        const serverId = await requireOwner(request, reply);
        if (!serverId) return reply;
        const b = request.body as any;
        const db = request.dbClient!;
        // A duplicate name aborts the INSERT; asService rolls back to its savepoint, so catch outside it
        try {
            const result = await asService(db, async () => {
                const bad = await checkRefs(db, serverId, b.botId, b.hostId);
                if (bad) return { status: 400, body: { error: bad } };
                const row = await db.query(
                    `INSERT INTO agent_profiles (id, server_id, name, bot_id, host_id, adapter, model, effort, workdir_alias,
                                                 wake_budget, token_budget, run_timeout_sec, created_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 50), COALESCE($11, 2000000), COALESCE($12, 900), $13)
                     RETURNING *`,
                    [generateUlid(), serverId, b.name, b.botId, b.hostId, b.adapter, b.model ?? null, b.effort ?? null,
                     b.workdirAlias, b.wakeBudget ?? null, b.tokenBudget ?? null, b.runTimeoutSec ?? null, request.userId]
                );
                return { status: 201, body: profileJson(row.rows[0]) };
            });
            return reply.status(result.status).send(result.body);
        } catch (err: any) {
            if (err.code === '23505') return reply.status(409).send({ error: 'A profile with this name exists' });
            throw err;
        }
    });

    // GET /servers/:serverId/agent-profiles → 200 [profile] (any member)
    app.get('/servers/:serverId/agent-profiles', async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const member = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, request.userId]);
        if (member.rows.length === 0) return reply.status(403).send({ error: 'forbidden' });
        const rows = await db.query(`SELECT * FROM agent_profiles WHERE server_id = $1 ORDER BY name`, [serverId]);
        return reply.send(rows.rows.map(profileJson));
    });

    // PATCH /servers/:serverId/agent-profiles/:profileId → 200 profile
    // Changing adapter, host or workdir bumps the generation and clears its sessions'
    // native IDs in the same transaction, so they rehydrate instead of resuming.
    app.patch('/servers/:serverId/agent-profiles/:profileId', {
        schema: {
            body: {
                type: 'object',
                additionalProperties: false,
                minProperties: 1,
                properties: profileFields,
            },
        },
    }, async (request, reply) => {
        const serverId = await requireOwner(request, reply);
        if (!serverId) return reply;
        const { profileId } = request.params as any;
        const b = request.body as any;
        const db = request.dbClient!;
        let result: { status: number; body: any };
        try { result = await asService(db, async () => {
            const cur = await db.query(
                `SELECT * FROM agent_profiles WHERE id = $1 AND server_id = $2 FOR UPDATE`, [profileId, serverId]
            );
            const p = cur.rows[0];
            if (!p) return { status: 404, body: { error: 'Profile not found' } };
            const bad = await checkRefs(db, serverId, b.botId, b.hostId);
            if (bad) return { status: 400, body: { error: bad } };

            const incompatible = (b.adapter !== undefined && b.adapter !== p.adapter)
                || (b.hostId !== undefined && b.hostId !== p.host_id.trim())
                || (b.workdirAlias !== undefined && b.workdirAlias !== p.workdir_alias)
                || (b.botId !== undefined && b.botId !== p.bot_id.trim());
            if (b.botId !== undefined && b.botId !== p.bot_id.trim()) {
                const used = await db.query(`SELECT 1 FROM agent_sessions WHERE profile_id = $1 AND state <> 'ended' LIMIT 1`, [profileId]);
                if (used.rows.length > 0) return { status: 409, body: { error: 'End this profile\'s sessions before changing its bot' } };
            }
            {
                const row = await db.query(
                    `UPDATE agent_profiles SET
                        name = COALESCE($3, name), bot_id = COALESCE($4, bot_id), host_id = COALESCE($5, host_id),
                        adapter = COALESCE($6, adapter),
                        model = CASE WHEN $7::boolean THEN $8 ELSE model END,
                        effort = CASE WHEN $9::boolean THEN $10 ELSE effort END,
                        workdir_alias = COALESCE($11, workdir_alias),
                        wake_budget = COALESCE($12, wake_budget), token_budget = COALESCE($13, token_budget),
                        run_timeout_sec = COALESCE($14, run_timeout_sec),
                        generation = generation + CASE WHEN $15::boolean THEN 1 ELSE 0 END,
                        updated_at = NOW()
                     WHERE id = $1 AND server_id = $2 RETURNING *`,
                    [profileId, serverId, b.name ?? null, b.botId ?? null, b.hostId ?? null, b.adapter ?? null,
                     'model' in b, b.model ?? null, 'effort' in b, b.effort ?? null, b.workdirAlias ?? null,
                     b.wakeBudget ?? null, b.tokenBudget ?? null, b.runTimeoutSec ?? null, incompatible]
                );
                if (incompatible) {
                    await db.query(`UPDATE agent_sessions SET native_session_id = NULL WHERE profile_id = $1`, [profileId]);
                }
                return { status: 200, body: profileJson(row.rows[0]) };
            }
        }); } catch (err: any) {
            if (err.code === '23505') return reply.status(409).send({ error: 'A profile with this name exists' });
            throw err;
        }
        return reply.status(result.status).send(result.body);
    });

    // DELETE /servers/:serverId/agent-profiles/:profileId → 204 (only without open sessions)
    app.delete('/servers/:serverId/agent-profiles/:profileId', async (request, reply) => {
        const serverId = await requireOwner(request, reply);
        if (!serverId) return reply;
        const { profileId } = request.params as any;
        const db = request.dbClient!;
        const result = await asService(db, async () => {
            const open = await db.query(`SELECT 1 FROM agent_sessions WHERE profile_id = $1 AND state <> 'ended' LIMIT 1`, [profileId]);
            if (open.rows.length > 0) return 409;
            const del = await db.query(`DELETE FROM agent_profiles WHERE id = $1 AND server_id = $2 RETURNING id`, [profileId, serverId]);
            return del.rows.length > 0 ? 204 : 404;
        });
        if (result === 409) return reply.status(409).send({ error: 'End this profile\'s sessions first' });
        if (result === 404) return reply.status(404).send({ error: 'Profile not found' });
        return reply.status(204).send();
    });

    // ─── Host routes (AgentHost token) ───

    // GET /agent-hosts/@me/runs/next?wait=0..25 → 200 claim | 204
    app.get('/agent-hosts/@me/runs/next', {
        schema: { querystring: { type: 'object', properties: { wait: { type: 'integer', minimum: 0, maximum: 25 } } } },
    }, async (request, reply) => {
        const host = request.agentHost!;
        const wait = (request.query as any).wait ?? 0;
        await releaseRequestClient(request);

        const deadline = Date.now() + wait * 1000;
        const notices: Notice[] = [];
        for (;;) {
            const claim = await claimNext(app.db, host, notices);
            if (claim) {
                queueNotices(request, notices);
                return reply.status(200).send(claim);
            }
            if (Date.now() >= deadline || request.raw.destroyed) break;
            await new Promise(r => setTimeout(r, Math.min(1000, Math.max(0, deadline - Date.now()))));
        }
        queueNotices(request, notices);
        return reply.status(204).send();
    });

    const claimBody = { claimToken: { type: 'string', minLength: 10, maxLength: 200 } } as const;

    // POST /agent-hosts/@me/runs/:runId/heartbeat → 200 { cancel, leaseUntil? | reason? }
    app.post('/agent-hosts/@me/runs/:runId/heartbeat', {
        schema: { body: { type: 'object', required: ['claimToken'], properties: claimBody } },
    }, async (request, reply) => {
        await releaseRequestClient(request);
        const notices: Notice[] = [];
        const { runId } = request.params as any;
        const r = await heartbeat(app.db, request.agentHost!, runId, (request.body as any).claimToken, notices);
        queueNotices(request, notices);
        return reply.status(r.status).send(r.body);
    });

    // POST /agent-hosts/@me/runs/:runId/complete → 200 { ok, cancelled?, repeated? }
    app.post('/agent-hosts/@me/runs/:runId/complete', {
        schema: {
            body: {
                type: 'object', required: ['claimToken'],
                properties: {
                    ...claimBody,
                    nativeSessionId: { type: ['string', 'null'], maxLength: 128 },
                    tokensUsed: { type: ['integer', 'null'], minimum: 0 },
                    summary: { type: ['string', 'null'], maxLength: 8000 },
                },
            },
        },
    }, async (request, reply) => {
        await releaseRequestClient(request);
        const notices: Notice[] = [];
        const { runId } = request.params as any;
        const r = await complete(app.db, request.agentHost!, runId, request.body as any, notices);
        queueNotices(request, notices);
        return reply.status(r.status).send(r.body);
    });

    // POST /agent-hosts/@me/runs/:runId/fail → 200 { ok, repeated? }
    app.post('/agent-hosts/@me/runs/:runId/fail', {
        schema: {
            body: {
                type: 'object', required: ['claimToken', 'error'],
                properties: {
                    ...claimBody,
                    error: { type: 'string', minLength: 1, maxLength: 64 },
                    message: { type: 'string', maxLength: 2000 },
                    tokensUsed: { type: ['integer', 'null'], minimum: 0 },
                    retryable: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        await releaseRequestClient(request);
        const notices: Notice[] = [];
        const { runId } = request.params as any;
        const r = await fail(app.db, request.agentHost!, runId, request.body as any, notices);
        queueNotices(request, notices);
        return reply.status(r.status).send(r.body);
    });
}

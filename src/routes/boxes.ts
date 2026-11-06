import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { isServerOwner } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { encryptString } from '../lib/encryption';
import { config } from '../config';
import { DOMAIN_ENTRY } from '../lib/boxes/contract';
import { boxHasLogin } from '../lib/boxes/adapters';
import { decideEdgeRequest, EdgeDecisionError, loginBlockedHosts } from '../lib/boxes/edge-requests';
import { BOX_ADAPTERS, BoxError, REPO_PATTERN, boxAction, createBox, deleteBox, patchBox, purgeBox, restoreBox } from '../lib/boxes/service';

/**
 * Agent boxes, owner API (docs/agent-boxes.md, docs/api-reference.md "Boxes").
 *
 * People only; the server owner manages boxes, members may list them. The box tables have no
 * app_user grants, so every query runs as the table owner (asService) after the route's own
 * owner or member check. boxd and the edge read the rows these routes write.
 */

const ID = { type: 'string', minLength: 26, maxLength: 26 } as const;
const NAME = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]*$', minLength: 1, maxLength: 32 } as const;
const REPO = { type: 'string', pattern: REPO_PATTERN, maxLength: 140 } as const;
const DOMAIN = { type: 'string', pattern: DOMAIN_ENTRY.source, maxLength: 255 } as const;
/** How long a login's URL, code and pasted code may live in Agora (§8.2). */
export const LOGIN_TTL_MINUTES = 10;
const OPEN_LOGIN = `('requested', 'claimed', 'awaiting_user', 'awaiting_code', 'code_sent')`;

const BOX_SELECT = `SELECT b.*, p.name, p.adapter, p.auth_mode, p.bot_id,
        (SELECT l.error FROM box_login_requests l WHERE l.box_id = b.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1) AS login_error,
        COALESCE((SELECT array_agg(r.owner || '/' || r.repo ORDER BY r.owner, r.repo) FROM box_repos r WHERE r.box_id = b.id), '{}') AS repos,
        COALESCE((SELECT json_agg(json_build_object('channelId', btrim(pp.channel_id), 'autoPush', pp.auto_push, 'autoPr', pp.auto_pr) ORDER BY pp.channel_id)
                  FROM box_push_policies pp WHERE pp.box_id = b.id), '[]') AS policies
    FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id`;

/**
 * A box as the API shows it. `loginError` is why its last login failed (when it did);
 * `loginBlockedHosts`, what the login needs allowed first (loginBlockedHosts), so a box that runs
 * but can't log in says so instead of only "running".
 */
export function boxJson(r: any, loginBlocked: string[] = []) {
    return {
        id: r.id.trim(), name: r.name, adapter: r.adapter, auth: r.auth_mode, state: r.state, desiredState: r.desired_state,
        pendingAction: r.pending_action ?? null, generation: r.generation, imageVersion: r.image_version ?? null,
        loginState: r.login_state, homeChannelId: r.home_channel_id?.trim() ?? null, allowedDomains: r.allowed_domains ?? [],
        repos: r.repos ?? [], cpus: Number(r.cpus), memoryMb: r.memory_mb, pids: r.pids,
        lastError: r.last_error ?? null, lastSeenAt: r.last_seen_at ?? null, createdAt: r.created_at,
        deletedAt: r.deleted_at ?? null, volumePurgeAfter: r.volume_purge_after ?? null, policies: r.policies ?? [],
        loginError: r.login_state === 'failed' ? (r.login_error ?? null) : null,
        loginBlockedHosts: loginBlocked,
    };
}

/** The hosts a box's login waits on or failed on: only asked when that is the box's state. */
async function boxLoginBlocked(db: any, r: any): Promise<string[]> {
    const waiting = r.login_state === 'pending' || (r.login_state === 'failed' && r.login_error === 'needs_domain');
    return waiting ? loginBlockedHosts(db, r.id.trim(), r.adapter) : [];
}

/** Rows to JSON, with each failed or running login's blocked hosts. */
export async function boxesJson(db: any, rows: any[]): Promise<any[]> {
    const out = [];
    for (const r of rows) out.push(boxJson(r, await boxLoginBlocked(db, r)));
    return out;
}

function loginJson(r: any, blockedHosts: string[] = []) {
    return {
        id: r.id.trim(), status: r.status, verificationUrl: r.verification_url ?? null, userCode: r.user_code ?? null,
        error: r.error ?? null, expiresAt: r.expires_at,
        // Domains the box was refused while this login ran: what it waits on, or failed on
        blockedHosts,
    };
}

/** Logins past their 10 minutes end, and their URL, code and pasted code go with them. */
export async function expireBoxLogins(db: any, boxId: string): Promise<void> {
    const r = await db.query(
        `UPDATE box_login_requests SET status = 'expired', verification_url = NULL, user_code = NULL,
                pasted_code_enc = NULL, pasted_code_iv = NULL, pasted_code_tag = NULL, updated_at = NOW()
         WHERE box_id = $1 AND status IN ${OPEN_LOGIN} AND expires_at < NOW() RETURNING id`,
        [boxId]
    );
    if (r.rows.length) await db.query(`UPDATE agent_boxes SET login_state = 'failed' WHERE id = $1 AND login_state = 'pending'`, [boxId]);
}

function person(request: FastifyRequest, reply: FastifyReply): string | null {
    if (!request.userId || request.isBot) { reply.status(403).send({ error: 'forbidden' }); return null; }
    return request.userId;
}

/** The box, if the caller owns its server; BoxError (403 / 404) otherwise. Runs as the table owner. */
async function ownedBox(request: FastifyRequest, lock: boolean): Promise<any> {
    if (!request.userId || request.isBot) throw new BoxError(403, 'forbidden');
    const { boxId } = request.params as any;
    const db = request.dbClient!;
    const box = (await db.query(`${BOX_SELECT} WHERE b.id = $1${lock ? ' FOR UPDATE OF b' : ''}`, [boxId])).rows[0];
    if (!box) throw new BoxError(404, 'box_not_found');
    if (!await isServerOwner(db, box.server_id.trim(), request.userId)) throw new BoxError(403, 'forbidden');
    return box;
}

async function requireServerOwner(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const userId = person(request, reply);
    if (!userId) return null;
    const { serverId } = request.params as any;
    if (!await isServerOwner(request.dbClient!, serverId, userId)) { reply.status(403).send({ error: 'forbidden' }); return null; }
    return serverId;
}

/** Map BoxError and unique violations to replies; anything else is a 500. */
async function run(reply: FastifyReply, fn: () => Promise<{ status: number; body?: any }>) {
    try {
        const r = await fn();
        return r.body === undefined ? reply.status(r.status).send() : reply.status(r.status).send(r.body);
    } catch (err: any) {
        if (err instanceof BoxError) return reply.status(err.status).send({ error: err.code, ...(err.detail ? { message: err.detail } : {}) });
        if (err instanceof EdgeDecisionError) return reply.status(err.status).send({ error: err.code });
        if (err.code === '23505') return reply.status(409).send({ error: 'name_taken' });
        throw err;
    }
}

/** The owner's GitHub account for a token, or null if GitHub refuses it. */
async function githubLogin(token: string): Promise<string | null> {
    const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agora-boxes' },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as { login?: unknown } | null;
    return typeof body?.login === 'string' ? body.login : null;
}

export async function boxRoutes(app: FastifyInstance) {
    // GET /servers/:serverId/boxes → { boxes } (members, read-only)
    app.get('/servers/:serverId/boxes', { schema: { params: { type: 'object', properties: { serverId: ID } } } }, async (request, reply) => {
        const userId = person(request, reply);
        if (!userId) return reply;
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const member = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
        if (member.rows.length === 0) return reply.status(403).send({ error: 'forbidden' });
        const boxes = await asService(db, async () => {
            const rows = await db.query(`${BOX_SELECT} WHERE b.server_id = $1 ORDER BY b.created_at`, [serverId]);
            return boxesJson(db, rows.rows);
        });
        return reply.send({ boxes });
    });

    // POST /servers/:serverId/boxes → 201 { box }
    app.post('/servers/:serverId/boxes', {
        schema: {
            params: { type: 'object', properties: { serverId: ID } },
            body: {
                type: 'object', required: ['name', 'adapter', 'homeChannelId'], additionalProperties: false,
                properties: {
                    name: NAME,
                    adapter: { type: 'string', enum: [...BOX_ADAPTERS] },
                    auth: { type: 'string', enum: ['subscription', 'api_key'] },
                    apiKey: { type: 'string', minLength: 8, maxLength: 512, pattern: '^[\\x21-\\x7e]+$' },
                    homeChannelId: ID,
                    repos: { type: 'array', maxItems: 20, items: REPO },
                    model: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
                    effort: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'xhigh', null] },
                },
            },
        },
    }, async (request, reply) => {
        const serverId = await requireServerOwner(request, reply);
        if (!serverId) return reply;
        const db = request.dbClient!;
        const b = request.body as any;
        // A duplicate name aborts an INSERT; asService rolls back to its savepoint, so run() catches outside it
        return run(reply, () => asService(db, async () => {
            const boxId = await createBox(db, { ...b, serverId, userId: request.userId! });
            const row = (await db.query(`${BOX_SELECT} WHERE b.id = $1`, [boxId])).rows[0];
            return { status: 201, body: { box: boxJson(row) } };
        }));
    });

    // PATCH /boxes/:boxId → { box }
    app.patch('/boxes/:boxId', {
        schema: {
            params: { type: 'object', properties: { boxId: ID } },
            body: {
                type: 'object', additionalProperties: false, minProperties: 1,
                properties: {
                    allowedDomains: { type: 'array', maxItems: 200, items: DOMAIN },
                    repos: { type: 'array', maxItems: 20, items: REPO },
                    cpus: { type: 'number', exclusiveMinimum: 0, maximum: 16 },
                    memoryMb: { type: 'integer', minimum: 512, maximum: 65536 },
                    pids: { type: 'integer', minimum: 64, maximum: 16384 },
                    homeChannelId: ID,
                },
            },
        },
    }, async (request, reply) => owned(request, reply, true, async (db, box) => {
        if (box.desired_state === 'deleted') throw new BoxError(409, 'box_deleted');
        await patchBox(db, { id: box.id.trim(), server_id: box.server_id.trim(), bot_id: box.bot_id.trim() }, request.body as any, request.userId!);
        const row = (await db.query(`${BOX_SELECT} WHERE b.id = $1`, [box.id])).rows[0];
        return { status: 200, body: { box: boxJson(row) } };
    }));

    // POST /boxes/:boxId/actions { action, confirm? } → { box }
    app.post('/boxes/:boxId/actions', {
        schema: {
            params: { type: 'object', properties: { boxId: ID } },
            body: {
                type: 'object', required: ['action'], additionalProperties: false,
                properties: {
                    action: { type: 'string', enum: ['start', 'stop', 'restart', 'rebuild', 'reset'] },
                    confirm: { type: 'string', maxLength: 64 },
                },
            },
        },
    }, async (request, reply) => owned(request, reply, true, async (db, box) => {
        const b = request.body as any;
        await boxAction(db, { id: box.id.trim(), name: box.name, state: box.state, desired_state: box.desired_state }, b.action, b.confirm);
        const row = (await db.query(`${BOX_SELECT} WHERE b.id = $1`, [box.id])).rows[0];
        return { status: 200, body: { box: boxJson(row) } };
    }));

    // DELETE /boxes/:boxId → 204: its host and bot tokens stop working now
    app.delete('/boxes/:boxId', { schema: { params: { type: 'object', properties: { boxId: ID } } } },
        async (request, reply) => owned(request, reply, true, async (db, box) => {
            if (box.desired_state === 'deleted') throw new BoxError(409, 'box_deleted');
            await deleteBox(db, { id: box.id.trim(), host_id: box.host_id.trim(), bot_id: box.bot_id.trim() });
            await audit(db, box, request.userId!, 'box_delete');
            return { status: 204 };
        }));

    // POST /boxes/:boxId/restore → { box } (within the 7 days)
    app.post('/boxes/:boxId/restore', { schema: { params: { type: 'object', properties: { boxId: ID } } } },
        async (request, reply) => owned(request, reply, true, async (db, box) => {
            await restoreBox(db, box.id.trim());
            await audit(db, box, request.userId!, 'box_restore');
            const row = (await db.query(`${BOX_SELECT} WHERE b.id = $1`, [box.id])).rows[0];
            return { status: 200, body: { box: boxJson(row) } };
        }));

    // POST /boxes/:boxId/purge → { box }: the home volume goes on boxd's next pass
    app.post('/boxes/:boxId/purge', { schema: { params: { type: 'object', properties: { boxId: ID } } } },
        async (request, reply) => owned(request, reply, true, async (db, box) => {
            await purgeBox(db, box.id.trim());
            await audit(db, box, request.userId!, 'box_purge');
            const row = (await db.query(`${BOX_SELECT} WHERE b.id = $1`, [box.id])).rows[0];
            return { status: 200, body: { box: boxJson(row) } };
        }));

    // PUT /boxes/:boxId/policies/:channelId { autoPush, autoPr } → { policy }
    app.put('/boxes/:boxId/policies/:channelId', {
        schema: {
            params: { type: 'object', properties: { boxId: ID, channelId: ID } },
            body: { type: 'object', required: ['autoPush', 'autoPr'], additionalProperties: false,
                properties: { autoPush: { type: 'boolean' }, autoPr: { type: 'boolean' } } },
        },
    }, async (request, reply) => owned(request, reply, false, async (db, box) => {
        const { channelId } = request.params as any;
        const b = request.body as any;
        const ch = await db.query(`SELECT 1 FROM channels WHERE id = $1 AND server_id = $2`, [channelId, box.server_id]);
        if (ch.rows.length === 0) throw new BoxError(400, 'unknown_channel');
        await db.query(
            `INSERT INTO box_push_policies (box_id, channel_id, auto_push, auto_pr, updated_by) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (box_id, channel_id) DO UPDATE SET auto_push = $3, auto_pr = $4, updated_by = $5, updated_at = NOW()`,
            [box.id, channelId, b.autoPush, b.autoPr, request.userId]
        );
        return { status: 200, body: { policy: { channelId, autoPush: b.autoPush, autoPr: b.autoPr } } };
    }));

    // ─── CLI login inside the box (§8.2) ───

    // POST /boxes/:boxId/login → 201 { login }: a new request the box's host claims; an open one is cancelled
    app.post('/boxes/:boxId/login', { schema: { params: { type: 'object', properties: { boxId: ID } } } },
        async (request, reply) => owned(request, reply, true, async (db, box) => {
            if (box.desired_state === 'deleted') throw new BoxError(409, 'box_deleted');
            // An API-key-only CLI (opencode) has no login of its own to relay (adapters.ts)
            if (!boxHasLogin(box.adapter)) throw new BoxError(409, 'login_not_supported');
            await db.query(
                `UPDATE box_login_requests SET status = 'cancelled', verification_url = NULL, user_code = NULL,
                        pasted_code_enc = NULL, pasted_code_iv = NULL, pasted_code_tag = NULL, updated_at = NOW()
                 WHERE box_id = $1 AND status IN ${OPEN_LOGIN}`,
                [box.id]
            );
            const row = await db.query(
                `INSERT INTO box_login_requests (id, box_id, requested_by, expires_at)
                 VALUES ($1, $2, $3, NOW() + make_interval(mins => $4)) RETURNING *`,
                [generateUlid(), box.id, request.userId, LOGIN_TTL_MINUTES]
            );
            await db.query(`UPDATE agent_boxes SET login_state = 'pending', updated_at = NOW() WHERE id = $1`, [box.id]);
            return { status: 201, body: { login: loginJson(row.rows[0]) } };
        }));

    // GET /boxes/:boxId/login → { login | null }: the latest request
    app.get('/boxes/:boxId/login', { schema: { params: { type: 'object', properties: { boxId: ID } } } },
        async (request, reply) => owned(request, reply, false, async (db, box) => {
            await expireBoxLogins(db, box.id);
            const row = await db.query(`SELECT * FROM box_login_requests WHERE box_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [box.id]);
            const login = row.rows[0];
            // While it runs: what it is blocked on now. Once it failed on a domain: that, still,
            // until the owner allows it. Other endings need no hint
            const blocked = login && (!['succeeded', 'failed', 'cancelled', 'expired'].includes(login.status) || login.error === 'needs_domain')
                ? await loginBlockedHosts(db, box.id, box.adapter) : [];
            return { status: 200, body: { login: login ? loginJson(login, blocked) : null } };
        }));

    // POST /boxes/:boxId/login/code { code } → { login }: the code Anthropic showed (Claude only)
    app.post('/boxes/:boxId/login/code', {
        schema: {
            params: { type: 'object', properties: { boxId: ID } },
            body: { type: 'object', required: ['code'], additionalProperties: false,
                properties: { code: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[\\x21-\\x7e]+$' } } },
        },
    }, async (request, reply) => owned(request, reply, true, async (db, box) => {
        await expireBoxLogins(db, box.id);
        const open = (await db.query(
            `SELECT id FROM box_login_requests WHERE box_id = $1 AND status = 'awaiting_code' FOR UPDATE`, [box.id]
        )).rows[0];
        if (!open) throw new BoxError(409, 'no_login_awaiting_code');
        const enc = encryptString((request.body as any).code, config.encryptionKey);
        const row = await db.query(
            `UPDATE box_login_requests SET pasted_code_enc = $2, pasted_code_iv = $3, pasted_code_tag = $4, updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [open.id, enc.encrypted, enc.iv, enc.authTag]
        );
        return { status: 200, body: { login: loginJson(row.rows[0]) } };
    }));

    // DELETE /boxes/:boxId/login → 204: cancel the open login
    app.delete('/boxes/:boxId/login', { schema: { params: { type: 'object', properties: { boxId: ID } } } },
        async (request, reply) => owned(request, reply, true, async (db, box) => {
            const r = await db.query(
                `UPDATE box_login_requests SET status = 'cancelled', verification_url = NULL, user_code = NULL,
                        pasted_code_enc = NULL, pasted_code_iv = NULL, pasted_code_tag = NULL, updated_at = NOW()
                 WHERE box_id = $1 AND status IN ${OPEN_LOGIN} RETURNING id`,
                [box.id]
            );
            if (r.rows.length) await db.query(`UPDATE agent_boxes SET login_state = 'none' WHERE id = $1 AND login_state = 'pending'`, [box.id]);
            return { status: 204 };
        }));

    // ─── Edge requests (§4.3): only the server owner decides ───

    // POST /box-edge-requests/:requestId { decision } → { status }
    app.post('/box-edge-requests/:requestId', {
        schema: {
            params: { type: 'object', properties: { requestId: ID } },
            body: { type: 'object', required: ['decision'], additionalProperties: false,
                properties: { decision: { type: 'string', enum: ['allow', 'deny', 'always', 'wildcard'] } } },
        },
    }, async (request, reply) => {
        const userId = person(request, reply);
        if (!userId) return reply;
        const { requestId } = request.params as any;
        const db = request.dbClient!;
        return run(reply, () => asService(db, async () => {
            const req = (await db.query(`SELECT server_id FROM box_edge_requests WHERE id = $1`, [requestId])).rows[0];
            if (!req) throw new BoxError(404, 'not_found');
            if (!await isServerOwner(db, req.server_id.trim(), userId)) throw new BoxError(403, 'forbidden');
            const result = await decideEdgeRequest(db, requestId, (request.body as any).decision, userId);
            if (result.events.length) (request.pendingEvents ??= []).push(...result.events as any[]);
            return { status: 200, body: { status: result.status } };
        }));
    });

    // ─── The owner's GitHub token for the git and PR brokers (§3.2) ───

    // PUT /servers/:serverId/github-credential { token } → { accountLogin }
    app.put('/servers/:serverId/github-credential', {
        schema: {
            params: { type: 'object', properties: { serverId: ID } },
            body: { type: 'object', required: ['token'], additionalProperties: false,
                properties: { token: { type: 'string', minLength: 20, maxLength: 255, pattern: '^[A-Za-z0-9_]+$' } } },
        },
    }, async (request, reply) => {
        const serverId = await requireServerOwner(request, reply);
        if (!serverId) return reply;
        const { token } = request.body as any;
        let login: string | null;
        try { login = await githubLogin(token); } catch { return reply.status(502).send({ error: 'github_unreachable' }); }
        if (!login) return reply.status(400).send({ error: 'github_token_invalid' });
        const enc = encryptString(token, config.encryptionKey);
        const db = request.dbClient!;
        await asService(db, () => db.query(
            `INSERT INTO box_github_credentials (server_id, token_enc, token_iv, token_tag, account_login, set_by, set_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (server_id) DO UPDATE SET token_enc = $2, token_iv = $3, token_tag = $4, account_login = $5, set_by = $6, set_at = NOW()`,
            [serverId, enc.encrypted, enc.iv, enc.authTag, login.slice(0, 39), request.userId]
        ));
        return reply.send({ accountLogin: login });
    });

    // GET /servers/:serverId/github-credential → { set, accountLogin, setAt }
    app.get('/servers/:serverId/github-credential', { schema: { params: { type: 'object', properties: { serverId: ID } } } }, async (request, reply) => {
        const serverId = await requireServerOwner(request, reply);
        if (!serverId) return reply;
        const db = request.dbClient!;
        const row = (await asService(db, () => db.query(`SELECT account_login, set_at FROM box_github_credentials WHERE server_id = $1`, [serverId]))).rows[0];
        return reply.send({ set: !!row, accountLogin: row?.account_login ?? null, setAt: row?.set_at ?? null });
    });

    // DELETE /servers/:serverId/github-credential → 204
    app.delete('/servers/:serverId/github-credential', { schema: { params: { type: 'object', properties: { serverId: ID } } } }, async (request, reply) => {
        const serverId = await requireServerOwner(request, reply);
        if (!serverId) return reply;
        const db = request.dbClient!;
        await asService(db, () => db.query(`DELETE FROM box_github_credentials WHERE server_id = $1`, [serverId]));
        return reply.status(204).send();
    });
}

async function audit(db: any, box: any, userId: string, action: string) {
    await db.query(
        `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes) VALUES ($1, $2, $3, $4, 'box', $5, $6)`,
        [generateUlid(), box.server_id, userId, action, box.id, JSON.stringify({ name: box.name })]
    );
}

/** Run `fn` as the table owner on a box the caller owns (the box tables aren't visible to app_user). */
async function owned(request: FastifyRequest, reply: FastifyReply, lock: boolean,
                     fn: (db: any, box: any) => Promise<{ status: number; body?: any }>) {
    const db = request.dbClient!;
    return run(reply, () => asService(db, async () => fn(db, await ownedBox(request, lock))));
}

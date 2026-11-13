import { randomBytes } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { hashPassword } from '../auth/passwords';
import { generateBotToken } from '../auth/bot-tokens';
import { isServerOwner } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { noticePathList } from '../lib/file-reservations';
import { applyBatch, endRunStream, STREAM_LIMITS, type WireEvent } from '../lib/run-stream';
import { claimNext, complete, fail, hashClaimToken, heartbeat, liveToolRequest, openToolRequest, postNotice, HostRevokedError, type Notice } from '../lib/agent-runs';
import { allowedToolsSchema, deniedToolsSchema, LIVE_WAIT_MAX_SECONDS, LIVE_WAIT_MIN_SECONDS, MAX_DETAIL, TOOL_RULE, toolPresetsSchema } from '../lib/agent-permissions';
import { agentImageRoutes } from './agent-images';
import { agentPlanRoutes } from './agent-plans';
import { checkpointSchema } from '../lib/agent-checkpoints';
import { attachProjectDocs, verificationSchema } from '../lib/channel-projects';
import { storage } from '../lib/storage';
import { config } from '../config';
import { MODEL_PATTERN } from '../lib/boxes/service';
import { LIMIT_SCHEMA, limitOf } from '../lib/agent-budget-notice';
import { SESSION_COMMAND_HOLDS_SQL } from '../lib/session-commands';
import { serverSubscriptionWakes, SUBSCRIPTION_WAKES, type SubscriptionWakes } from '../lib/provider-terms';

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
        // 'box' hosts belong to boxes (docs/agent-boxes.md); the Hosts list and host pickers show 'machine' ones
        kind: r.kind ?? 'machine', boxId: r.box_id?.trim() ?? null,
        lastSeenAt: r.last_seen_at ?? null, revokedAt: r.revoked_at ?? null,
    };
}

function profileJson(r: any) {
    return {
        id: r.id.trim(), name: r.name, botId: r.bot_id.trim(), hostId: r.host_id.trim(),
        adapter: r.adapter, model: r.model ?? null, effort: r.effort ?? null, workdirAlias: r.workdir_alias, workspaceId: r.workspace_id,
        // The session limits; null: no limit (docs/agent-limits.md)
        wakeBudget: limitOf(r.wake_budget), tokenBudget: limitOf(r.token_budget), runTimeoutSec: limitOf(r.run_timeout_sec),
        generation: r.generation, createdAt: r.created_at, updatedAt: r.updated_at,
        toolPresets: r.tool_presets ?? [], allowedTools: r.allowed_tools ?? [],
        // Reported by the host (provider-terms.ts); 'subscription' until it reports
        authMode: r.auth_mode ?? 'subscription', apiKeyEnv: r.api_key_env ?? null,
        runApproval: !!r.run_approval, authReportedAt: r.auth_reported_at ?? null,
        // 'siwc' only: whose ChatGPT plan it runs on (docs/codex-chatgpt-plan.md)
        planOwnerId: r.plan_owner_id?.trim() ?? null,
        // Host mode (docs/agent-boxes.md §10): the flag drives the owner-only wake rule; `boxed`
        // (the host is a box) is what the UI labels, so a profile is "unboxed" whenever it isn't boxed
        hostMode: !!r.host_mode, boxed: !!r.boxed,
        // "Show live output": the channel sees this agent's text and steps while it runs (docs/live-output.md)
        showLiveOutput: r.show_live_output !== false,
    };
}

/** Profile columns plus `boxed`, for SELECT ... FROM agent_profiles and RETURNING (table owner only). */
const PROFILE_COLS = `*, COALESCE((SELECT h.kind = 'box' FROM agent_hosts h WHERE h.id = agent_profiles.host_id), false) AS boxed`;

/**
 * `hostModeAck: true` is the owner's tick on "Run unboxed on this machine" (§10). A profile on a
 * machine host always runs unboxed, so creating one, or moving one to another machine host, needs
 * it (omitted or `false` is refused). The profile is host mode, which makes it owner-only whatever
 * its auth; the agent_profiles trigger (migration 081) also forces host_mode from the host's kind.
 */
const hostModeAck = { type: 'boolean' } as const;
const HOST_MODE_ACK_REQUIRED = 'A profile on a machine host runs unboxed; send hostModeAck: true to confirm';

const profileFields = {
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]*$', minLength: 1, maxLength: 32 },
    botId: ID,
    hostId: ID,
    // gemini, opencode and omp: hosted over ACP with an API key only; devin over ACP on the owner's login (agora-host src/acp/)
    adapter: { type: 'string', enum: ['codex', 'claude', 'gemini', 'opencode', 'omp', 'devin'] },
    // As agora-host's claim schema accepts it (src/lib/boxes/service.ts MODEL_PATTERN): anything else never wakes
    model: { type: ['string', 'null'], minLength: 1, maxLength: 64, pattern: MODEL_PATTERN },
    effort: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'xhigh', null] },
    workdirAlias: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1, maxLength: 64 },
    workspaceId: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
    // Session limits: a positive integer, or null for no limit (the default)
    wakeBudget: LIMIT_SCHEMA,
    tokenBudget: LIMIT_SCHEMA,
    runTimeoutSec: LIMIT_SCHEMA,
    // Tool presets and always-allowed rules (#73); the host reads them at every claim
    toolPresets: toolPresetsSchema,
    allowedTools: allowedToolsSchema,
    // Show the agent's live text and steps in the channel while it runs (default on)
    showLiveOutput: { type: 'boolean' },
    hostModeAck,
} as const;

/**
 * opencode's own default model is an OpenCode Zen one, and omp's is whatever its catalog lists
 * first, so an opencode or omp profile names its model (agora-host refuses to run one without).
 * OpenRouter IDs work with or without `openrouter/`.
 */
const OPENCODE_MODEL_REQUIRED = 'An opencode or omp profile needs a model, e.g. qwen/qwen3-coder (an OpenRouter model ID)';
const missingModel = (adapter: string, model: string | null | undefined) => (adapter === 'opencode' || adapter === 'omp') && !model;

/** The bot belongs to this server and the host is this server's and not revoked. */
async function checkRefs(db: any, serverId: string, botId?: string, hostId?: string): Promise<string | null> {
    if (botId) {
        const bot = await db.query(`SELECT 1 FROM users WHERE id = $1 AND bot = true AND server_id = $2`, [botId, serverId]);
        if (bot.rows.length === 0) return 'Unknown bot';
    }
    if (hostId) {
        // A box's host has exactly its box's profile (docs/agent-boxes.md §3.2)
        const host = await db.query(`SELECT 1 FROM agent_hosts WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL AND kind = 'machine'`, [hostId, serverId]);
        if (host.rows.length === 0) return 'Unknown host';
    }
    return null;
}

const BOX_PROFILE = 'This profile belongs to a box; change it in the box settings';
/** What Settings → Agents may still change on a box's profile: its session limits. */
const BOX_PROFILE_FIELDS: ReadonlySet<string> = new Set(['wakeBudget', 'tokenBudget', 'runTimeoutSec', 'showLiveOutput']);
async function isBoxProfile(db: any, profileId: string): Promise<boolean> {
    return (await db.query(`SELECT 1 FROM agent_boxes WHERE profile_id = $1`, [profileId])).rows.length > 0;
}

/** Queue system notices written by a host call for broadcast after the response. */
function queueNotices(request: FastifyRequest, notices: Notice[]) {
    if (notices.length === 0) return;
    request.pendingEvents ??= [];
    for (const n of notices) {
        request.pendingEvents.push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
    }
}

/** The run is over: drop its live-output tail and tell the channel's viewers to remove the block. */
async function endStream(request: FastifyRequest, db: any, runId: string) {
    endRunStream(runId);
    const r = await db.query(`SELECT s.channel_id, s.id AS session_id FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id WHERE r.id = $1`, [runId]);
    if (!r.rows[0]) return;
    const channelId = r.rows[0].channel_id.trim();
    request.pendingEvents ??= [];
    request.pendingEvents.push({ room: `channel:${channelId}`, event: 'AgentRunStreamEnd', data: { channelId, sessionId: r.rows[0].session_id.trim(), runId } });
}

/** Host routes don't use the per-request transaction: commit it now and give the client back. */
async function releaseRequestClient(request: FastifyRequest) {
    const client = request.dbClient;
    if (!client) return;
    request.dbClient = null;
    try {
        await client.query('COMMIT');
        request.txCommitted = true;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        request.txCommitted = false;
        request.txFailure = err;
        client.release(err instanceof Error ? err : true);
        throw err;
    }
    client.release();
}

export async function agentHostRoutes(app: FastifyInstance) {
    await agentImageRoutes(app);
    await agentPlanRoutes(app);
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
            // A box's host is revoked with its box (DELETE /boxes/:boxId), not here
            `UPDATE agent_hosts SET revoked_at = NOW() WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL AND kind = 'machine' RETURNING id`,
            [hostId, serverId]
        ));
        if (row.rows.length === 0) return reply.status(404).send({ error: 'Host not found' });
        return reply.status(204).send();
    });

    // ─── Server-wide agent settings ───

    // GET /servers/:serverId/agent-settings → 200 { subscriptionWakes } (any member)
    // subscriptionWakes: who besides the plan owner wakes subscription and siwc agents
    // (src/lib/provider-terms.ts, docs/provider-terms.md): 'owner_bots' (default) or 'owner_only'.
    app.get('/servers/:serverId/agent-settings', async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const member = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, request.userId]);
        if (member.rows.length === 0) return reply.status(403).send({ error: 'forbidden' });
        return reply.send({ subscriptionWakes: await asService(db, () => serverSubscriptionWakes(db, serverId)) });
    });

    // PATCH /servers/:serverId/agent-settings { subscriptionWakes } → 200 { subscriptionWakes } (owner)
    // Applies from the next message routed and the next claim; audit agent_settings_update.
    app.patch('/servers/:serverId/agent-settings', {
        schema: {
            body: {
                type: 'object', required: ['subscriptionWakes'], additionalProperties: false,
                properties: { subscriptionWakes: { type: 'string', enum: [...SUBSCRIPTION_WAKES] } },
            },
        },
    }, async (request, reply) => {
        const serverId = await requireOwner(request, reply);
        if (!serverId) return reply;
        const db = request.dbClient!;
        const { subscriptionWakes } = request.body as { subscriptionWakes: SubscriptionWakes };
        const previous = await asService(db, async () => {
            const before = await serverSubscriptionWakes(db, serverId);
            await db.query('UPDATE servers SET subscription_wakes = $2 WHERE id = $1', [serverId, subscriptionWakes]);
            return before;
        });
        if (previous !== subscriptionWakes) {
            await db.query(
                `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
                 VALUES ($1, $2, $3, 'agent_settings_update', 'server', $2, $4)`,
                [generateUlid(), serverId, request.userId, JSON.stringify({ subscriptionWakes, previous })]
            );
        }
        return reply.send({ subscriptionWakes });
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
        if (missingModel(b.adapter, b.model)) return reply.status(400).send({ error: OPENCODE_MODEL_REQUIRED });
        // checkRefs only accepts machine hosts, so every profile made here runs unboxed
        if (b.hostModeAck !== true) return reply.status(400).send({ error: HOST_MODE_ACK_REQUIRED });
        // A duplicate name aborts the INSERT; asService rolls back to its savepoint, so catch outside it
        try {
            const result = await asService(db, async () => {
                const bad = await checkRefs(db, serverId, b.botId, b.hostId);
                if (bad) return { status: 400, body: { error: bad } };
                const row = await db.query(
                    `INSERT INTO agent_profiles (id, server_id, name, bot_id, host_id, adapter, model, effort, workdir_alias,
                                                 wake_budget, token_budget, run_timeout_sec, created_by, workspace_id, tool_presets, allowed_tools,
                                                 host_mode, host_mode_ack_at, host_mode_ack_by, show_live_output)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, 'primary'),
                             COALESCE($15, '{}'::text[]), COALESCE($16, '{}'::text[]),
                             $17, CASE WHEN $17 THEN NOW() END, CASE WHEN $17 THEN $13::char(26) END, COALESCE($18, true))
                     RETURNING ${PROFILE_COLS}`,
                    [generateUlid(), serverId, b.name, b.botId, b.hostId, b.adapter, b.model ?? null, b.effort ?? null,
                     b.workdirAlias, b.wakeBudget ?? null, b.tokenBudget ?? null, b.runTimeoutSec ?? null, request.userId, b.workspaceId ?? null,
                     b.toolPresets ?? null, b.allowedTools ?? null, b.hostModeAck === true, b.showLiveOutput ?? null]
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
        // As the table owner: `boxed` reads agent_hosts, which members can't
        const rows = await asService(db, () => db.query(`SELECT ${PROFILE_COLS} FROM agent_profiles WHERE server_id = $1 ORDER BY name`, [serverId]));
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
        if (b.hostModeAck === false) return reply.status(400).send({ error: HOST_MODE_ACK_REQUIRED });
        let result: { status: number; body: any };
        try { result = await asService(db, async () => {
            const cur = await db.query(
                `SELECT * FROM agent_profiles WHERE id = $1 AND server_id = $2 FOR UPDATE`, [profileId, serverId]
            );
            const p = cur.rows[0];
            if (!p) return { status: 404, body: { error: 'Profile not found' } };
            // A box's profile is the box's (its settings); only the session limits are set here
            if (await isBoxProfile(db, profileId) && Object.keys(b).some(k => !BOX_PROFILE_FIELDS.has(k))) return { status: 409, body: { error: BOX_PROFILE } };
            if (b.workspaceId !== undefined && b.workspaceId !== p.workspace_id) {
                const used = await db.query(`SELECT 1 FROM agent_sessions WHERE profile_id = $1 AND state <> 'ended' LIMIT 1`, [profileId]);
                if (used.rows.length) return { status: 409, body: { error: 'End this profile\'s sessions before changing its workspace' } };
            }
            const bad = await checkRefs(db, serverId, b.botId, b.hostId);
            if (bad) return { status: 400, body: { error: bad } };
            if (missingModel(b.adapter ?? p.adapter, 'model' in b ? b.model : p.model)) return { status: 400, body: { error: OPENCODE_MODEL_REQUIRED } };
            // Moving to another host (checkRefs: a machine one) runs it unboxed there: the owner acknowledges that
            const moved = b.hostId !== undefined && b.hostId !== p.host_id.trim();
            if (moved && b.hostModeAck !== true) return { status: 400, body: { error: HOST_MODE_ACK_REQUIRED } };

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
                        workspace_id = COALESCE($16, workspace_id),
                        wake_budget = CASE WHEN $22::boolean THEN $12 ELSE wake_budget END,
                        token_budget = CASE WHEN $23::boolean THEN $13 ELSE token_budget END,
                        run_timeout_sec = CASE WHEN $24::boolean THEN $14 ELSE run_timeout_sec END,
                        show_live_output = COALESCE($25, show_live_output),
                        generation = generation + CASE WHEN $15::boolean THEN 1 ELSE 0 END,
                        tool_presets = COALESCE($17, tool_presets), allowed_tools = COALESCE($18, allowed_tools),
                        host_mode = host_mode OR $19::boolean,
                        host_mode_ack_at = CASE WHEN $19::boolean AND (NOT host_mode OR $21::boolean OR host_mode_ack_at IS NULL) THEN NOW() ELSE host_mode_ack_at END,
                        host_mode_ack_by = CASE WHEN $19::boolean AND (NOT host_mode OR $21::boolean OR host_mode_ack_at IS NULL) THEN $20 ELSE host_mode_ack_by END,
                        updated_at = NOW()
                     WHERE id = $1 AND server_id = $2 RETURNING ${PROFILE_COLS}`,
                    [profileId, serverId, b.name ?? null, b.botId ?? null, b.hostId ?? null, b.adapter ?? null,
                     'model' in b, b.model ?? null, 'effort' in b, b.effort ?? null, b.workdirAlias ?? null,
                     b.wakeBudget ?? null, b.tokenBudget ?? null, b.runTimeoutSec ?? null, incompatible, b.workspaceId ?? null,
                     b.toolPresets ?? null, b.allowedTools ?? null, b.hostModeAck === true, request.userId, moved,
                     'wakeBudget' in b, 'tokenBudget' in b, 'runTimeoutSec' in b, b.showLiveOutput ?? null]
                );
                // A profile's limits reach its sessions: the wake and run time limits are read from the
                // profile at every wake. A session's own token limit (set on its card, or given to a
                // subtask) gives way when the profile's is now looser, so removing or raising the limit
                // here lifts it everywhere; a higher limit set on one session survives a lower profile one.
                if ('tokenBudget' in b) {
                    await db.query(
                        `UPDATE agent_sessions SET token_budget = NULL
                         WHERE profile_id = $1 AND state <> 'ended' AND token_budget IS NOT NULL AND ($2::bigint IS NULL OR token_budget <= $2)`,
                        [profileId, b.tokenBudget]
                    );
                }
                if (incompatible) {
                    await db.query(`UPDATE agent_sessions SET native_session_id = NULL WHERE profile_id = $1`, [profileId]);
                }
                if (b.adapter !== undefined && b.adapter !== p.adapter) {
                    // The owner moved this bot to another CLI: its tokens bind to the new client on next use (#39)
                    const cleared = await db.query(
                        `UPDATE bot_tokens SET bound_client = NULL, bound_at = NULL WHERE bot_id = $1 AND bound_client IS NOT NULL RETURNING id`,
                        [row.rows[0].bot_id]
                    );
                    for (const t of cleared.rows) {
                        await db.query(
                            `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
                             VALUES ($1, $2, $3, 'bot_token_binding_clear', 'bot', $4, $5)`,
                            [generateUlid(), serverId, request.userId, row.rows[0].bot_id.trim(),
                             JSON.stringify({ tokenId: t.id.trim(), via: 'profile adapter change', profileId, adapter: b.adapter })]
                        );
                    }
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
            // Deleting a box's profile would delete the box with it: that is DELETE /boxes/:boxId
            if (await isBoxProfile(db, profileId)) return 'box';
            const open = await db.query(`SELECT 1 FROM agent_sessions WHERE profile_id = $1 AND state <> 'ended' LIMIT 1`, [profileId]);
            if (open.rows.length > 0) return 409;
            const del = await db.query(`DELETE FROM agent_profiles WHERE id = $1 AND server_id = $2 RETURNING id`, [profileId, serverId]);
            return del.rows.length > 0 ? 204 : 404;
        });
        if (result === 'box') return reply.status(409).send({ error: BOX_PROFILE });
        if (result === 409) return reply.status(409).send({ error: 'End this profile\'s sessions first' });
        if (result === 404) return reply.status(404).send({ error: 'Profile not found' });
        return reply.status(204).send();
    });

    // ─── Create an agent in one step (owner): bot + token + channel access + profile ───

    // POST /servers/:serverId/agents → 201 { bot, token, profile } (the token is shown once;
    // it goes into the host's config, never into a channel)
    app.post('/servers/:serverId/agents', {
        schema: {
            body: {
                type: 'object',
                required: ['name', 'adapter', 'hostId', 'workdirAlias'],
                additionalProperties: false,
                properties: {
                    name: profileFields.name,
                    adapter: profileFields.adapter,
                    hostId: profileFields.hostId,
                    workdirAlias: profileFields.workdirAlias,
                    workspaceId: profileFields.workspaceId,
                    model: profileFields.model,
                    effort: profileFields.effort,
                    channelId: ID,
                    hostModeAck,
                },
            },
        },
    }, async (request, reply) => {
        const serverId = await requireOwner(request, reply);
        if (!serverId) return reply;
        const b = request.body as any;
        const db = request.dbClient!;
        if (missingModel(b.adapter, b.model)) return reply.status(400).send({ error: OPENCODE_MODEL_REQUIRED });
        // checkRefs only accepts machine hosts, so every profile made here runs unboxed
        if (b.hostModeAck !== true) return reply.status(400).send({ error: HOST_MODE_ACK_REQUIRED });
        const { tokenId, secretHash, raw } = await generateBotToken();
        try {
            const result = await asService(db, async () => {
                const bad = await checkRefs(db, serverId, undefined, b.hostId);
                if (bad) return { status: 400, body: { error: bad } };
                if (b.channelId) {
                    const ch = await db.query(`SELECT 1 FROM channels WHERE id = $1 AND server_id = $2`, [b.channelId, serverId]);
                    if (ch.rows.length === 0) return { status: 400, body: { error: 'Unknown channel' } };
                }
                const botId = generateUlid();
                await db.query(
                    `INSERT INTO users (id, username, bot, bot_owner_id, server_id) VALUES ($1, $2, true, $3, $4)`,
                    [botId, b.name, request.userId, serverId]
                );
                await db.query(
                    `INSERT INTO bot_tokens (id, bot_id, secret_hash, name, created_by, purpose) VALUES ($1, $2, $3, $4, $5, 'host')`,
                    [tokenId, botId, secretHash, 'agent host', request.userId]
                );
                if (b.channelId) {
                    await db.query(
                        `INSERT INTO bot_channel_access (bot_id, channel_id, granted_by) VALUES ($1, $2, $3)`,
                        [botId, b.channelId, request.userId]
                    );
                }
                const profile = await db.query(
                    `INSERT INTO agent_profiles (id, server_id, name, bot_id, host_id, adapter, model, effort, workdir_alias, created_by, workspace_id,
                                                 host_mode, host_mode_ack_at, host_mode_ack_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'primary'), $12, CASE WHEN $12 THEN NOW() END, CASE WHEN $12 THEN $10::char(26) END)
                     RETURNING ${PROFILE_COLS}`,
                    [generateUlid(), serverId, b.name, botId, b.hostId, b.adapter, b.model ?? null, b.effort ?? null, b.workdirAlias, request.userId, b.workspaceId ?? null,
                     b.hostModeAck === true]
                );
                return {
                    status: 201,
                    body: { bot: { id: botId, username: b.name }, token: raw, profile: profileJson(profile.rows[0]) },
                };
            });
            return reply.status(result.status).send(result.body);
        } catch (err: any) {
            if (err.code === '23505') return reply.status(409).send({ error: 'That name is taken by a user, bot or profile' });
            throw err;
        }
    });

    // ─── Host routes (AgentHost token) ───

    // POST /agent-hosts/@me/profiles → 200 { updated: [name], unknown: [name] }
    // At start the host reports how each profile's CLI is signed in: its own account login
    // ('subscription') or an API key from an environment variable (only the NAME is sent).
    // The server applies the subscription rule from this (src/lib/provider-terms.ts).
    app.post('/agent-hosts/@me/profiles', {
        schema: { body: { type: 'object', required: ['profiles'], additionalProperties: false, properties: {
            profiles: { type: 'array', maxItems: 100, items: { type: 'object', required: ['name', 'adapter', 'authMode', 'runApproval'], additionalProperties: false, properties: {
                name: profileFields.name,
                adapter: profileFields.adapter,
                authMode: { type: 'string', enum: ['subscription', 'api_key', 'siwc'] },
                apiKeyEnv: { type: ['string', 'null'], pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
                runApproval: { type: 'boolean' },
            } } },
        } } },
    }, async (request, reply) => {
        const host = request.agentHost!, db = request.dbClient!;
        const updated: string[] = []; const unknown: string[] = [];
        // A box's host token is readable by the agent in that box (docs/agent-boxes.md §3.2), so
        // a box never sets its own auth: the owner chose it when creating the box. A report that
        // differs is refused; a matching one only records that the host checked in.
        const kind = (await db.query(`SELECT kind FROM agent_hosts WHERE id = $1`, [host.id])).rows[0]?.kind;
        if (kind === 'box') {
            for (const p of (request.body as any).profiles as Array<{ name: string; adapter: string; authMode: string; apiKeyEnv?: string | null; runApproval: boolean }>) {
                const row = (await db.query(
                    `SELECT id, auth_mode, api_key_env, run_approval FROM agent_profiles WHERE host_id = $1 AND server_id = $2 AND name = $3 AND adapter = $4`,
                    [host.id, host.serverId, p.name, p.adapter]
                )).rows[0];
                if (!row) { unknown.push(p.name); continue; }
                const same = row.auth_mode === p.authMode && (row.api_key_env ?? null) === (p.authMode === 'api_key' ? p.apiKeyEnv ?? null : null) && row.run_approval === p.runApproval;
                if (!same) return reply.status(409).send({ error: 'box_auth_is_owner_set' });
                await db.query(`UPDATE agent_profiles SET auth_reported_at = NOW() WHERE id = $1`, [row.id]);
                updated.push(p.name);
            }
            return reply.send({ updated, unknown });
        }
        for (const p of (request.body as any).profiles as Array<{ name: string; adapter: string; authMode: string; apiKeyEnv?: string | null; runApproval: boolean }>) {
            if (p.authMode === 'api_key' && !p.apiKeyEnv) return reply.status(400).send({ error: 'apiKeyEnv is required for api_key' });
            // Sign in with ChatGPT drives Codex app-server (docs/codex-chatgpt-plan.md)
            if (p.authMode === 'siwc' && p.adapter !== 'codex') return reply.status(400).send({ error: 'siwc is only for codex profiles' });
            // A Devin account is its holder's own (docs/provider-terms.md "Devin"): no API key mode
            if (p.adapter === 'devin' && p.authMode !== 'subscription') return reply.status(400).send({ error: 'devin runs only on the owner\'s own Devin login' });
            const row = await db.query(
                `UPDATE agent_profiles SET auth_mode = $4, api_key_env = $5, run_approval = $6, auth_reported_at = NOW()
                 WHERE host_id = $1 AND server_id = $2 AND name = $3 AND adapter = $7 RETURNING id`,
                [host.id, host.serverId, p.name, p.authMode, p.authMode === 'api_key' ? p.apiKeyEnv : null, p.runApproval, p.adapter]
            );
            (row.rows.length ? updated : unknown).push(p.name);
        }
        return reply.send({ updated, unknown });
    });

    app.post('/agent-hosts/@me/workspaces/reconcile', {
        schema: { body: { type: 'object', required: ['sessionIds'], properties: {
            sessionIds: { type: 'array', maxItems: 100, items: ID },
        } } },
    }, async (request, reply) => {
        const host = request.agentHost!;
        const rows = await request.dbClient!.query(`SELECT s.id FROM agent_sessions s
            JOIN agent_profiles p ON p.id = s.profile_id
            WHERE s.id = ANY($1) AND s.server_id = $2 AND s.state = 'ended'
            AND (p.host_id = $3 OR EXISTS (SELECT 1 FROM agent_runs owned WHERE owned.session_id = s.id AND owned.host_id = $3))
            AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id = s.id AND r.status = 'claimed')
            AND NOT EXISTS (SELECT 1 FROM agent_workspace_commands c WHERE c.session_id=s.id AND c.status IN ('queued','claimed'))
            AND NOT EXISTS (${SESSION_COMMAND_HOLDS_SQL('s.id')})`,
            [(request.body as any).sessionIds, host.serverId, host.id]);
        return reply.send(rows.rows.map(r => r.id.trim()));
    });
    app.post('/agent-hosts/@me/workspaces/warning', {
        schema: { body: { type: 'object', required: ['sessionId', 'paths'], properties: {
            sessionId: ID, paths: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'string', minLength: 1, maxLength: 4096 } },
        } } },
    }, async (request, reply) => {
        const host = request.agentHost!, db = request.dbClient!, b = request.body as any;
        const rows = await db.query(`SELECT s.channel_id FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id
            WHERE s.id = $1 AND s.server_id = $2 AND s.state = 'ended'
            AND (p.host_id = $3 OR EXISTS (SELECT 1 FROM agent_runs owned WHERE owned.session_id = s.id AND owned.host_id = $3))`, [b.sessionId, host.serverId, host.id]);
        if (!rows.rows[0]) return reply.status(404).send({ error: 'unknown_ended_session' });
        const notice = await postNotice(db, rows.rows[0].channel_id.trim(),
            `Kept worktree for ended session ${b.sessionId}: uncommitted files:\n${noticePathList(b.paths, '\n')}`);
        queueNotices(request, [notice]);
        return reply.send({ ok: true });
    });

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
            let claim;
            try {
                claim = await claimNext(app.db, host, notices);
            } catch (err) {
                // Revoked while the long poll was waiting: the host must stop
                if (err instanceof HostRevokedError) return reply.status(401).send({ error: 'Invalid host token' });
                throw err;
            }
            if (claim) {
                // Pinned file text, read after the claim committed (src/lib/channel-projects.ts)
                await attachProjectDocs({ db: app.db, store: storage, encryptionKey: config.encryptionKey }, claim);
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
        schema: { body: { type: 'object', required: ['claimToken'], properties: { ...claimBody, tokensUsed: { type: ['integer', 'null'], minimum: 0, maximum: 9007199254740991 },
            // What an ACP run is doing now (agora-host src/acp/session.ts); relayed live, not stored
            progress: { type: 'object', additionalProperties: false, required: ['step', 'toolCalls'], properties: {
                step: { type: ['string', 'null'], maxLength: 200 },
                toolCalls: { type: 'integer', minimum: 0, maximum: 1000000 },
                planDone: { type: ['integer', 'null'], minimum: 0, maximum: 10000 },
                planTotal: { type: ['integer', 'null'], minimum: 0, maximum: 10000 },
            } } } } },
    }, async (request, reply) => {
        await releaseRequestClient(request);
        const notices: Notice[] = [];
        const { runId } = request.params as any;
        const body = request.body as any;
        const r = await heartbeat(app.db, request.agentHost!, runId, body.claimToken, notices, body.tokensUsed, body.progress);
        queueNotices(request, notices);
        if (r.status === 200 && (r.body as any).cancel) await endStream(request, app.db, runId);
        return reply.status(r.status).send(r.body);
    });

    // POST /agent-hosts/@me/runs/:runId/stream → 200 { ok, enabled } (live output, docs/live-output.md)
    // A short request with a small batch of the run's text deltas and step events. Authorized as the
    // heartbeat is (this host, this claim, run still claimed), read without locks: a stream batch must
    // never queue behind the run's own transaction. Nothing is stored; the tail lives in memory and the
    // batch is emitted to the run's channel room only.
    app.post('/agent-hosts/@me/runs/:runId/stream', {
        bodyLimit: 128 * 1024,
        schema: { body: { type: 'object', required: ['claimToken', 'events'], additionalProperties: false, properties: {
            ...claimBody,
            events: { type: 'array', minItems: 1, maxItems: STREAM_LIMITS.maxEvents, items: { oneOf: [
                { type: 'object', required: ['type', 'message', 'delta'], additionalProperties: false, properties: {
                    type: { const: 'text' }, message: { type: 'string', minLength: 1, maxLength: 64 },
                    delta: { type: 'string', minLength: 1, maxLength: STREAM_LIMITS.maxDelta } } },
                { type: 'object', required: ['type', 'step', 'state'], additionalProperties: false, properties: {
                    type: { const: 'step' }, step: { type: 'string', minLength: 1, maxLength: 64 },
                    state: { enum: ['start', 'ok', 'failed'] }, tool: { type: 'string', maxLength: 40 },
                    label: { type: 'string', maxLength: STREAM_LIMITS.maxLabel } } },
            ] } },
        } } },
    }, async (request, reply) => {
        const host = request.agentHost!;
        await releaseRequestClient(request);
        const { runId } = request.params as any;
        const body = request.body as { claimToken: string; events: WireEvent[] };
        const r = await app.db.query(
            `SELECT r.status, r.claim_token_hash, (r.lease_until <= NOW()) AS lease_over, s.id AS session_id, s.channel_id,
                    COALESCE(s.thread_id, (SELECT MIN(i.thread_id) FROM agent_inbox i WHERE i.batch_id = r.batch_id
                        HAVING COUNT(*) = COUNT(i.thread_id) AND COUNT(DISTINCT i.thread_id) = 1)) AS thread_id,
                    p.name AS profile_name, p.show_live_output
             FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id JOIN agent_profiles p ON p.id = s.profile_id
             WHERE r.id = $1 AND r.host_id = $2 AND s.server_id = $3`,
            [runId, host.id, host.serverId]
        );
        const run = r.rows[0];
        if (!run) return reply.status(404).send({ error: 'not_found' });
        if (run.claim_token_hash !== hashClaimToken(body.claimToken)) return reply.status(409).send({ error: 'stale_claim' });
        if (run.status !== 'claimed') return reply.status(409).send({ error: run.status === 'expired' ? 'lease_expired' : 'already_finished', status: run.status });
        if (run.lease_over) return reply.status(409).send({ error: 'lease_expired' });
        // The owner turned "Show live output" off: say so, so the host stops sending
        if (run.show_live_output === false) return reply.send({ ok: true, enabled: false });
        const channelId = run.channel_id.trim();
        const sessionId = run.session_id.trim();
        const { seq, events } = applyBatch(runId, { channelId, sessionId, threadId: run.thread_id?.trim() ?? null, profile: run.profile_name }, body.events);
        if (events.length) {
            request.pendingEvents ??= [];
            request.pendingEvents.push({ room: `channel:${channelId}`, event: 'AgentRunStream', data: {
                channelId, sessionId, runId, threadId: run.thread_id?.trim() ?? null, profile: run.profile_name, seq, events } });
        }
        return reply.send({ ok: true, enabled: true });
    });

    // POST /agent-hosts/@me/runs/:runId/tool-requests → 200 { id, status }
    // A running Codex turn holds one approval request until its card is decided (#93)
    app.post('/agent-hosts/@me/runs/:runId/tool-requests', {
        schema: { body: { type: 'object', required: ['claimToken', 'tool', 'requestKey', 'waitSeconds'], additionalProperties: false, properties: {
            ...claimBody,
            tool: { type: 'string', maxLength: 310, pattern: TOOL_RULE },
            // The host's hash of thread, turn, item and request id: binds the card to one request
            requestKey: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            waitSeconds: { type: 'integer', minimum: LIVE_WAIT_MIN_SECONDS, maximum: LIVE_WAIT_MAX_SECONDS },
            // The whole command the card shows (the host declines a longer one rather than truncate it)
            detail: { type: ['string', 'null'], maxLength: MAX_DETAIL },
            cwd: { type: ['string', 'null'], maxLength: 4096 },
        } } },
    }, async (request, reply) => {
        await releaseRequestClient(request);
        const notices: Notice[] = [];
        const { runId } = request.params as any;
        const r = await openToolRequest(app.db, request.agentHost!, runId, request.body as any, notices);
        queueNotices(request, notices);
        return reply.status(r.status).send(r.body);
    });

    // POST /agent-hosts/@me/runs/:runId/tool-requests/:requestId → 200 { status }
    // Poll a live request's decision; `close` ends the wait (timeout, request resolved, run stopping)
    app.post('/agent-hosts/@me/runs/:runId/tool-requests/:requestId', {
        schema: {
            params: { type: 'object', properties: { runId: { type: 'string' }, requestId: { type: 'string', minLength: 26, maxLength: 26 } } },
            body: { type: 'object', required: ['claimToken'], additionalProperties: false, properties: {
                ...claimBody, close: { type: 'string', enum: ['timeout', 'resolved', 'stopped'] },
            } },
        },
    }, async (request, reply) => {
        await releaseRequestClient(request);
        const notices: Notice[] = [];
        const { runId, requestId } = request.params as any;
        const r = await liveToolRequest(app.db, request.agentHost!, runId, requestId, request.body as any, notices);
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
                    tokensUsed: { type: ['integer', 'null'], minimum: 0, maximum: 9007199254740991 },
                    // Same limit as agora-host's result parser
                    summary: { type: ['string', 'null'], maxLength: 16000 },
                    branch: { type: 'string', pattern: '^agora/[a-z0-9][a-z0-9_-]{0,31}/[0-9A-HJKMNP-TV-Z]{26}$' },
                    baseSha: { type: 'string', pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$' },
                    headSha: { type: 'string', pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$' },
                    changedPaths: { type: 'array', maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 4096 } },
                    deniedTools: deniedToolsSchema,
                    checkpoint: checkpointSchema,
                    verification: verificationSchema,
                },
            },
        },
    }, async (request, reply) => {
        await releaseRequestClient(request);
        const notices: Notice[] = [];
        const { runId } = request.params as any;
        const r = await complete(app.db, request.agentHost!, runId, request.body as any, notices);
        queueNotices(request, notices);
        if (r.status === 200) await endStream(request, app.db, runId);
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
                    tokensUsed: { type: ['integer', 'null'], minimum: 0, maximum: 9007199254740991 },
                    retryable: { type: 'boolean' },
                    changedPaths: { type: 'array', maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 4096 } },
                    deniedTools: deniedToolsSchema,
                    checkpoint: checkpointSchema,
                    verification: verificationSchema,
                    // error 'rate_limited': the session sleeps until resetAt (#87)
                    rateLimit: { type: 'object', additionalProperties: false, properties: { resetAt: { type: ['string', 'null'], maxLength: 40 } } },
                },
            },
        },
    }, async (request, reply) => {
        await releaseRequestClient(request);
        const notices: Notice[] = [];
        const { runId } = request.params as any;
        const r = await fail(app.db, request.agentHost!, runId, request.body as any, notices);
        queueNotices(request, notices);
        if (r.status === 200) await endStream(request, app.db, runId);
        return reply.status(r.status).send(r.body);
    });
}

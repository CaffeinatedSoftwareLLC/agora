import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { isServerOwner } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';

/**
 * ChatGPT plan connections for 'siwc' profiles (docs/codex-chatgpt-plan.md).
 *
 * Sign in with ChatGPT runs on the agent host, the machine of the person whose plan is used:
 * the host opens that machine's browser and receives the OAuth callback on 127.0.0.1. Its
 * tokens never leave the host. Agora only keeps the connection's state, so Settings → Agents
 * can show it, and the person a profile is bound to (agent_profiles.plan_owner_id), so only
 * they can wake it (src/lib/provider-terms.ts).
 *
 * - Settings → Agents asks the host to connect (or disconnect) a profile. Only the server owner
 *   or the person who registered the host may: the browser opens on that host, and whoever
 *   asks becomes the plan owner, so nobody else may start a sign-in there.
 * - The host picks the request up, runs the sign-in, and reports the result. A sign-in started
 *   on the host itself (`agora-host siwc login`) reports the same way; with no request open,
 *   the profile keeps its plan owner, or gets the host's registrant.
 */

const ID = { type: 'string', minLength: 26, maxLength: 26 } as const;
const NAME = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]*$', minLength: 1, maxLength: 32 } as const;

function planJson(r: any) {
    return {
        profileId: r.profile_id.trim(), status: r.status, accountLabel: r.account_label ?? null, error: r.error ?? null,
        requestedAt: r.requested_at ?? null, updatedAt: r.updated_at, planOwnerId: r.plan_owner_id?.trim() ?? null,
    };
}

const PLAN_SELECT = `SELECT c.*, p.plan_owner_id FROM agent_plan_connections c JOIN agent_profiles p ON p.id = c.profile_id`;

async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const { serverId } = request.params as any;
    if (!request.userId || request.isBot || !await isServerOwner(request.dbClient!, serverId, request.userId)) {
        reply.status(403).send({ error: 'forbidden' });
        return null;
    }
    return serverId;
}

export async function agentPlanRoutes(app: FastifyInstance) {
    // GET /servers/:serverId/agent-plans → 200 [plan]
    app.get('/servers/:serverId/agent-plans', async (request, reply) => {
        const serverId = await requireOwner(request, reply);
        if (!serverId) return reply;
        const db = request.dbClient!;
        const rows = await asService(db, () => db.query(`${PLAN_SELECT} WHERE c.server_id = $1 ORDER BY c.profile_id`, [serverId]));
        return reply.send(rows.rows.map(planJson));
    });

    // POST /servers/:serverId/agent-profiles/:profileId/plan { action } → 200 plan
    // Ask the profile's host to start Sign in with ChatGPT (connect) or sign out (disconnect).
    app.post('/servers/:serverId/agent-profiles/:profileId/plan', {
        schema: {
            params: { type: 'object', properties: { serverId: ID, profileId: ID } },
            body: { type: 'object', required: ['action'], additionalProperties: false,
                properties: { action: { type: 'string', enum: ['connect', 'disconnect'] } } },
        },
    }, async (request, reply) => {
        const { serverId, profileId } = request.params as any;
        const userId = request.userId;
        if (!userId || request.isBot) return reply.status(403).send({ error: 'forbidden' });
        const db = request.dbClient!;
        const action = (request.body as any).action as 'connect' | 'disconnect';
        const result = await asService(db, async () => {
            const profile = await db.query(
                `SELECT p.id, p.adapter, h.created_by AS host_creator, srv.owner_id
                 FROM agent_profiles p JOIN agent_hosts h ON h.id = p.host_id JOIN servers srv ON srv.id = p.server_id
                 WHERE p.id = $1 AND p.server_id = $2 AND h.revoked_at IS NULL FOR UPDATE OF p`,
                [profileId, serverId]
            );
            const p = profile.rows[0];
            if (!p) return { status: 404, body: { error: 'unknown_profile' } };
            const member = await db.query(`SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`, [serverId, userId]);
            const allowed = member.rows.length > 0 && (p.owner_id?.trim() === userId || p.host_creator?.trim() === userId);
            if (!allowed) return { status: 403, body: { error: 'Only the server owner or the person who registered this host can connect a ChatGPT plan on it' } };
            if (p.adapter !== 'codex') return { status: 400, body: { error: 'siwc_codex_only' } };
            const status = action === 'connect' ? 'requested' : 'disconnect_requested';
            await db.query(
                `INSERT INTO agent_plan_connections (profile_id, server_id, status, requested_by, requested_at, error, updated_at)
                 VALUES ($1, $2, $3, $4, NOW(), NULL, NOW())
                 ON CONFLICT (profile_id) DO UPDATE SET status = $3, requested_by = $4, requested_at = NOW(), error = NULL, updated_at = NOW()`,
                [profileId, serverId, status, userId]
            );
            const row = await db.query(`${PLAN_SELECT} WHERE c.profile_id = $1`, [profileId]);
            return { status: 200, body: planJson(row.rows[0]) };
        });
        return reply.status(result.status).send(result.body);
    });

    // ─── Host routes (AgentHost token) ───

    // GET /agent-hosts/@me/plan-requests/next → 200 { profile, action, requestedBy } | 204
    app.get('/agent-hosts/@me/plan-requests/next', async (request, reply) => {
        const host = request.agentHost!, db = request.dbClient!;
        const row = await db.query(
            `SELECT c.profile_id, c.status, c.requested_by, p.name FROM agent_plan_connections c
             JOIN agent_profiles p ON p.id = c.profile_id
             WHERE p.host_id = $1 AND p.server_id = $2 AND c.status IN ('requested', 'disconnect_requested')
             ORDER BY c.requested_at LIMIT 1 FOR UPDATE OF c SKIP LOCKED`,
            [host.id, host.serverId]
        );
        const r = row.rows[0];
        if (!r) return reply.status(204).send();
        await db.query(`UPDATE agent_plan_connections SET status = 'in_progress', updated_at = NOW() WHERE profile_id = $1`, [r.profile_id]);
        return reply.send({ profile: r.name, action: r.status === 'requested' ? 'connect' : 'disconnect', requestedBy: r.requested_by?.trim() ?? null });
    });

    // POST /agent-hosts/@me/plans/:name { status, error?, accountLabel? } → 200 { planOwnerId }
    // The host's sign-in state for one profile: after a request, a CLI sign-in, or at start.
    app.post('/agent-hosts/@me/plans/:name', {
        schema: {
            params: { type: 'object', properties: { name: NAME } },
            body: { type: 'object', required: ['status'], additionalProperties: false, properties: {
                status: { type: 'string', enum: ['in_progress', 'connected', 'scope_missing', 'failed', 'disconnected'] },
                error: { type: ['string', 'null'], pattern: '^[a-z][a-z0-9_]{0,63}$' },
                accountLabel: { type: ['string', 'null'], maxLength: 320 },
            } },
        },
    }, async (request, reply) => {
        const host = request.agentHost!, db = request.dbClient!;
        const { name } = request.params as any;
        const body = request.body as { status: string; error?: string | null; accountLabel?: string | null };
        const profile = await db.query(
            `SELECT p.id, p.plan_owner_id, h.created_by AS host_creator FROM agent_profiles p JOIN agent_hosts h ON h.id = p.host_id
             WHERE p.host_id = $1 AND p.server_id = $2 AND p.name = $3 AND p.adapter = 'codex' FOR UPDATE OF p`,
            [host.id, host.serverId, name]
        );
        const p = profile.rows[0];
        if (!p) return reply.status(404).send({ error: 'unknown_profile' });
        const current = (await db.query(`SELECT status, requested_by FROM agent_plan_connections WHERE profile_id = $1 FOR UPDATE`, [p.id])).rows[0];
        // A request the host hasn't picked up yet wins over a report from the host's start or CLI
        if (current && (current.status === 'requested' || current.status === 'disconnect_requested') && body.status !== 'in_progress') {
            return reply.send({ planOwnerId: p.plan_owner_id?.trim() ?? null });
        }

        let planOwnerId: string | null = p.plan_owner_id?.trim() ?? null;
        if (body.status === 'connected' || body.status === 'scope_missing') {
            // Whoever asked from Settings; otherwise keep the binding, or the host's registrant
            const requester = current?.status === 'in_progress' ? current.requested_by?.trim() ?? null : null;
            planOwnerId = requester ?? planOwnerId ?? p.host_creator?.trim() ?? null;
        } else if (body.status === 'disconnected') {
            planOwnerId = null;
        }
        if (planOwnerId !== (p.plan_owner_id?.trim() ?? null)) {
            await db.query(`UPDATE agent_profiles SET plan_owner_id = $2, updated_at = NOW() WHERE id = $1`, [p.id, planOwnerId]);
        }
        const keepRequest = body.status === 'in_progress';
        await db.query(
            `INSERT INTO agent_plan_connections (profile_id, server_id, status, account_label, error, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (profile_id) DO UPDATE SET status = $3, account_label = COALESCE($4, CASE WHEN $3 = 'disconnected' THEN NULL ELSE agent_plan_connections.account_label END),
                 error = $5, updated_at = NOW(), requested_by = CASE WHEN $6 THEN agent_plan_connections.requested_by ELSE NULL END`,
            [p.id, host.serverId, body.status, body.accountLabel ?? null, body.error ?? null, keepRequest]
        );
        return reply.send({ planOwnerId });
    });
}

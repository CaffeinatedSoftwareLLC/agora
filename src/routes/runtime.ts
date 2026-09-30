import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CAPABILITIES, type Capability } from '../ai/adapters';
import { Permissions } from '../permissions';
import { loadAndComputePermissions, requireManageBots } from './bots';
import { checkChannelMembership } from './shared';
import { MAX_CODE_BYTES } from '../runtime/container-spec';
import { submitRun, reviewRun, codeRetentionDays, codeExpiresAt } from '../runtime/service';

/**
 * Sandboxed runtime API (WBS 3.5). Bots submit runs; members with Manage Bots (or
 * Administrator) approve or deny them in the thread; bot owners configure access.
 */

const limitProps = Object.fromEntries(
    ['cpus', 'memoryMb', 'pidsLimit', 'wallClockMs', 'scratchMb', 'outputBytes', 'capabilityCalls', 'artifacts']
        .map(k => [k, { type: 'number', exclusiveMinimum: 0 }]),
);

async function loadRun(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const pool = request.server.db;
    const run = (await pool.query('SELECT * FROM exec_runs WHERE id = $1', [id])).rows[0];
    if (!run) return reply.status(404).send({ error: 'Run not found' });

    const userId = request.userId!.trim();
    const isSubmitter = run.submitted_by?.trim() === userId;
    // Humans: must be able to see the channel the run belongs to
    const canSee = isSubmitter || (!request.isBot && run.channel_id
        && await checkChannelMembership(request.dbClient!, run.channel_id.trim(), userId, false));
    if (!canSee) return reply.status(404).send({ error: 'Run not found' });
    (request as any).execRun = run;
}

async function runDto(request: FastifyRequest, run: any) {
    const retention = await codeRetentionDays(request.server.db);
    const expires = run.code_pruned_at ? null : codeExpiresAt(run.created_at, retention);
    const trim = (v: string | null) => v?.trim() ?? null;
    return {
        id: run.id.trim(),
        serverId: run.server_id.trim(),
        channelId: trim(run.channel_id),
        threadId: trim(run.thread_id),
        submittedBy: trim(run.submitted_by),
        status: run.status,
        capabilities: run.requested_capabilities,
        timeProfile: run.time_profile,
        limits: run.limits,
        gate: { decision: run.gate_decision, reason: run.gate_reason, source: run.gate_source },
        approvedBy: trim(run.approved_by),
        exitCode: run.exit_code,
        error: run.error,
        stdout: run.stdout_tail,
        stderr: run.stderr_tail,
        capabilityCalls: run.capability_calls,
        artifacts: run.artifact_count,
        createdAt: run.created_at,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        codeSha256: run.code_sha256,
        codeExpiresAt: expires?.toISOString() ?? null,
        codePrunedAt: run.code_pruned_at,
    };
}

export async function runtimeRoutes(app: FastifyInstance) {

    // POST /runtime/runs — bots submit code (spec: bots only in v1)
    app.post('/runtime/runs', {
        schema: {
            body: {
                type: 'object',
                required: ['code', 'channelId'],
                additionalProperties: false,
                properties: {
                    code: { type: 'string', minLength: 1, maxLength: MAX_CODE_BYTES },
                    channelId: { type: 'string', minLength: 26, maxLength: 26 },
                    threadId: { type: 'string', minLength: 26, maxLength: 26 },
                    capabilities: { type: 'array', maxItems: CAPABILITIES.length, items: { type: 'string', enum: [...CAPABILITIES] } },
                    limits: { type: 'object', additionalProperties: false, properties: limitProps },
                },
            },
        },
    }, async (request, reply) => {
        if (!request.isBot) return reply.status(403).send({ error: 'Only bots can submit code in this version' });
        const body = request.body as { code: string; channelId: string; threadId?: string; capabilities?: Capability[]; limits?: Record<string, number> };
        const botId = request.userId!.trim();
        const pool = request.server.db;

        const channel = (await pool.query('SELECT server_id FROM channels WHERE id = $1', [body.channelId])).rows[0];
        if (!channel?.server_id) return reply.status(404).send({ error: 'Channel not found' });
        const access = await pool.query('SELECT 1 FROM bot_channel_access WHERE bot_id = $1 AND channel_id = $2', [botId, body.channelId]);
        if (access.rows.length === 0) return reply.status(403).send({ error: 'Bot does not have access to this channel' });
        if (body.threadId) {
            const parent = await pool.query(
                'SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL AND deleted_at IS NULL',
                [body.threadId, body.channelId]
            );
            if (parent.rows.length === 0) return reply.status(404).send({ error: 'Thread not found in this channel' });
        }

        const result = await submitRun(pool, {
            serverId: channel.server_id.trim(),
            channelId: body.channelId,
            threadId: body.threadId ?? null,
            submitterId: botId,
            code: body.code,
            capabilities: body.capabilities ?? [],
            limits: body.limits,
        });
        return reply.status(result.status === 'denied' ? 403 : 202).send(result);
    });

    // GET /runtime/runs/:id — submitter bot, or a member who can see the run's channel
    app.get('/runtime/runs/:id', { preHandler: loadRun }, async (request, reply) => {
        return reply.send(await runDto(request, (request as any).execRun));
    });

    // GET /runtime/runs/:id/code — download the code until retention prunes it
    app.get('/runtime/runs/:id/code', { preHandler: loadRun }, async (request, reply) => {
        const run = (request as any).execRun;
        if (run.code === null) return reply.status(410).send({ error: 'Code for this run was deleted by the retention policy', prunedAt: run.code_pruned_at });
        return reply
            .header('Content-Type', 'text/plain; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="run-${run.id.trim()}.ts"`)
            .header('X-Content-Type-Options', 'nosniff')
            .send(run.code);
    });

    // POST /runtime/runs/:id/approve | /deny — humans with Manage Bots or Administrator
    for (const action of ['approve', 'deny'] as const) {
        app.post(`/runtime/runs/:id/${action}`, { preHandler: loadRun }, async (request, reply) => {
            if (request.isBot) return reply.status(403).send({ error: 'Bots cannot review runs' });
            const run = (request as any).execRun;
            const perms = await loadAndComputePermissions(request.dbClient!, request.userId!, run.server_id.trim());
            if (!(perms & Permissions.ManageBots) && !(perms & Permissions.Administrator)) {
                return reply.status(403).send({ error: 'Missing Manage Bots permission' });
            }
            const result = await reviewRun(request.server.db, run.id.trim(), request.userId!, action === 'approve');
            if (!result.ok) return reply.status(result.status).send({ error: result.error });
            return reply.send({ id: run.id.trim(), status: result.status });
        });
    }

    // PATCH /servers/:serverId/bots/:id/runtime — per-bot sandbox access
    app.patch('/servers/:serverId/bots/:id/runtime', {
        preHandler: [requireManageBots],
        schema: {
            body: {
                type: 'object', required: ['access'], additionalProperties: false,
                properties: { access: { type: 'string', enum: ['none', 'approval', 'auto'] } },
            },
        },
    }, async (request, reply) => {
        const { serverId, id: botId } = request.params as { serverId: string; id: string };
        const { access } = request.body as { access: 'none' | 'approval' | 'auto' };
        const db = request.dbClient!;
        const res = await db.query(
            'UPDATE users SET runtime_access = $1 WHERE id = $2 AND bot = true AND server_id = $3 RETURNING id, runtime_access',
            [access, botId, serverId]
        );
        if (res.rows.length === 0) return reply.status(404).send({ error: 'Bot not found in this server' });
        await db.query(
            `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
             VALUES ($1, $2, $3, 'bot_runtime_access', 'bot', $4, $5)`,
            [(await import('../utils/ulid')).generateUlid(), serverId, request.userId, botId, JSON.stringify({ access })]
        );
        return reply.send({ id: res.rows[0].id.trim(), runtimeAccess: res.rows[0].runtime_access });
    });
}

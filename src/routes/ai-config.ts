import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { loadAndComputePermissions } from './bots';
import { Permissions } from '../permissions';
import { encryptString } from '../lib/encryption';
import { testConnection } from '../ai/providers';
import { getAdapter, LEGACY_PROVIDER_ADAPTER } from '../ai/adapters';
import { config } from '../config';
import { auditAiChange, changedFields, routeSnapshot } from '../lib/ai-audit';

/**
 * Built-in assistant config. The assistant's provider/model come from the server's
 * `chat` capability route (see ai-providers.ts); these endpoints remain as a
 * one-call setup path: PUT upserts a provider + chat route + assistant bot.
 */

// Accepted `provider` values: adapter IDs plus the legacy "claude"
const PROVIDER_ENUM = ['claude', 'anthropic', 'openai', 'gemini'];
// Adapter → legacy name returned to existing clients
const LEGACY_NAME: Record<string, string> = { anthropic: 'claude' };

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
    if (request.isBot) {
        return reply.status(403).send({ error: 'Bots cannot manage AI config' });
    }
    const { serverId } = request.params as any;
    const userId = request.userId;
    const db = request.dbClient!;

    const member = await db.query(
        'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    );
    if (member.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this server' });
    }

    const perms = await loadAndComputePermissions(db, userId, serverId);
    if (!(perms & Permissions.Administrator)) {
        return reply.status(403).send({ error: 'Missing Administrator permission' });
    }
}

function toAdapterId(provider: string): string {
    return LEGACY_PROVIDER_ADAPTER[provider] ?? provider;
}

type EnsureResult = { ok: true; botId: string } | { ok: false; error: string };

/**
 * Create (or update) the assistant settings row and its bot user. Idempotent:
 * an existing bot is reused; a missing one (deleted) is recreated.
 */
async function ensureAssistant(
    db: any,
    serverId: string,
    ownerId: string,
    settings: { systemPrompt?: string | null; maxContext?: number },
): Promise<EnsureResult> {
    const existing = await db.query('SELECT bot_id FROM ai_provider_config WHERE server_id = $1', [serverId]);

    if (existing.rows.length > 0 && existing.rows[0].bot_id) {
        const botId = existing.rows[0].bot_id.trim();
        if (settings.systemPrompt !== undefined || settings.maxContext !== undefined) {
            await db.query(
                `UPDATE ai_provider_config
                 SET system_prompt = COALESCE($1, system_prompt), max_context = COALESCE($2, max_context), updated_at = NOW()
                 WHERE server_id = $3`,
                [settings.systemPrompt ?? null, settings.maxContext ?? null, serverId]
            );
        }
        return { ok: true, botId };
    }

    const botId = generateUlid();
    let botUsername = 'AI-Assistant';
    for (let attempt = 1; ; attempt++) {
        try {
            await db.query('SAVEPOINT create_bot');
            await db.query(
                `INSERT INTO users (id, username, bot, bot_owner_id, server_id)
                 VALUES ($1, $2, true, $3, $4)`,
                [botId, botUsername, ownerId, serverId]
            );
            await db.query('RELEASE SAVEPOINT create_bot');
            break;
        } catch (err: any) {
            await db.query('ROLLBACK TO SAVEPOINT create_bot');
            if (err.code !== '23505') throw err;
            if (attempt >= 5) return { ok: false, error: 'Could not create AI bot user — username conflicts' };
            botUsername = `AI-Assistant-${attempt + 1}`;
        }
    }

    await db.query(
        `INSERT INTO ai_provider_config (server_id, bot_id, system_prompt, max_context)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (server_id) DO UPDATE
            SET bot_id = EXCLUDED.bot_id,
                system_prompt = COALESCE(EXCLUDED.system_prompt, ai_provider_config.system_prompt),
                max_context = EXCLUDED.max_context,
                updated_at = NOW()`,
        [serverId, botId, settings.systemPrompt ?? null, settings.maxContext ?? 20]
    );
    return { ok: true, botId };
}

export async function aiConfigRoutes(app: FastifyInstance) {

    // GET /servers/:serverId/ai-config
    app.get('/servers/:serverId/ai-config', {
        preHandler: [requireAdmin],
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;

        const result = await db.query(
            `SELECT c.bot_id, c.system_prompt, c.max_context, c.enabled, c.created_at, c.updated_at,
                    r.model, r.provider_id, p.adapter
             FROM ai_provider_config c
             LEFT JOIN ai_capability_routes r ON r.server_id = c.server_id AND r.capability = 'chat'
             LEFT JOIN ai_providers p ON p.id = r.provider_id
             WHERE c.server_id = $1`,
            [serverId]
        );

        if (result.rows.length === 0) {
            return reply.status(200).send({ configured: false });
        }

        const row = result.rows[0];
        return reply.status(200).send({
            configured: true,
            provider: row.adapter ? (LEGACY_NAME[row.adapter] ?? row.adapter) : null,
            adapter: row.adapter ?? null,
            providerId: row.provider_id?.trim() || null,
            model: row.model ?? null,
            botId: row.bot_id?.trim() || null,
            systemPrompt: row.system_prompt || null,
            maxContext: row.max_context,
            enabled: row.enabled,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    });

    // PUT /servers/:serverId/ai-config — upsert provider + chat route + assistant bot
    app.put('/servers/:serverId/ai-config', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                required: ['provider', 'model', 'apiKey'],
                properties: {
                    provider: { type: 'string', enum: PROVIDER_ENUM },
                    model: { type: 'string', minLength: 1, maxLength: 100 },
                    apiKey: { type: 'string', minLength: 1 },
                    systemPrompt: { type: ['string', 'null'] },
                    maxContext: { type: 'integer', minimum: 1, maximum: 100 },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;
        const { provider, model, apiKey, systemPrompt, maxContext } = request.body as any;
        const adapterId = toAdapterId(provider);
        const adapter = getAdapter(adapterId)!;

        const { encrypted, iv, authTag } = encryptString(apiKey, config.encryptionKey);

        // Reuse the provider behind the current chat route if it's the same adapter;
        // otherwise create a new provider (existing ones stay available)
        const currentRoute = await db.query(
            `SELECT r.provider_id, p.adapter FROM ai_capability_routes r
             JOIN ai_providers p ON p.id = r.provider_id
             WHERE r.server_id = $1 AND r.capability = 'chat'`,
            [serverId]
        );
        let providerId: string;
        if (currentRoute.rows[0]?.adapter === adapterId) {
            providerId = currentRoute.rows[0].provider_id.trim();
            await db.query(
                `UPDATE ai_providers SET api_key_enc = $1, api_key_iv = $2, api_key_tag = $3, enabled = true, updated_at = NOW()
                 WHERE id = $4`,
                [encrypted, iv, authTag, providerId]
            );
        } else {
            providerId = generateUlid();
            const taken = await db.query('SELECT label FROM ai_providers WHERE server_id = $1', [serverId]);
            const labels = new Set(taken.rows.map((r: any) => r.label));
            let label = adapter.label;
            for (let n = 2; labels.has(label); n++) label = `${adapter.label} ${n}`;
            await db.query(
                `INSERT INTO ai_providers (id, server_id, adapter, label, api_key_enc, api_key_iv, api_key_tag)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [providerId, serverId, adapterId, label, encrypted, iv, authTag]
            );
        }

        const previousChat = await db.query(
            `SELECT r.*, p.label FROM ai_capability_routes r JOIN ai_providers p ON p.id = r.provider_id
             WHERE r.server_id = $1 AND r.capability = 'chat'`,
            [serverId]
        );
        await db.query(
            `INSERT INTO ai_capability_routes (server_id, capability, provider_id, model, enabled)
             VALUES ($1, 'chat', $2, $3, true)
             ON CONFLICT (server_id, capability) DO UPDATE
                SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model, enabled = true, updated_at = NOW()`,
            [serverId, providerId, model]
        );

        const nextChat = await db.query(
            `SELECT r.*, p.label FROM ai_capability_routes r JOIN ai_providers p ON p.id = r.provider_id
             WHERE r.server_id = $1 AND r.capability = 'chat'`,
            [serverId]
        );
        const before = routeSnapshot(previousChat.rows[0]);
        const after = routeSnapshot(nextChat.rows[0]);
        await auditAiChange(db, request, {
            serverId, action: 'ai_route_update', targetType: 'ai_route', targetId: providerId,
            changes: { capability: 'chat', before, after, changed: changedFields(before, after), apiKey: 'replaced', via: 'assistant setup' },
        });

        // Assistant settings + bot user
        const assistant = await ensureAssistant(db, serverId, userId, { systemPrompt: systemPrompt || null, maxContext: maxContext || 20 });
        if (!assistant.ok) return reply.status(409).send({ error: assistant.error });
        const botId = assistant.botId;

        return reply.status(200).send({
            configured: true,
            provider: LEGACY_NAME[adapterId] ?? adapterId,
            adapter: adapterId,
            providerId,
            model,
            botId,
            systemPrompt: systemPrompt || null,
            maxContext: maxContext || 20,
            enabled: true,
        });
    });

    // PATCH /servers/:serverId/ai-config — assistant settings (enabled, prompt, context size)
    app.patch('/servers/:serverId/ai-config', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                minProperties: 1,
                additionalProperties: false,
                properties: {
                    enabled: { type: 'boolean' },
                    systemPrompt: { type: ['string', 'null'], maxLength: 20000 },
                    maxContext: { type: 'integer', minimum: 1, maximum: 100 },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const body = request.body as any;

        const sets: string[] = [];
        const params: unknown[] = [];
        const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
        if (body.enabled !== undefined) set('enabled', body.enabled);
        if (body.systemPrompt !== undefined) set('system_prompt', body.systemPrompt || null);
        if (body.maxContext !== undefined) set('max_context', body.maxContext);
        params.push(serverId);

        const result = await db.query(
            `UPDATE ai_provider_config SET ${sets.join(', ')}, updated_at = NOW() WHERE server_id = $${params.length}
             RETURNING enabled, system_prompt, max_context`,
            params
        );

        if (result.rows.length === 0) {
            return reply.status(404).send({ error: 'AI config not found' });
        }

        const row = result.rows[0];
        await auditAiChange(db, request, {
            serverId, action: 'ai_assistant_update', targetType: 'ai_assistant', targetId: null,
            changes: {
                ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
                ...(body.maxContext !== undefined ? { maxContext: body.maxContext } : {}),
                // The prompt itself can be long; record that it changed and its size
                ...(body.systemPrompt !== undefined ? { systemPrompt: { length: (body.systemPrompt || '').length } } : {}),
            },
        });
        return reply.status(200).send({ enabled: row.enabled, systemPrompt: row.system_prompt, maxContext: row.max_context });
    });

    // POST /servers/:serverId/ai-config/assistant — create the assistant bot (no key needed;
    // it answers through the server's chat route). Idempotent.
    app.post('/servers/:serverId/ai-config/assistant', {
        preHandler: [requireAdmin],
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const result = await ensureAssistant(db, serverId, request.userId, {});
        if (!result.ok) return reply.status(409).send({ error: result.error });
        return reply.status(200).send({ botId: result.botId });
    });

    // POST /servers/:serverId/ai-config/test — test unsaved credentials
    app.post('/servers/:serverId/ai-config/test', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                required: ['provider', 'model', 'apiKey'],
                properties: {
                    provider: { type: 'string', enum: PROVIDER_ENUM },
                    model: { type: 'string', minLength: 1, maxLength: 100 },
                    apiKey: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const { provider, model, apiKey } = request.body as any;

        const result = await testConnection({ provider: toAdapterId(provider), model, apiKey });
        return reply.status(200).send(result);
    });

    // GET /servers/:serverId/ai-config/usage
    app.get('/servers/:serverId/ai-config/usage', {
        preHandler: [requireAdmin],
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const days = Math.max(1, Math.min(365, parseInt((request.query as any).days || '30', 10) || 30));

        const result = await db.query(
            `SELECT
                COUNT(*)::int AS total_requests,
                COALESCE(SUM(input_tokens), 0)::int AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0)::int AS total_output_tokens,
                COALESCE(AVG(latency_ms), 0)::int AS avg_latency_ms,
                COUNT(CASE WHEN error IS NOT NULL THEN 1 END)::int AS error_count
             FROM ai_usage_events
             WHERE server_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
            [serverId, days]
        );

        return reply.status(200).send(result.rows[0]);
    });
}

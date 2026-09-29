import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { loadAndComputePermissions } from './bots';
import { Permissions } from '../permissions';
import { encryptString } from '../lib/encryption';
import { testConnection } from '../ai/providers';
import { getAdapter, LEGACY_PROVIDER_ADAPTER } from '../ai/adapters';
import { config } from '../config';

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

        await db.query(
            `INSERT INTO ai_capability_routes (server_id, capability, provider_id, model, enabled)
             VALUES ($1, 'chat', $2, $3, true)
             ON CONFLICT (server_id, capability) DO UPDATE
                SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model, enabled = true, updated_at = NOW()`,
            [serverId, providerId, model]
        );

        // Assistant settings + bot user
        const existing = await db.query(
            'SELECT bot_id FROM ai_provider_config WHERE server_id = $1',
            [serverId]
        );

        let botId: string;

        if (existing.rows.length > 0 && existing.rows[0].bot_id) {
            botId = existing.rows[0].bot_id.trim();
            await db.query(
                `UPDATE ai_provider_config
                 SET system_prompt = $1, max_context = $2, updated_at = NOW()
                 WHERE server_id = $3`,
                [systemPrompt || null, maxContext || 20, serverId]
            );
        } else {
            // Auto-create bot user
            botId = generateUlid();
            let botUsername = 'AI-Assistant';
            let attempts = 0;

            while (attempts < 5) {
                try {
                    await db.query('SAVEPOINT create_bot');
                    await db.query(
                        `INSERT INTO users (id, username, bot, bot_owner_id, server_id)
                         VALUES ($1, $2, true, $3, $4)`,
                        [botId, botUsername, userId, serverId]
                    );
                    await db.query('RELEASE SAVEPOINT create_bot');
                    break;
                } catch (err: any) {
                    await db.query('ROLLBACK TO SAVEPOINT create_bot');
                    if (err.code === '23505') {
                        attempts++;
                        botUsername = `AI-Assistant-${attempts + 1}`;
                        if (attempts >= 5) {
                            return reply.status(409).send({ error: 'Could not create AI bot user — username conflicts' });
                        }
                    } else {
                        throw err;
                    }
                }
            }

            if (existing.rows.length > 0) {
                // Row exists but bot_id was null (bot deleted) — attach the new bot
                await db.query(
                    `UPDATE ai_provider_config
                     SET bot_id = $1, system_prompt = $2, max_context = $3, updated_at = NOW()
                     WHERE server_id = $4`,
                    [botId, systemPrompt || null, maxContext || 20, serverId]
                );
            } else {
                await db.query(
                    `INSERT INTO ai_provider_config (server_id, bot_id, system_prompt, max_context)
                     VALUES ($1, $2, $3, $4)`,
                    [serverId, botId, systemPrompt || null, maxContext || 20]
                );
            }
        }

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

    // PATCH /servers/:serverId/ai-config — enable/disable the assistant
    app.patch('/servers/:serverId/ai-config', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                required: ['enabled'],
                properties: {
                    enabled: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const { enabled } = request.body as any;

        const result = await db.query(
            'UPDATE ai_provider_config SET enabled = $1, updated_at = NOW() WHERE server_id = $2 RETURNING enabled',
            [enabled, serverId]
        );

        if (result.rows.length === 0) {
            return reply.status(404).send({ error: 'AI config not found' });
        }

        return reply.status(200).send({ enabled: result.rows[0].enabled });
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

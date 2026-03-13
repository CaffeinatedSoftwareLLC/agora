import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { loadAndComputePermissions } from './bots';
import { Permissions } from '../permissions';
import { encryptString } from '../lib/encryption';
import { testConnection } from '../ai/providers';
import { config } from '../config';

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
    if ((request as any).isBot) {
        return reply.status(403).send({ error: 'Bots cannot manage AI config' });
    }
    const { serverId } = request.params as any;
    const userId = (request as any).userId;
    const db = (request as any).dbClient;

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

export async function aiConfigRoutes(app: FastifyInstance) {

    // GET /servers/:serverId/ai-config
    app.get('/servers/:serverId/ai-config', {
        preHandler: [requireAdmin],
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = (request as any).dbClient;

        const result = await db.query(
            'SELECT provider, model, bot_id, system_prompt, max_context, enabled, created_at, updated_at FROM ai_provider_config WHERE server_id = $1',
            [serverId]
        );

        if (result.rows.length === 0) {
            return reply.status(200).send({ configured: false });
        }

        const row = result.rows[0];
        return reply.status(200).send({
            configured: true,
            provider: row.provider,
            model: row.model,
            botId: row.bot_id?.trim() || null,
            systemPrompt: row.system_prompt || null,
            maxContext: row.max_context,
            enabled: row.enabled,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    });

    // PUT /servers/:serverId/ai-config
    app.put('/servers/:serverId/ai-config', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                required: ['provider', 'model', 'apiKey'],
                properties: {
                    provider: { type: 'string', enum: ['claude', 'openai'] },
                    model: { type: 'string', minLength: 1, maxLength: 100 },
                    apiKey: { type: 'string', minLength: 1 },
                    systemPrompt: { type: ['string', 'null'] },
                    maxContext: { type: 'integer', minimum: 1, maximum: 100 },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const userId = (request as any).userId;
        const db = (request as any).dbClient;
        const { provider, model, apiKey, systemPrompt, maxContext } = request.body as any;

        const { encrypted, iv, authTag } = encryptString(apiKey, config.encryptionKey);

        // Check if config already exists
        const existing = await db.query(
            'SELECT bot_id FROM ai_provider_config WHERE server_id = $1',
            [serverId]
        );

        let botId: string;

        if (existing.rows.length > 0 && existing.rows[0].bot_id) {
            // Update existing
            botId = existing.rows[0].bot_id.trim();
            await db.query(
                `UPDATE ai_provider_config
                 SET provider = $1, model = $2, api_key_enc = $3, api_key_iv = $4, api_key_tag = $5,
                     system_prompt = $6, max_context = $7, updated_at = NOW()
                 WHERE server_id = $8`,
                [provider, model, encrypted, iv, authTag, systemPrompt || null, maxContext || 20, serverId]
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
                // Row exists but bot_id was null (shouldn't normally happen, but handle it)
                await db.query(
                    `UPDATE ai_provider_config
                     SET provider = $1, model = $2, api_key_enc = $3, api_key_iv = $4, api_key_tag = $5,
                         bot_id = $6, system_prompt = $7, max_context = $8, updated_at = NOW()
                     WHERE server_id = $9`,
                    [provider, model, encrypted, iv, authTag, botId, systemPrompt || null, maxContext || 20, serverId]
                );
            } else {
                await db.query(
                    `INSERT INTO ai_provider_config (server_id, provider, model, api_key_enc, api_key_iv, api_key_tag, bot_id, system_prompt, max_context)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [serverId, provider, model, encrypted, iv, authTag, botId, systemPrompt || null, maxContext || 20]
                );
            }
        }

        return reply.status(200).send({
            configured: true,
            provider,
            model,
            botId,
            systemPrompt: systemPrompt || null,
            maxContext: maxContext || 20,
            enabled: true,
        });
    });

    // PATCH /servers/:serverId/ai-config
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
        const db = (request as any).dbClient;
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

    // POST /servers/:serverId/ai-config/test
    app.post('/servers/:serverId/ai-config/test', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                required: ['provider', 'model', 'apiKey'],
                properties: {
                    provider: { type: 'string', enum: ['claude', 'openai'] },
                    model: { type: 'string', minLength: 1, maxLength: 100 },
                    apiKey: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        const { provider, model, apiKey } = request.body as any;

        const result = await testConnection({ provider, model, apiKey });
        return reply.status(200).send(result);
    });

    // GET /servers/:serverId/ai-config/usage
    app.get('/servers/:serverId/ai-config/usage', {
        preHandler: [requireAdmin],
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = (request as any).dbClient;
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

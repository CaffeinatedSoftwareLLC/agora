import { FastifyInstance, FastifyRequest } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { encryptString } from '../lib/encryption';
import { config } from '../config';
import { generateBotToken } from '../auth/bot-tokens';
import { usernameTaken } from '../lib/usernames';
import { getAdapter } from '../ai/adapters';
import { MODEL_AGENT_TOOLS } from '../ai/model-agent-tools';
import { auditAiChange, changedFields } from '../lib/ai-audit';
import { requireAdmin } from './ai-config';

/**
 * Model agents (docs/model-agents.md): named bots with their own provider and model,
 * run on the server by src/ai/model-agent-handler.ts. Server admins only, like the
 * rest of AI settings. Creating an agent creates its bot user and a bot token the
 * server keeps (encrypted) to act as the bot; deleting the agent deletes the bot.
 */

const ULID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' };
const nullableInt = (minimum: number) => ({ type: ['integer', 'null'], minimum });

/** A bot name that @mentions resolve (mention parsing matches @[\w-]+). */
const NAME = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' };

const settingsProps = {
    providerId: ULID,
    model: { type: 'string', minLength: 1, maxLength: 200 },
    systemPrompt: { type: ['string', 'null'], maxLength: 8000 },
    tools: { type: 'array', maxItems: MODEL_AGENT_TOOLS.length, uniqueItems: true, items: { type: 'string', enum: [...MODEL_AGENT_TOOLS] } },
    maxSteps: { type: 'integer', minimum: 1, maximum: 20 },
    maxOutputTokens: { type: 'integer', minimum: 64, maximum: 32000 },
    dailyRequestLimit: nullableInt(1),
    dailyTokenLimit: nullableInt(1),
    dailyCostLimitMicros: nullableInt(1),
    inputPriceMicrosPerMtok: nullableInt(0),
    outputPriceMicrosPerMtok: nullableInt(0),
} as const;

const COLUMNS: Record<string, string> = {
    providerId: 'provider_id', model: 'model', systemPrompt: 'system_prompt', tools: 'tools',
    maxSteps: 'max_steps', maxOutputTokens: 'max_output_tokens',
    dailyRequestLimit: 'daily_request_limit', dailyTokenLimit: 'daily_token_limit', dailyCostLimitMicros: 'daily_cost_limit_micros',
    inputPriceMicrosPerMtok: 'input_price_micros_per_mtok', outputPriceMicrosPerMtok: 'output_price_micros_per_mtok',
    enabled: 'enabled',
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const AGENT_SELECT = `SELECT a.*, u.username, u.bot_paused_at, u.runtime_access, p.label AS provider_label, p.adapter,
        (SELECT COUNT(*) FROM bot_channel_access b WHERE b.bot_id = a.bot_id)::int AS channel_count,
        t.requests_today, t.tokens_today, t.cost_today
    FROM model_agents a
    JOIN users u ON u.id = a.bot_id
    JOIN ai_providers p ON p.id = a.provider_id
    LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS requests_today, COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens_today,
               SUM(cost_micros)::bigint AS cost_today
        FROM ai_usage_events e
        WHERE e.model_agent_id = a.id AND e.created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    ) t ON true`;

function agentDto(row: any) {
    return {
        id: row.id.trim(),
        botId: row.bot_id.trim(),
        name: row.username,
        providerId: row.provider_id.trim(),
        providerLabel: row.provider_label,
        adapter: row.adapter,
        model: row.model,
        systemPrompt: row.system_prompt ?? null,
        tools: row.tools ?? [],
        maxSteps: row.max_steps,
        maxOutputTokens: row.max_output_tokens,
        dailyRequestLimit: num(row.daily_request_limit),
        dailyTokenLimit: num(row.daily_token_limit),
        dailyCostLimitMicros: num(row.daily_cost_limit_micros),
        inputPriceMicrosPerMtok: num(row.input_price_micros_per_mtok),
        outputPriceMicrosPerMtok: num(row.output_price_micros_per_mtok),
        enabled: row.enabled,
        runtimeAccess: row.runtime_access,
        channelCount: row.channel_count ?? 0,
        today: { requests: row.requests_today ?? 0, tokens: Number(row.tokens_today ?? 0), costMicros: num(row.cost_today) },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** What the audit log keeps: settings, never the token. */
function agentSnapshot(row: any) {
    if (!row) return null;
    const { id, botId, name, providerId, model, tools, maxSteps, maxOutputTokens, dailyRequestLimit, dailyTokenLimit,
        dailyCostLimitMicros, inputPriceMicrosPerMtok, outputPriceMicrosPerMtok, enabled, systemPrompt } = agentDto(row);
    return { id, botId, name, providerId, model, tools, maxSteps, maxOutputTokens, dailyRequestLimit, dailyTokenLimit,
        dailyCostLimitMicros, inputPriceMicrosPerMtok, outputPriceMicrosPerMtok, enabled, hasSystemPrompt: !!systemPrompt };
}

async function loadAgent(db: any, serverId: string, agentId: string) {
    return (await db.query(`${AGENT_SELECT} WHERE a.id = $1 AND a.server_id = $2`, [agentId, serverId])).rows[0];
}

/** The provider must be in this server and its adapter must do function calling. */
async function providerError(db: any, serverId: string, providerId: string): Promise<{ status: number; error: string } | null> {
    const res = await db.query('SELECT adapter FROM ai_providers WHERE id = $1 AND server_id = $2', [providerId, serverId]);
    if (res.rows.length === 0) return { status: 404, error: 'Provider not found' };
    const adapter = getAdapter(res.rows[0].adapter);
    if (!adapter?.chatWithTools) {
        return { status: 400, error: `${adapter?.label ?? res.rows[0].adapter} can't run model agents; use an OpenAI-compatible provider (OpenAI, OpenRouter, Ollama, ...)` };
    }
    return null;
}

/** Code runs only through the approval gate: an agent with runtime_exec starts at "approval", never "auto". */
async function syncRuntimeAccess(db: any, botId: string, tools: string[]) {
    if (tools.includes('runtime_exec')) {
        await db.query("UPDATE users SET runtime_access = 'approval' WHERE id = $1 AND runtime_access = 'none'", [botId]);
    } else {
        await db.query("UPDATE users SET runtime_access = 'none' WHERE id = $1", [botId]);
    }
}

export async function modelAgentRoutes(app: FastifyInstance) {
    const params = { type: 'object', properties: { serverId: { type: 'string' }, agentId: ULID } };

    // GET /servers/:serverId/ai/agents → the server's model agents, with today's usage
    app.get('/servers/:serverId/ai/agents', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId } = request.params as { serverId: string };
        const db = request.dbClient!;
        const rows = await db.query(`${AGENT_SELECT} WHERE a.server_id = $1 ORDER BY a.created_at`, [serverId]);
        return reply.send(rows.rows.map(agentDto));
    });

    // POST /servers/:serverId/ai/agents → create the agent and its bot
    app.post('/servers/:serverId/ai/agents', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                required: ['name', 'providerId', 'model'],
                additionalProperties: false,
                properties: {
                    name: NAME,
                    ...settingsProps,
                    // Channels to add the bot to now (more can be added later like any bot)
                    channelIds: { type: 'array', maxItems: 50, uniqueItems: true, items: ULID },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as { serverId: string };
        const b = request.body as any;
        const db = request.dbClient!;

        const bad = await providerError(db, serverId, b.providerId);
        if (bad) return reply.status(bad.status).send({ error: bad.error });
        if (b.channelIds?.length) {
            const found = await db.query('SELECT id FROM channels WHERE id = ANY($1) AND server_id = $2', [b.channelIds, serverId]);
            if (found.rows.length !== b.channelIds.length) return reply.status(400).send({ error: 'Every channel must be in this server' });
        }
        if (await usernameTaken(db, b.name)) return reply.status(409).send({ error: 'username_taken' });

        const botId = generateUlid();
        try {
            await db.query('SAVEPOINT create_agent_bot');
            await db.query(
                'INSERT INTO users (id, username, bot, bot_owner_id, server_id) VALUES ($1, $2, true, $3, $4)',
                [botId, b.name, request.userId, serverId]
            );
            await db.query('RELEASE SAVEPOINT create_agent_bot');
        } catch (err: any) {
            await db.query('ROLLBACK TO SAVEPOINT create_agent_bot');
            if (err.code === '23505') return reply.status(409).send({ error: 'username_taken' });
            throw err;
        }

        const { tokenId, secretHash, raw } = await generateBotToken();
        await db.query('INSERT INTO bot_tokens (id, bot_id, secret_hash, name) VALUES ($1, $2, $3, $4)', [tokenId, botId, secretHash, 'model agent (server)']);
        const token = encryptString(raw, config.encryptionKey);
        const tools: string[] = b.tools ?? [];
        const id = generateUlid();
        await db.query(
            `INSERT INTO model_agents (id, server_id, bot_id, provider_id, model, system_prompt, tools, max_steps, max_output_tokens,
                 daily_request_limit, daily_token_limit, daily_cost_limit_micros, input_price_micros_per_mtok, output_price_micros_per_mtok,
                 token_id, token_enc, token_iv, token_tag, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
            [id, serverId, botId, b.providerId, b.model, b.systemPrompt ?? null, tools, b.maxSteps ?? 6, b.maxOutputTokens ?? 2048,
             b.dailyRequestLimit ?? null, b.dailyTokenLimit ?? null, b.dailyCostLimitMicros ?? null,
             b.inputPriceMicrosPerMtok ?? null, b.outputPriceMicrosPerMtok ?? null,
             tokenId, token.encrypted, token.iv, token.authTag, request.userId]
        );
        await syncRuntimeAccess(db, botId, tools);
        for (const channelId of b.channelIds ?? []) {
            await db.query('INSERT INTO bot_channel_access (bot_id, channel_id, granted_by) VALUES ($1, $2, $3)', [botId, channelId, request.userId]);
        }

        const row = await loadAgent(db, serverId, id);
        await auditAiChange(db, request, {
            serverId, action: 'ai_agent_create', targetType: 'ai_agent', targetId: id,
            changes: { after: agentSnapshot(row), channels: b.channelIds ?? [] },
        });
        return reply.status(201).send(agentDto(row));
    });

    // PATCH /servers/:serverId/ai/agents/:agentId → settings; enabled=false pauses the bot
    app.patch('/servers/:serverId/ai/agents/:agentId', {
        preHandler: [requireAdmin],
        schema: {
            params,
            body: {
                type: 'object',
                minProperties: 1,
                additionalProperties: false,
                properties: { ...settingsProps, enabled: { type: 'boolean' } },
            },
        },
    }, async (request, reply) => {
        const { serverId, agentId } = request.params as { serverId: string; agentId: string };
        const b = request.body as Record<string, unknown>;
        const db = request.dbClient!;

        const before = await loadAgent(db, serverId, agentId);
        if (!before) return reply.status(404).send({ error: 'Agent not found' });
        if (b.providerId !== undefined) {
            const bad = await providerError(db, serverId, b.providerId as string);
            if (bad) return reply.status(bad.status).send({ error: bad.error });
        }

        const sets: string[] = [];
        const values: unknown[] = [];
        for (const [key, column] of Object.entries(COLUMNS)) {
            if (b[key] === undefined) continue;
            values.push(b[key]);
            sets.push(`${column} = $${values.length}`);
        }
        values.push(agentId);
        await db.query(`UPDATE model_agents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`, values);
        const botId = before.bot_id.trim();
        if (b.tools !== undefined) await syncRuntimeAccess(db, botId, b.tools as string[]);
        if (b.enabled !== undefined) {
            // A paused bot can't post or call tools (src/auth/middleware.ts), so pausing the agent pauses its bot
            await db.query(
                `UPDATE users SET bot_paused_at = CASE WHEN $1::boolean THEN NULL ELSE COALESCE(bot_paused_at, NOW()) END,
                                  bot_paused_reason = CASE WHEN $1::boolean THEN NULL ELSE 'Model agent paused in AI settings' END
                 WHERE id = $2`,
                [b.enabled, botId]
            );
        }

        const after = await loadAgent(db, serverId, agentId);
        const snapBefore = agentSnapshot(before);
        const snapAfter = agentSnapshot(after);
        const changed = changedFields(snapBefore, snapAfter);
        if (changed.length > 0) {
            await auditAiChange(db, request, {
                serverId, action: 'ai_agent_update', targetType: 'ai_agent', targetId: agentId,
                changes: { before: snapBefore, after: snapAfter, changed },
            });
        }
        return reply.send(agentDto(after));
    });

    // DELETE /servers/:serverId/ai/agents/:agentId → removes the agent and its bot (tokens and channel access with it)
    app.delete('/servers/:serverId/ai/agents/:agentId', { preHandler: [requireAdmin], schema: { params } }, async (request: FastifyRequest, reply) => {
        const { serverId, agentId } = request.params as { serverId: string; agentId: string };
        const db = request.dbClient!;
        const row = await loadAgent(db, serverId, agentId);
        if (!row) return reply.status(404).send({ error: 'Agent not found' });
        await db.query('DELETE FROM users WHERE id = $1 AND bot = true AND server_id = $2', [row.bot_id, serverId]);
        await auditAiChange(db, request, {
            serverId, action: 'ai_agent_delete', targetType: 'ai_agent', targetId: agentId,
            changes: { before: agentSnapshot(row) },
        });
        return reply.send({ deleted: true });
    });
}

import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { encryptString } from '../lib/encryption';
import { checkBaseUrl } from '../lib/url-guard';
import { config } from '../config';
import { requireAdmin } from './ai-config';
import { CAPABILITIES, adapterIds, getAdapter, listAdapters, type Capability } from '../ai/adapters';
import { allowPrivateBaseUrls, decryptProviderKey } from '../ai/routing';
import { auditAiChange, changedFields, providerSnapshot, recentAiChanges, routeSnapshot } from '../lib/ai-audit';

const nullableInt = (minimum: number) => ({ type: ['integer', 'null'], minimum });

function providerDto(row: any) {
    return {
        id: row.id.trim(),
        adapter: row.adapter,
        label: row.label,
        baseUrl: row.base_url ?? null,
        hasApiKey: !!row.api_key_enc,
        enabled: row.enabled,
        capabilities: row.capabilities ?? [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

const toNum = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function routeDto(row: any) {
    return {
        capability: row.capability,
        providerId: row.provider_id.trim(),
        providerLabel: row.label,
        adapter: row.adapter,
        model: row.model,
        enabled: row.enabled,
        dailyRequestLimit: toNum(row.daily_request_limit),
        dailyTokenLimit: toNum(row.daily_token_limit),
        dailyCostLimitMicros: toNum(row.daily_cost_limit_micros),
        inputPriceMicrosPerMtok: toNum(row.input_price_micros_per_mtok),
        outputPriceMicrosPerMtok: toNum(row.output_price_micros_per_mtok),
        updatedAt: row.updated_at,
    };
}

async function validateBaseUrl(db: any, adapterId: string, baseUrl: string | null | undefined): Promise<string | null> {
    if (baseUrl === undefined || baseUrl === null || baseUrl === '') return null;
    const adapter = getAdapter(adapterId)!;
    if (!adapter.supportsBaseUrl) return `${adapter.label} does not accept a custom base URL`;
    const check = await checkBaseUrl(baseUrl, { allowPrivate: await allowPrivateBaseUrls(db) });
    return check.ok ? null : check.error;
}

export async function aiProviderRoutes(app: FastifyInstance) {

    // GET /servers/:serverId/ai/adapters → available adapter types and their capabilities
    app.get('/servers/:serverId/ai/adapters', { preHandler: [requireAdmin] }, async (_request, reply) => {
        return reply.send(listAdapters());
    });

    // ─── Providers ───

    app.get('/servers/:serverId/ai/providers', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const result = await db.query(
            `SELECT p.*, COALESCE(array_agg(r.capability ORDER BY r.capability) FILTER (WHERE r.capability IS NOT NULL), '{}') AS capabilities
             FROM ai_providers p
             LEFT JOIN ai_capability_routes r ON r.provider_id = p.id
             WHERE p.server_id = $1
             GROUP BY p.id
             ORDER BY p.created_at`,
            [serverId]
        );
        return reply.send(result.rows.map(providerDto));
    });

    app.post('/servers/:serverId/ai/providers', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                required: ['adapter'],
                additionalProperties: false,
                properties: {
                    adapter: { type: 'string', enum: adapterIds() },
                    label: { type: 'string', minLength: 1, maxLength: 100 },
                    apiKey: { type: 'string', minLength: 1, maxLength: 4096 },
                    baseUrl: { type: ['string', 'null'], maxLength: 2048 },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const { adapter: adapterId, label, apiKey, baseUrl } = request.body as any;
        const db = request.dbClient!;
        const adapter = getAdapter(adapterId)!;

        if (adapter.requiresApiKey && !apiKey) {
            return reply.status(400).send({ error: `${adapter.label} requires an API key` });
        }
        const urlError = await validateBaseUrl(db, adapterId, baseUrl);
        if (urlError) return reply.status(400).send({ error: urlError });

        const key = apiKey ? encryptString(apiKey, config.encryptionKey) : null;
        const id = generateUlid();
        try {
            await db.query('SAVEPOINT create_provider');
            const result = await db.query(
                `INSERT INTO ai_providers (id, server_id, adapter, label, base_url, api_key_enc, api_key_iv, api_key_tag)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [id, serverId, adapterId, label ?? adapter.label, baseUrl || null,
                 key?.encrypted ?? null, key?.iv ?? null, key?.authTag ?? null]
            );
            await db.query('RELEASE SAVEPOINT create_provider');
            await auditAiChange(db, request, {
                serverId, action: 'ai_provider_create', targetType: 'ai_provider', targetId: id,
                changes: { after: providerSnapshot(result.rows[0]) },
            });
            return reply.status(201).send(providerDto(result.rows[0]));
        } catch (err: any) {
            await db.query('ROLLBACK TO SAVEPOINT create_provider');
            if (err.code === '23505') return reply.status(409).send({ error: 'A provider with this label already exists' });
            throw err;
        }
    });

    app.patch('/servers/:serverId/ai/providers/:providerId', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                minProperties: 1,
                additionalProperties: false,
                properties: {
                    label: { type: 'string', minLength: 1, maxLength: 100 },
                    apiKey: { type: ['string', 'null'], maxLength: 4096 },
                    baseUrl: { type: ['string', 'null'], maxLength: 2048 },
                    enabled: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId, providerId } = request.params as any;
        const body = request.body as any;
        const db = request.dbClient!;

        const existing = await db.query('SELECT * FROM ai_providers WHERE id = $1 AND server_id = $2', [providerId, serverId]);
        if (existing.rows.length === 0) return reply.status(404).send({ error: 'Provider not found' });
        const current = existing.rows[0];
        const adapter = getAdapter(current.adapter);

        if (body.baseUrl !== undefined) {
            const urlError = await validateBaseUrl(db, current.adapter, body.baseUrl);
            if (urlError) return reply.status(400).send({ error: urlError });
        }
        if (body.apiKey !== undefined && !body.apiKey && adapter?.requiresApiKey) {
            return reply.status(400).send({ error: `${adapter.label} requires an API key` });
        }

        const sets: string[] = [];
        const params: unknown[] = [];
        const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
        if (body.label !== undefined) set('label', body.label);
        if (body.enabled !== undefined) set('enabled', body.enabled);
        if (body.baseUrl !== undefined) set('base_url', body.baseUrl || null);
        if (body.apiKey !== undefined) {
            const key = body.apiKey ? encryptString(body.apiKey, config.encryptionKey) : null;
            set('api_key_enc', key?.encrypted ?? null);
            set('api_key_iv', key?.iv ?? null);
            set('api_key_tag', key?.authTag ?? null);
        }
        params.push(providerId);

        try {
            await db.query('SAVEPOINT update_provider');
            const result = await db.query(
                `UPDATE ai_providers SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
                params
            );
            await db.query('RELEASE SAVEPOINT update_provider');
            const before = providerSnapshot(current);
            const after = providerSnapshot(result.rows[0]);
            await auditAiChange(db, request, {
                serverId, action: 'ai_provider_update', targetType: 'ai_provider', targetId: providerId,
                changes: {
                    before, after, changed: changedFields(before, after),
                    ...(body.apiKey !== undefined ? { apiKey: body.apiKey ? 'replaced' : 'removed' } : {}),
                },
            });
            return reply.send(providerDto(result.rows[0]));
        } catch (err: any) {
            await db.query('ROLLBACK TO SAVEPOINT update_provider');
            if (err.code === '23505') return reply.status(409).send({ error: 'A provider with this label already exists' });
            throw err;
        }
    });

    app.delete('/servers/:serverId/ai/providers/:providerId', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId, providerId } = request.params as any;
        const db = request.dbClient!;
        const routes = await db.query('SELECT capability FROM ai_capability_routes WHERE provider_id = $1 ORDER BY capability', [providerId]);
        // Routes pointing at this provider cascade away
        const result = await db.query('DELETE FROM ai_providers WHERE id = $1 AND server_id = $2 RETURNING *', [providerId, serverId]);
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Provider not found' });
        await auditAiChange(db, request, {
            serverId, action: 'ai_provider_delete', targetType: 'ai_provider', targetId: providerId,
            changes: { before: providerSnapshot(result.rows[0]), routesRemoved: routes.rows.map((r: any) => r.capability) },
        });
        return reply.send({ deleted: true });
    });

    // POST /servers/:serverId/ai/providers/:providerId/test → check stored credentials against a model
    app.post('/servers/:serverId/ai/providers/:providerId/test', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                additionalProperties: false,
                properties: { model: { type: 'string', minLength: 1, maxLength: 100 } },
            },
        },
    }, async (request, reply) => {
        const { serverId, providerId } = request.params as any;
        const { model } = (request.body as any) ?? {};
        const db = request.dbClient!;

        const existing = await db.query('SELECT * FROM ai_providers WHERE id = $1 AND server_id = $2', [providerId, serverId]);
        if (existing.rows.length === 0) return reply.status(404).send({ error: 'Provider not found' });
        const row = existing.rows[0];
        const adapter = getAdapter(row.adapter);
        if (!adapter) return reply.send({ ok: false, error: `Unknown adapter "${row.adapter}"` });

        const testModel = model ?? adapter.defaultModels.chat ?? Object.values(adapter.defaultModels)[0];
        if (!testModel) return reply.status(400).send({ error: 'model is required for this provider' });
        if (row.base_url) {
            const urlError = await validateBaseUrl(db, row.adapter, row.base_url);
            if (urlError) return reply.send({ ok: false, error: urlError });
        }

        let apiKey: string | undefined;
        try {
            apiKey = decryptProviderKey(row);
        } catch {
            return reply.send({ ok: false, error: 'Stored API key could not be decrypted' });
        }
        return reply.send(await adapter.testConnection({ apiKey, baseUrl: row.base_url || undefined }, testModel));
    });

    // ─── Capability routes ───

    app.get('/servers/:serverId/ai/routes', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const result = await db.query(
            `SELECT r.*, p.label, p.adapter
             FROM ai_capability_routes r JOIN ai_providers p ON p.id = r.provider_id
             WHERE r.server_id = $1
             ORDER BY r.capability`,
            [serverId]
        );
        return reply.send(result.rows.map(routeDto));
    });

    app.put('/servers/:serverId/ai/routes/:capability', {
        preHandler: [requireAdmin],
        schema: {
            params: {
                type: 'object',
                properties: {
                    serverId: { type: 'string' },
                    capability: { type: 'string', enum: [...CAPABILITIES] },
                },
            },
            body: {
                type: 'object',
                required: ['providerId', 'model'],
                additionalProperties: false,
                properties: {
                    providerId: { type: 'string', minLength: 26, maxLength: 26 },
                    model: { type: 'string', minLength: 1, maxLength: 100 },
                    enabled: { type: 'boolean' },
                    dailyRequestLimit: nullableInt(1),
                    dailyTokenLimit: nullableInt(1),
                    dailyCostLimitMicros: nullableInt(1),
                    inputPriceMicrosPerMtok: nullableInt(0),
                    outputPriceMicrosPerMtok: nullableInt(0),
                },
            },
        },
    }, async (request, reply) => {
        const { serverId, capability } = request.params as { serverId: string; capability: Capability };
        const b = request.body as any;
        const db = request.dbClient!;

        const provider = await db.query('SELECT adapter FROM ai_providers WHERE id = $1 AND server_id = $2', [b.providerId, serverId]);
        if (provider.rows.length === 0) return reply.status(404).send({ error: 'Provider not found' });
        const adapter = getAdapter(provider.rows[0].adapter);
        if (!adapter?.capabilities.includes(capability)) {
            return reply.status(400).send({ error: `${adapter?.label ?? provider.rows[0].adapter} does not support "${capability}"` });
        }
        // Some adapters take a fixed set of "models" (Tavily: search depths); reject others before a run hits them
        const choices = adapter.modelChoices?.[capability];
        if (choices && !choices.includes(b.model)) {
            return reply.status(400).send({ error: `For ${adapter.label}, the ${capability} model must be one of: ${choices.join(', ')}` });
        }

        const previous = await db.query(
            `SELECT r.*, p.label FROM ai_capability_routes r JOIN ai_providers p ON p.id = r.provider_id
             WHERE r.server_id = $1 AND r.capability = $2`,
            [serverId, capability]
        );

        // Chat is on by default; anything that can spend money beyond chat is opt-in
        const enabled = b.enabled ?? (capability === 'chat');
        await db.query(
            `INSERT INTO ai_capability_routes (server_id, capability, provider_id, model, enabled,
                 daily_request_limit, daily_token_limit, daily_cost_limit_micros,
                 input_price_micros_per_mtok, output_price_micros_per_mtok)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (server_id, capability) DO UPDATE SET
                 provider_id = EXCLUDED.provider_id, model = EXCLUDED.model, enabled = EXCLUDED.enabled,
                 daily_request_limit = EXCLUDED.daily_request_limit, daily_token_limit = EXCLUDED.daily_token_limit,
                 daily_cost_limit_micros = EXCLUDED.daily_cost_limit_micros,
                 input_price_micros_per_mtok = EXCLUDED.input_price_micros_per_mtok,
                 output_price_micros_per_mtok = EXCLUDED.output_price_micros_per_mtok,
                 updated_at = NOW()`,
            [serverId, capability, b.providerId, b.model, enabled,
             b.dailyRequestLimit ?? null, b.dailyTokenLimit ?? null, b.dailyCostLimitMicros ?? null,
             b.inputPriceMicrosPerMtok ?? null, b.outputPriceMicrosPerMtok ?? null]
        );

        const result = await db.query(
            `SELECT r.*, p.label, p.adapter FROM ai_capability_routes r JOIN ai_providers p ON p.id = r.provider_id
             WHERE r.server_id = $1 AND r.capability = $2`,
            [serverId, capability]
        );
        const before = routeSnapshot(previous.rows[0]);
        const after = routeSnapshot(result.rows[0]);
        const changed = changedFields(before, after);
        if (changed.length > 0) {
            await auditAiChange(db, request, {
                serverId, action: 'ai_route_update', targetType: 'ai_route', targetId: b.providerId,
                changes: { capability, before, after, changed },
            });
        }
        return reply.send(routeDto(result.rows[0]));
    });

    app.delete('/servers/:serverId/ai/routes/:capability', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId, capability } = request.params as any;
        const db = request.dbClient!;
        const previous = await db.query(
            `SELECT r.*, p.label FROM ai_capability_routes r JOIN ai_providers p ON p.id = r.provider_id
             WHERE r.server_id = $1 AND r.capability = $2`,
            [serverId, capability]
        );
        const result = await db.query(
            'DELETE FROM ai_capability_routes WHERE server_id = $1 AND capability = $2 RETURNING capability',
            [serverId, capability]
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'Route not found' });
        await auditAiChange(db, request, {
            serverId, action: 'ai_route_delete', targetType: 'ai_route', targetId: previous.rows[0]?.provider_id?.trim() ?? null,
            changes: { capability, before: routeSnapshot(previous.rows[0]) },
        });
        return reply.send({ deleted: true });
    });

    // GET /servers/:serverId/ai/changes → recent AI-settings changes (audit trail)
    app.get('/servers/:serverId/ai/changes', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId } = request.params as any;
        const limit = Math.max(1, Math.min(200, parseInt((request.query as any).limit || '50', 10) || 50));
        return reply.send(await recentAiChanges(request.dbClient!, serverId, limit));
    });

    // GET /servers/:serverId/ai/usage?days=N → per-capability totals, plus today's totals for budgets
    app.get('/servers/:serverId/ai/usage', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const days = Math.max(1, Math.min(365, parseInt((request.query as any).days || '30', 10) || 30));

        const result = await db.query(
            `SELECT capability,
                    COUNT(*)::int AS requests,
                    COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
                    COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                    SUM(cost_micros)::bigint AS cost_micros,
                    COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
                    COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS requests_today,
                    COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)::bigint AS tokens_today,
                    SUM(cost_micros) FILTER (WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::bigint AS cost_micros_today
             FROM ai_usage_events
             WHERE server_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
             GROUP BY capability
             ORDER BY capability`,
            [serverId, days]
        );
        return reply.send({
            days,
            capabilities: result.rows.map((r: any) => ({
                capability: r.capability,
                requests: r.requests,
                inputTokens: Number(r.input_tokens),
                outputTokens: Number(r.output_tokens),
                costMicros: toNum(r.cost_micros),
                errors: r.errors,
                today: { requests: r.requests_today, tokens: Number(r.tokens_today), costMicros: toNum(r.cost_micros_today) },
            })),
        });
    });
}

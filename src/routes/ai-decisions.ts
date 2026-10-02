import { FastifyInstance } from 'fastify';
import { requireAdmin } from './ai-config';
import { auditAiChange, changedFields } from '../lib/ai-audit';
import { DECISION_USES, USE_COLUMN, decisionSettingsFromRow, type DecisionSettings, type DecisionUse } from '../ai/decide';

/**
 * Decision model settings (docs/planning/jev-wbs.md, J0.3): one switch, budget share
 * and request cap per use, plus thresholds. The model itself is an ordinary provider
 * with a `decide` capability route (ai-providers.ts); nothing here holds a key.
 */

const probability = { type: 'number', minimum: 0, maximum: 1 };
const useSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        enabled: { type: 'boolean' },
        sharePct: { type: 'integer', minimum: 0, maximum: 100 },
        dailyRequests: { type: ['integer', 'null'], minimum: 1 },
    },
};

/** Flat snapshot for the audit trail and for diffing. */
function snapshot(s: DecisionSettings): Record<string, unknown> {
    const flat: Record<string, unknown> = {
        routingMinConfidence: s.routingMinConfidence,
        screeningFlagThreshold: s.screeningFlagThreshold,
        screeningSuspectThreshold: s.screeningSuspectThreshold,
        screeningStrict: s.screeningStrict,
        tagThreshold: s.tagThreshold,
    };
    for (const use of DECISION_USES) {
        flat[`${use}.enabled`] = s.uses[use].enabled;
        flat[`${use}.sharePct`] = s.uses[use].sharePct;
        flat[`${use}.dailyRequests`] = s.uses[use].dailyRequests;
    }
    return flat;
}

async function view(db: any, serverId: string, settings: DecisionSettings) {
    const routes = await db.query(
        `SELECT r.capability, r.enabled, r.model, p.label, p.adapter, p.enabled AS provider_enabled
         FROM ai_capability_routes r JOIN ai_providers p ON p.id = r.provider_id
         WHERE r.server_id = $1 AND r.capability IN ('decide', 'search')`,
        [serverId]
    );
    const decideRoute = routes.rows.find((r: any) => r.capability === 'decide');
    const searchRoute = routes.rows.find((r: any) => r.capability === 'search');

    const usage = await db.query(
        `SELECT decision_use, COUNT(*)::int AS requests, COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
                COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors
         FROM ai_usage_events
         WHERE server_id = $1 AND capability = 'decide' AND decision_use IS NOT NULL
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
         GROUP BY decision_use`,
        [serverId]
    );
    const today: Record<string, { requests: number; tokens: number; errors: number }> = {};
    for (const use of DECISION_USES) today[use] = { requests: 0, tokens: 0, errors: 0 };
    for (const r of usage.rows) today[r.decision_use] = { requests: r.requests, tokens: Number(r.tokens), errors: r.errors };

    const warnings: string[] = [];
    // Google's grounding terms forbid sending grounded results to another model, so they cannot be screened
    if (settings.uses.search_screening.enabled && settings.screeningStrict && searchRoute?.adapter === 'gemini') {
        warnings.push('Strict screening is on and search uses Gemini grounding, whose results cannot be screened: every search will be refused. Use Tavily for search, or turn strict screening off.');
    }
    if (DECISION_USES.some(use => settings.uses[use].enabled) && !(decideRoute?.enabled && decideRoute?.provider_enabled)) {
        warnings.push('A decision use is switched on, but no decision model is configured and enabled. Nothing is being decided.');
    }

    return {
        ...settings,
        route: decideRoute
            ? { configured: true, enabled: decideRoute.enabled && decideRoute.provider_enabled, provider: decideRoute.label, adapter: decideRoute.adapter, model: decideRoute.model }
            : { configured: false, enabled: false, provider: null, adapter: null, model: null },
        today,
        warnings,
    };
}

export async function aiDecisionRoutes(app: FastifyInstance) {

    // GET /servers/:serverId/ai/decisions → settings, the decide route's state, today's usage per use
    app.get('/servers/:serverId/ai/decisions', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        const row = await db.query('SELECT * FROM ai_decision_settings WHERE server_id = $1', [serverId]);
        return reply.send(await view(db, serverId, decisionSettingsFromRow(row.rows[0])));
    });

    // PATCH /servers/:serverId/ai/decisions → change any subset (the row is created on first write)
    app.patch('/servers/:serverId/ai/decisions', {
        preHandler: [requireAdmin],
        schema: {
            body: {
                type: 'object',
                minProperties: 1,
                additionalProperties: false,
                properties: {
                    uses: {
                        type: 'object',
                        minProperties: 1,
                        additionalProperties: false,
                        properties: Object.fromEntries(DECISION_USES.map(use => [use, useSchema])),
                    },
                    routingMinConfidence: probability,
                    screeningFlagThreshold: probability,
                    screeningSuspectThreshold: probability,
                    screeningStrict: { type: 'boolean' },
                    tagThreshold: probability,
                },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const body = request.body as any;
        const db = request.dbClient!;

        await db.query('INSERT INTO ai_decision_settings (server_id) VALUES ($1) ON CONFLICT DO NOTHING', [serverId]);
        const current = await db.query('SELECT * FROM ai_decision_settings WHERE server_id = $1 FOR UPDATE', [serverId]);
        const before = decisionSettingsFromRow(current.rows[0]);

        const sets: string[] = [];
        const params: unknown[] = [];
        const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

        const next: DecisionSettings = structuredClone(before);
        for (const use of DECISION_USES) {
            const change = body.uses?.[use as DecisionUse];
            if (!change) continue;
            const prefix = USE_COLUMN[use];
            if (change.enabled !== undefined) { set(`${prefix}_enabled`, change.enabled); next.uses[use].enabled = change.enabled; }
            if (change.sharePct !== undefined) { set(`${prefix}_share_pct`, change.sharePct); next.uses[use].sharePct = change.sharePct; }
            if (change.dailyRequests !== undefined) { set(`${prefix}_daily_requests`, change.dailyRequests); next.uses[use].dailyRequests = change.dailyRequests; }
        }
        const scalar: [keyof DecisionSettings, string][] = [
            ['routingMinConfidence', 'routing_min_confidence'],
            ['screeningFlagThreshold', 'screening_flag_threshold'],
            ['screeningSuspectThreshold', 'screening_suspect_threshold'],
            ['screeningStrict', 'screening_strict'],
            ['tagThreshold', 'tag_threshold'],
        ];
        for (const [key, col] of scalar) {
            if (body[key] !== undefined) { set(col, body[key]); (next as any)[key] = body[key]; }
        }

        // Unknown fields are stripped by validation, which can leave nothing to change
        if (sets.length === 0) return reply.status(400).send({ error: 'No recognised settings to change' });

        const shares = DECISION_USES.reduce((sum, use) => sum + next.uses[use].sharePct, 0);
        if (shares > 100) return reply.status(400).send({ error: `Budget shares add up to ${shares}%; they must total 100% or less` });
        if (next.screeningSuspectThreshold > next.screeningFlagThreshold) {
            return reply.status(400).send({ error: 'The suspect threshold must not be above the flag threshold' });
        }

        params.push(serverId);
        const updated = await db.query(
            `UPDATE ai_decision_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE server_id = $${params.length} RETURNING *`,
            params
        );
        const after = decisionSettingsFromRow(updated.rows[0]);

        const changed = changedFields(snapshot(before), snapshot(after));
        if (changed.length > 0) {
            const b = snapshot(before);
            const a = snapshot(after);
            await auditAiChange(db, request, {
                serverId, action: 'ai_decision_update', targetType: 'ai_decision', targetId: null,
                changes: {
                    before: Object.fromEntries(changed.map(k => [k, b[k]])),
                    after: Object.fromEntries(changed.map(k => [k, a[k]])),
                    changed,
                },
            });
        }
        return reply.send(await view(db, serverId, after));
    });
}

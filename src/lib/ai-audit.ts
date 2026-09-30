import type { FastifyRequest } from 'fastify';
import { generateUlid } from '../utils/ulid';

/**
 * Audit trail for server AI settings (providers, capability routes, the assistant).
 * These control spending, so every write records who made it, from which client,
 * and what changed. Key material is never recorded, only "replaced"/"removed".
 */

interface Queryable {
    query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export type AiAuditAction =
    | 'ai_provider_create' | 'ai_provider_update' | 'ai_provider_delete'
    | 'ai_route_update' | 'ai_route_delete'
    | 'ai_assistant_update';

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** The fields of a capability route worth auditing (joined with its provider's label). */
export function routeSnapshot(row: any) {
    if (!row) return null;
    return {
        providerId: row.provider_id.trim(),
        provider: row.label ?? null,
        model: row.model,
        enabled: row.enabled,
        dailyRequestLimit: num(row.daily_request_limit),
        dailyTokenLimit: num(row.daily_token_limit),
        dailyCostLimitMicros: num(row.daily_cost_limit_micros),
        inputPriceMicrosPerMtok: num(row.input_price_micros_per_mtok),
        outputPriceMicrosPerMtok: num(row.output_price_micros_per_mtok),
    };
}

export function providerSnapshot(row: any) {
    return { adapter: row.adapter, label: row.label, baseUrl: row.base_url ?? null, enabled: row.enabled, hasApiKey: !!row.api_key_enc };
}

/** Keys whose values differ between two snapshots (null `before` means "created"). */
export function changedFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
    if (!before || !after) return Object.keys(before ?? after ?? {});
    return Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

export async function auditAiChange(db: Queryable, request: FastifyRequest, entry: {
    serverId: string;
    action: AiAuditAction;
    targetType: 'ai_provider' | 'ai_route' | 'ai_assistant';
    targetId: string | null;
    changes: Record<string, unknown>;
}): Promise<void> {
    // Which client made the change (browser vs a script or agent using an admin's session)
    const client = String(request.headers['user-agent'] ?? '').slice(0, 200) || null;
    await db.query(
        `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [generateUlid(), entry.serverId, request.userId, entry.action, entry.targetType, entry.targetId,
         JSON.stringify({ ...entry.changes, client })]
    );
}

/** Recent AI-settings audit entries for a server, newest first, with the actor's name. */
export async function recentAiChanges(db: Queryable, serverId: string, limit: number) {
    const res = await db.query(
        `SELECT a.id, a.action, a.target_type, a.target_id, a.changes, a.created_at, a.actor_id, u.username, u.bot
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.server_id = $1 AND a.action LIKE 'ai\\_%'
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT $2`,
        [serverId, limit]
    );
    return res.rows.map(r => ({
        id: r.id.trim(),
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id?.trim() ?? null,
        changes: r.changes ?? {},
        createdAt: r.created_at,
        actor: r.actor_id ? { id: r.actor_id.trim(), username: r.username, bot: !!r.bot } : null,
    }));
}

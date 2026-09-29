import { getAdapter, type Adapter, type Capability, type ProviderCredentials, type Usage } from './adapters';
import { decryptString } from '../lib/encryption';
import { checkBaseUrl } from '../lib/url-guard';
import { generateUlid } from '../utils/ulid';
import { config } from '../config';

/** Anything with pg's `query` (Pool or PoolClient). */
export interface Queryable {
    query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface RouteRow {
    server_id: string;
    capability: Capability;
    provider_id: string;
    model: string;
    enabled: boolean;
    daily_request_limit: number | null;
    daily_token_limit: string | number | null;
    daily_cost_limit_micros: string | number | null;
    input_price_micros_per_mtok: string | number | null;
    output_price_micros_per_mtok: string | number | null;
}

export interface ResolvedRoute {
    route: RouteRow;
    providerId: string;
    adapter: Adapter;
    credentials: ProviderCredentials;
    model: string;
}

export type ResolveResult = { ok: true; value: ResolvedRoute } | { ok: false; error: string };

export async function allowPrivateBaseUrls(db: Queryable): Promise<boolean> {
    const res = await db.query("SELECT value FROM instance_settings WHERE key = 'ai.allow_private_base_urls'");
    return res.rows[0]?.value === true;
}

export function decryptProviderKey(row: { api_key_enc: string | null; api_key_iv: string | null; api_key_tag: string | null }): string | undefined {
    if (!row.api_key_enc || !row.api_key_iv || !row.api_key_tag) return undefined;
    return decryptString(row.api_key_enc, config.encryptionKey, row.api_key_iv, row.api_key_tag);
}

/**
 * Resolve the provider, adapter, credentials, and model serving a capability for a
 * server. Fails (with a message suitable for admins) if the route is missing or
 * disabled, the provider is disabled, the adapter can't serve the capability, or the
 * base URL fails the SSRF guard.
 */
export async function resolveRoute(db: Queryable, serverId: string, capability: Capability): Promise<ResolveResult> {
    const res = await db.query(
        `SELECT r.*, p.adapter, p.base_url, p.enabled AS provider_enabled,
                p.api_key_enc, p.api_key_iv, p.api_key_tag
         FROM ai_capability_routes r
         JOIN ai_providers p ON p.id = r.provider_id
         WHERE r.server_id = $1 AND r.capability = $2`,
        [serverId, capability]
    );
    const row = res.rows[0];
    if (!row) return { ok: false, error: `No provider is configured for "${capability}"` };
    if (!row.enabled) return { ok: false, error: `"${capability}" is disabled for this server` };
    if (!row.provider_enabled) return { ok: false, error: 'The provider for this capability is disabled' };

    const adapter = getAdapter(row.adapter);
    if (!adapter) return { ok: false, error: `Unknown provider adapter "${row.adapter}"` };
    if (!adapter.capabilities.includes(capability)) {
        return { ok: false, error: `${adapter.label} does not support "${capability}"` };
    }

    if (row.base_url) {
        const check = await checkBaseUrl(row.base_url, { allowPrivate: await allowPrivateBaseUrls(db) });
        if (!check.ok) return { ok: false, error: check.error };
    }

    let apiKey: string | undefined;
    try {
        apiKey = decryptProviderKey(row);
    } catch {
        return { ok: false, error: 'Stored API key could not be decrypted' };
    }

    return {
        ok: true,
        value: {
            route: row,
            providerId: row.provider_id.trim(),
            adapter,
            credentials: { apiKey, baseUrl: row.base_url || undefined },
            model: row.model,
        },
    };
}

const num = (v: string | number | null): number | null => (v === null || v === undefined ? null : Number(v));

/** Cost in micro-USD from admin-entered per-1M-token prices; null if no prices are set. */
export function computeCostMicros(route: RouteRow, usage: Usage): number | null {
    const inPrice = num(route.input_price_micros_per_mtok);
    const outPrice = num(route.output_price_micros_per_mtok);
    if (inPrice === null && outPrice === null) return null;
    return Math.round((usage.inputTokens * (inPrice ?? 0) + usage.outputTokens * (outPrice ?? 0)) / 1_000_000);
}

export type BudgetResult = { ok: true } | { ok: false; error: string };

/** Enforce a route's daily (UTC) request / token / cost limits before calling the provider. */
export async function checkBudget(db: Queryable, route: RouteRow): Promise<BudgetResult> {
    const reqLimit = num(route.daily_request_limit);
    const tokLimit = num(route.daily_token_limit);
    const costLimit = num(route.daily_cost_limit_micros);
    if (reqLimit === null && tokLimit === null && costLimit === null) return { ok: true };

    const res = await db.query(
        `SELECT COUNT(*)::bigint AS requests,
                COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
                COALESCE(SUM(cost_micros), 0)::bigint AS cost
         FROM ai_usage_events
         WHERE server_id = $1 AND capability = $2
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [route.server_id, route.capability]
    );
    const today = res.rows[0];
    if (reqLimit !== null && Number(today.requests) >= reqLimit) {
        return { ok: false, error: `Daily request limit reached for "${route.capability}" (${reqLimit}/day)` };
    }
    if (tokLimit !== null && Number(today.tokens) >= tokLimit) {
        return { ok: false, error: `Daily token limit reached for "${route.capability}" (${tokLimit}/day)` };
    }
    if (costLimit !== null && Number(today.cost) >= costLimit) {
        return { ok: false, error: `Daily cost limit reached for "${route.capability}"` };
    }
    return { ok: true };
}

export interface UsageRecord {
    serverId: string;
    capability: Capability;
    providerId: string | null;
    adapter: string;
    model: string;
    usage: Usage;
    latencyMs: number;
    route?: RouteRow;
    channelId?: string | null;
    userId?: string | null;
    messageId?: string | null;
    runId?: string | null;
    error?: string | null;
}

export async function recordUsage(db: Queryable, rec: UsageRecord): Promise<void> {
    const cost = rec.route && !rec.error ? computeCostMicros(rec.route, rec.usage) : null;
    await db.query(
        `INSERT INTO ai_usage_events (id, server_id, channel_id, user_id, message_id, provider, model,
                                      input_tokens, output_tokens, latency_ms, error,
                                      capability, provider_id, cost_micros, run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [generateUlid(), rec.serverId, rec.channelId ?? null, rec.userId ?? null, rec.messageId ?? null,
         rec.adapter, rec.model, rec.usage.inputTokens, rec.usage.outputTokens, rec.latencyMs, rec.error ?? null,
         rec.capability, rec.providerId, cost, rec.runId ?? null]
    );
}

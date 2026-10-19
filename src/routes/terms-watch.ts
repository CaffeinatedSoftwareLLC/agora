import type { FastifyInstance } from 'fastify';
import { requireInstanceAdmin } from '../auth/middleware';
import { generateUlid } from '../utils/ulid';
import { termsUrl } from '../lib/terms-fetch';
import { termsAlertChannel } from '../workers/terms-watch';

const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } } };
const hostSchema = { type: 'string', minLength: 1, maxLength: 253, pattern: '^[a-z0-9]+(?:[.-][a-z0-9]+)*$' };
const guard = [requireInstanceAdmin];

export async function termsWatchRoutes(app: FastifyInstance) {
    app.get('/terms-watch', { preHandler: guard }, async request => {
        const db = request.dbClient!;
        const docs = await db.query(`SELECT d.id,d.name,d.provider,d.url,d.allowed_hosts,d.enabled,d.fetched_at,d.checked_at,d.status,d.error,d.consecutive_failures,
            (SELECT max(created_at) FROM terms_changes WHERE document_id=d.id) AS last_change_at,
            (SELECT count(*)::int FROM terms_changes WHERE document_id=d.id AND acknowledged_at IS NULL) AS unacknowledged
            FROM terms_documents d ORDER BY d.provider,d.name,d.id`);
        const settings = Object.fromEntries((await db.query("SELECT key,value FROM instance_settings WHERE key LIKE 'terms_watch.%'")).rows.map(r => [r.key, r.value]));
        const channels = await db.query(`SELECT c.id,c.name,s.name AS server_name FROM channels c JOIN servers s ON s.id=c.server_id
            WHERE c.channel_type=3 AND s.owner_id=(SELECT id FROM users WHERE is_instance_admin AND NOT bot ORDER BY created_at,id LIMIT 1)
            ORDER BY s.created_at,s.id,c.position,c.id`);
        return { documents: docs.rows.map(r => ({ ...r, id: r.id.trim() })),
            settings: { intervalHours: settings['terms_watch.interval_hours'] ?? 24, channelId: settings['terms_watch.channel_id'] ?? null,
                effectiveChannelId: await termsAlertChannel(db), lastRunAt: settings['terms_watch.last_run_at'] ?? null, requested: settings['terms_watch.requested'] ?? false },
            channels: channels.rows.map(r => ({ ...r, id: r.id.trim() })) };
    });
    app.post('/terms-watch/documents', { preHandler: guard, schema: { body: {
        type: 'object', additionalProperties: false, required: ['name','url'], properties: {
            name: { type: 'string', minLength: 1, maxLength: 160, pattern: '\\S' }, url: { type: 'string', maxLength: 2048 },
            provider: { type: 'string', enum: ['anthropic','openai','google','other'], default: 'other' },
            allowedHosts: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: hostSchema },
        },
    } } }, async (request, reply) => {
        const b = request.body as { name: string; url: string; provider: string; allowedHosts?: string[] };
        let url: URL, hosts: string[];
        try { url = new URL(b.url); hosts = b.allowedHosts ?? [url.hostname.toLowerCase()]; url = termsUrl(b.url, hosts); }
        catch { return reply.code(400).send({ error: 'invalid_or_unsafe_url' }); }
        const id = generateUlid();
        const res = await request.dbClient!.query(`INSERT INTO terms_documents (id,name,url,provider,allowed_hosts) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (url) DO NOTHING RETURNING id`, [id, b.name.trim(), url.href, b.provider, hosts]);
        if (!res.rowCount) return reply.code(409).send({ error: 'url_already_watched' });
        return reply.code(201).send({ id });
    });
    app.patch('/terms-watch/documents/:id', { preHandler: guard, schema: { params: idParams, body: {
        type: 'object', additionalProperties: false, minProperties: 1, properties: {
            enabled: { type: 'boolean' }, allowedHosts: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: hostSchema },
        },
    } } }, async (request, reply) => {
        const { id } = request.params as { id: string }; const b = request.body as { enabled?: boolean; allowedHosts?: string[] };
        const doc = await request.dbClient!.query('SELECT url FROM terms_documents WHERE id=$1 FOR UPDATE', [id]);
        if (!doc.rowCount) return reply.code(404).send({ error: 'document_not_found' });
        if (b.allowedHosts) { try { termsUrl(doc.rows[0].url, b.allowedHosts); } catch { return reply.code(400).send({ error: 'initial_host_must_be_allowed' }); } }
        await request.dbClient!.query('UPDATE terms_documents SET enabled=COALESCE($2,enabled),allowed_hosts=COALESCE($3,allowed_hosts) WHERE id=$1', [id,b.enabled ?? null,b.allowedHosts ?? null]);
        return { updated: true };
    });
    app.delete('/terms-watch/documents/:id', { preHandler: guard, schema: { params: idParams } }, async (request, reply) => {
        const res = await request.dbClient!.query('DELETE FROM terms_documents WHERE id=$1 RETURNING id', [(request.params as { id: string }).id]);
        if (!res.rowCount) return reply.code(404).send({ error: 'document_not_found' });
        return { deleted: true };
    });
    app.patch('/terms-watch/settings', { preHandler: guard, schema: { body: {
        type: 'object', additionalProperties: false, minProperties: 1, properties: {
            intervalHours: { type: 'integer', minimum: 1, maximum: 720 }, channelId: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' }] },
        },
    } } }, async (request, reply) => {
        const b = request.body as { intervalHours?: number; channelId?: string | null }; const db = request.dbClient!;
        if (b.channelId) {
            const channel = await db.query(`SELECT 1 FROM channels c JOIN servers s ON s.id=c.server_id WHERE c.id=$1 AND c.channel_type=3
                AND s.owner_id=(SELECT id FROM users WHERE is_instance_admin AND NOT bot ORDER BY created_at,id LIMIT 1)`, [b.channelId]);
            if (!channel.rowCount) return reply.code(400).send({ error: 'owner_text_channel_required' });
        }
        for (const [field,key] of [['intervalHours','terms_watch.interval_hours'],['channelId','terms_watch.channel_id']] as const) {
            if (b[field] !== undefined) await db.query(`INSERT INTO instance_settings (key,value) VALUES ($1,$2::jsonb)
                ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [key,JSON.stringify(b[field])]);
        }
        return { updated: true };
    });
    app.post('/terms-watch/check', { preHandler: guard, schema: { body: { type: 'object', additionalProperties: false, properties: {} } } }, async (request, reply) => {
        await request.dbClient!.query(`INSERT INTO instance_settings (key,value) VALUES ('terms_watch.requested','true')
            ON CONFLICT (key) DO UPDATE SET value='true',updated_at=now()`);
        return reply.code(202).send({ queued: true });
    });
    app.get('/terms-watch/documents/:id/changes', { preHandler: guard, schema: { params: idParams, querystring: {
        type: 'object', additionalProperties: false, properties: { before: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    } } }, async (request, reply) => {
        const { id } = request.params as { id: string }; const q = request.query as { before?: string; limit: number };
        if (!(await request.dbClient!.query('SELECT 1 FROM terms_documents WHERE id=$1',[id])).rowCount) return reply.code(404).send({ error: 'document_not_found' });
        const changes = await request.dbClient!.query(`SELECT * FROM terms_changes WHERE document_id=$1 AND ($2::text IS NULL OR id<$2::char(26)) ORDER BY id DESC LIMIT $3`, [id,q.before ?? null,q.limit]);
        return changes.rows.map(r => ({ ...r, id:r.id.trim(), document_id:r.document_id.trim(), acknowledged_by:r.acknowledged_by?.trim() ?? null, notice_id:r.notice_id?.trim() ?? null }));
    });
    app.post('/terms-watch/changes/:id/acknowledge', { preHandler: guard, schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: {} } } }, async (request, reply) => {
        const res = await request.dbClient!.query(`UPDATE terms_changes SET acknowledged_at=COALESCE(acknowledged_at,now()),
            acknowledged_by=COALESCE(acknowledged_by,$2) WHERE id=$1 RETURNING id`, [(request.params as {id:string}).id,request.userId]);
        if (!res.rowCount) return reply.code(404).send({ error: 'change_not_found' });
        return { acknowledged: true };
    });
}

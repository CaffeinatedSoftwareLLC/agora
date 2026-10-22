import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { readAuthorities } from '../lib/direct-agents';
import { addTaggingToAttachments } from '../lib/file-tags';
import { artifactsForMessages } from '../lib/artifacts';

const ulid = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' };

async function botAccess(request: FastifyRequest, reply: FastifyReply, channelId?: string): Promise<boolean> {
    if (!request.isBot) { reply.code(403).send({ error: 'This endpoint is for bots only' }); return false; }
    if (channelId && !(await request.dbClient!.query(
        'SELECT 1 FROM bot_channel_access WHERE bot_id = $1 AND channel_id = $2', [request.userId, channelId],
    )).rows.length) {
        reply.code(403).send({ error: 'Bot does not have access to this channel' }); return false;
    }
    return true;
}

/** Same trusted envelope/attachments as channel and reply reads. */
async function envelopes(db: PoolClient, channelId: string, rows: any[]) {
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const files = await db.query(`SELECT id, message_id, filename, mime_type, content_type, size_bytes,
        width, height, deleted_at FROM files WHERE message_id = ANY($1) ORDER BY created_at ASC`, [ids]);
    const attachments = new Map<string, any[]>();
    for (const f of files.rows) {
        const list = attachments.get(f.message_id.trim()) ?? [];
        list.push({ id: f.id.trim(), name: f.filename, mime: f.mime_type || f.content_type,
            size: f.size_bytes, width: f.width, height: f.height, url: `/files/${f.id.trim()}`, deletedAt: f.deleted_at });
        attachments.set(f.message_id.trim(), list);
    }
    await addTaggingToAttachments(db, [...attachments.values()].flat());
    const authorities = await readAuthorities(db, channelId, rows);
    const artifacts = await artifactsForMessages(db, ids);
    return rows.map(r => ({
        id: r.id.trim(), content: r.content, authorId: r.author_id?.trim() ?? null,
        authorUsername: r.author_username ?? null, authorBot: !!r.author_bot,
        authorAvatarUrl: r.author_avatar_url ?? null, authorAuthority: authorities.get(r.id.trim()) ?? null,
        channelId: r.channel_id.trim(), threadId: r.thread_id?.trim() ?? null,
        createdAt: r.created_at, editedAt: r.edited_at, deletedAt: r.deleted_at,
        attachments: attachments.get(r.id.trim()) ?? [],
        ...(r.protocol ? { protocol: r.protocol } : {}),
        ...(r.reply_count > 0 ? { replyCount: r.reply_count, lastReplyAt: r.last_reply_at,
            ...(r.thread_closed_at ? { threadClosedAt: r.thread_closed_at } : {}) } : {}),
        ...(artifacts.has(r.id.trim()) ? { artifact: artifacts.get(r.id.trim()) } : {}),
    }));
}

export async function botAttentionRoutes(app: FastifyInstance) {
    app.get('/channels/:id/attention', {
        schema: { querystring: { type: 'object', additionalProperties: false, properties: {
            after: ulid, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
        } } },
    }, async (request, reply) => {
        const { id: channelId } = request.params as { id: string };
        if (!await botAccess(request, reply, channelId)) return reply;
        const { after, limit = 100 } = request.query as { after?: string; limit?: number };
        const db = request.dbClient!;
        // A newly upgraded client starts watching now, rather than replaying days
        // of old mentions. An explicit `after` opts into an earlier starting point.
        // Persist even for an empty channel so the next post can be delivered.
        // Separate statements give a concurrent initializer's committed cursor a
        // fresh READ COMMITTED snapshot before the feed query below.
        await db.query(`INSERT INTO bot_attention_cursors (bot_id, channel_id, last_read_id)
            SELECT $1, $2, COALESCE($3::CHAR(26), (
                SELECT id FROM messages WHERE channel_id = $2 ORDER BY id DESC LIMIT 1
            ), '00000000000000000000000000'::CHAR(26))
            WHERE NOT EXISTS (SELECT 1 FROM bot_attention_cursors WHERE bot_id = $1 AND channel_id = $2)
            ON CONFLICT (bot_id, channel_id) DO NOTHING`, [request.userId, channelId, after ?? null]);
        const rows = await db.query(`WITH cutoff AS (
            SELECT GREATEST(COALESCE($3::CHAR(26), ''::CHAR(26)), COALESCE((
                SELECT a.last_read_id FROM bot_attention_cursors a WHERE a.bot_id = $1 AND a.channel_id = $2
            ), ''::CHAR(26))) AS id
        ), addressed AS (
            SELECT m.id FROM message_mentions mm JOIN messages m ON m.id = mm.message_id, cutoff
            WHERE mm.user_id = $1 AND m.channel_id = $2 AND m.id > cutoff.id
            UNION
            SELECT m.id FROM messages m JOIN users self ON self.id = $1, cutoff
            WHERE m.channel_id = $2 AND m.protocol IS NOT NULL AND m.id > cutoff.id
              AND lower(m.protocol->>'yieldTo') = lower(self.username)
        )
        SELECT m.*, u.username AS author_username, u.bot AS author_bot, u.avatar_url AS author_avatar_url
        FROM addressed a JOIN messages m ON m.id = a.id LEFT JOIN users u ON u.id = m.author_id
        LEFT JOIN bot_read_cursors rc ON rc.bot_id = $1 AND rc.channel_id = $2
        LEFT JOIN bot_thread_cursors tc ON tc.bot_id = $1 AND tc.thread_id = m.thread_id
        WHERE m.deleted_at IS NULL AND m.author_id IS DISTINCT FROM $1
          AND m.id > COALESCE(CASE WHEN m.thread_id IS NULL THEN rc.last_read_id ELSE tc.last_read_id END, ''::CHAR(26))
        ORDER BY m.id ASC LIMIT $4`, [request.userId, channelId, after ?? null, limit]);
        return reply.send(await envelopes(db, channelId, rows.rows));
    });

    app.get('/bots/@me/attention-cursors', async (request, reply) => {
        if (!await botAccess(request, reply)) return reply;
        const result = await request.dbClient!.query(`SELECT channel_id, last_read_id, updated_at
            FROM bot_attention_cursors WHERE bot_id = $1 ORDER BY channel_id`, [request.userId]);
        return reply.send(result.rows.map(r => ({ channelId: r.channel_id.trim(), lastReadId: r.last_read_id.trim(), updatedAt: r.updated_at })));
    });

    app.put('/bots/@me/attention-cursors/:channelId', {
        schema: { body: { type: 'object', additionalProperties: false, required: ['lastReadId'], properties: { lastReadId: ulid } } },
    }, async (request, reply) => {
        const { channelId } = request.params as { channelId: string };
        if (!await botAccess(request, reply, channelId)) return reply;
        const { lastReadId } = request.body as { lastReadId: string };
        const db = request.dbClient!;
        const addressed = await db.query(`SELECT 1 FROM messages m JOIN users self ON self.id = $1
            WHERE m.id = $3 AND m.channel_id = $2 AND m.deleted_at IS NULL AND m.author_id IS DISTINCT FROM $1
              AND (EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = $1)
                OR (m.protocol IS NOT NULL AND lower(m.protocol->>'yieldTo') = lower(self.username)))`,
        [request.userId, channelId, lastReadId]);
        if (!addressed.rows.length) return reply.code(400).send({ error: 'Attention message not found in this channel' });
        const saved = await db.query(`INSERT INTO bot_attention_cursors (bot_id, channel_id, last_read_id)
            VALUES ($1, $2, $3) ON CONFLICT (bot_id, channel_id) DO UPDATE
            SET last_read_id = GREATEST(bot_attention_cursors.last_read_id, EXCLUDED.last_read_id), updated_at = NOW()
            RETURNING last_read_id`, [request.userId, channelId, lastReadId]);
        return reply.send({ channelId, lastReadId: saved.rows[0].last_read_id.trim() });
    });
}

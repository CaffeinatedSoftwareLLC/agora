import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkRun, type Notice } from '../lib/agent-runs';
import { storeFile, getFileSetting, readUploadPart, FILE_TOO_LARGE } from '../lib/file-store';
import { IMAGE_MIMES, validateFileType } from '../lib/file-validation';
import { extractImagePaths } from '../lib/image-references';

/** Host-uploaded bytes only: the API never opens a host-supplied filesystem path.
 * The host enforces realpath containment in its cwd/temp before reading those bytes. */
export async function agentImageRoutes(app: FastifyInstance) {
    async function authorize(request: FastifyRequest, reply: FastifyReply, claimToken: unknown) {
        if (typeof claimToken !== 'string' || claimToken.length > 200) {
            reply.status(400).send({ error: 'claimToken is required' }); return null;
        }
        const notices: Notice[] = [];
        const check = await checkRun(request.dbClient!, request.agentHost!, (request.params as any).runId, claimToken, null, notices);
        request.pendingEvents ??= [];
        for (const n of notices) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
        if (!check.ok) { reply.status(check.status).send(check.body); return null; }
        // Recheck revocation and session/bot access under the same run lock.
        const allowed = await request.dbClient!.query(`SELECT s.channel_id, s.bot_id FROM agent_sessions s
            JOIN users u ON u.id = s.bot_id JOIN users o ON o.id = u.bot_owner_id
            JOIN agent_hosts h ON h.id = $2
            JOIN bot_channel_access b ON b.bot_id = s.bot_id AND b.channel_id = s.channel_id
            WHERE s.id = $1 AND s.state = 'live' AND h.revoked_at IS NULL
              AND u.bot_paused_at IS NULL AND u.account_status = 'active' AND o.account_status = 'active'
            FOR SHARE OF h`, [check.run.session_id, request.agentHost!.id]);
        if (check.run.cancel_requested || !allowed.rows[0]) { reply.status(409).send({ error: 'run_cancelled' }); return null; }
        return { run: check.run, channelId: allowed.rows[0].channel_id.trim(), botId: allowed.rows[0].bot_id.trim() };
    }

    app.post('/agent-hosts/@me/runs/:runId/images/discover', {
        schema: { body: { type: 'object', required: ['claimToken'], additionalProperties: false,
            properties: { claimToken: { type: 'string', minLength: 1, maxLength: 200 } } } },
    }, async (request, reply) => {
        const auth = await authorize(request, reply, (request.body as any).claimToken);
        if (!auth) return reply;
        const maxBytes = Number(await getFileSetting(request.dbClient!, 'files.max_size_bytes'));
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return reply.status(503).send({ error: 'file_size_limit_required' });
        const posts = await request.dbClient!.query(`SELECT btrim(id) AS id, content FROM messages
            WHERE channel_id = $1 AND author_id = $2 AND created_at >= (SELECT created_at FROM agent_runs WHERE id = $3) AND created_at <= NOW()
              AND deleted_at IS NULL ORDER BY id`, [auth.channelId, auth.botId, auth.run.id]);
        return reply.send({ maxBytes, messages: posts.rows.filter(m => extractImagePaths(m.content ?? '').length > 0) });
    });

    app.post('/agent-hosts/@me/runs/:runId/images', async (request, reply) => {
        const db = request.dbClient!;
        const maxBytes = Number(await getFileSetting(db, 'files.max_size_bytes'));
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return reply.status(503).send({ error: 'file_size_limit_required' });
        const data = await request.file({ limits: { fileSize: maxBytes, files: 1, fields: 3 } });
        if (!data) return reply.status(400).send({ error: 'image is required' });
        const field = (name: string) => (data.fields[name] as any)?.value;
        const auth = await authorize(request, reply, field('claimToken'));
        if (!auth) return reply;
        const messageId = field('messageId'), reference = field('reference');
        if (typeof messageId !== 'string' || messageId.length !== 26 || typeof reference !== 'string' || reference.length > 4096) return reply.status(400).send({ error: 'invalid_reference' });
        const message = await db.query(`SELECT content, thread_id, edited_at, protocol FROM messages WHERE id = $1 AND channel_id = $2
            AND author_id = $3 AND created_at >= (SELECT created_at FROM agent_runs WHERE id = $4) AND created_at <= NOW() AND deleted_at IS NULL FOR UPDATE`,
            [messageId, auth.channelId, auth.botId, auth.run.id]);
        if (!message.rows[0] || !extractImagePaths(message.rows[0].content ?? '').includes(reference)) return reply.status(400).send({ error: 'invalid_reference' });
        let buffer: Buffer | null;
        try { buffer = await readUploadPart(data); } catch (err) {
            if (err instanceof app.multipartErrors.RequestFileTooLargeError) buffer = null;
            else throw err;
        }
        if (!buffer) return reply.status(FILE_TOO_LARGE.status).send({ error: FILE_TOO_LARGE.error });
        const digest = createHash('sha256').update(buffer).digest('hex');
        const prior = await db.query('SELECT file_id FROM agent_run_images WHERE run_id = $1 AND digest = $2', [auth.run.id, digest]);
        if (prior.rows.length) return reply.send({ ok: true, repeated: true, fileId: prior.rows[0].file_id.trim() });
        const count = await db.query('SELECT count(*)::int AS n FROM files WHERE message_id = $1 AND deleted_at IS NULL', [messageId]);
        if (count.rows[0].n >= 10) return reply.status(400).send({ error: 'Too many attachments (max 10)' });
        const filename = path.win32.basename(reference.replace(/\//g, '\\'));
        // storeFile's instance allowlist may include PDFs/video; this endpoint is images only.
        try {
            const type = await validateFileType(buffer, path.extname(filename).slice(1).toLowerCase(), ['png', 'jpg', 'jpeg', 'gif', 'webp']);
            if (!IMAGE_MIMES.includes(type.mime)) return reply.status(415).send({ error: 'Image required' });
        } catch { return reply.status(415).send({ error: 'Invalid image' }); }
        const stored = await storeFile(db, app.db, { buffer, filename, uploaderId: auth.botId, channelId: auth.channelId });
        if (!stored.ok) return reply.status(stored.status).send({ error: stored.error });
        await db.query('UPDATE files SET message_id = $1 WHERE id = $2', [messageId, stored.file.id]);
        await db.query('INSERT INTO agent_run_images (run_id, digest, file_id, message_id) VALUES ($1, $2, $3, $4)',
            [auth.run.id, digest, stored.file.id, messageId]);
        const files = await db.query(`SELECT btrim(id) AS id, filename AS name, mime_type AS mime, size_bytes AS size, width, height,
            '/files/' || btrim(id) AS url FROM files WHERE message_id = $1 AND deleted_at IS NULL ORDER BY id`, [messageId]);
        request.pendingEvents ??= [];
        request.pendingEvents.push({ room: `channel:${auth.channelId}`, event: 'MessageUpdate', data: {
            id: messageId, channelId: auth.channelId, attachments: files.rows,
            content: message.rows[0].content, editedAt: message.rows[0].edited_at ?? undefined, protocol: message.rows[0].protocol ?? null,
            ...(message.rows[0].thread_id ? { threadId: message.rows[0].thread_id.trim() } : {}),
        } });
        return reply.status(201).send({ ok: true, file: stored.file });
    });
}

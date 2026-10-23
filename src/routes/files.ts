import { FastifyInstance } from 'fastify';
import path from 'path';
import { generateUlid } from '../utils/ulid';
import { Permissions } from '../permissions';
import { checkChannelPermissions as checkFilePermissions, uploadPermissions } from '../lib/channel-access';
import { storage } from '../lib/storage';
import { encryptFile, decryptFile } from '../lib/encryption';
import { INLINE_SAFE_MIMES } from '../lib/file-validation';
import { storeFile, uploadByteLimit, FILE_TOO_LARGE } from '../lib/file-store';
import { searchChannelFiles, MAX_LIMIT } from '../lib/file-search';
import { readFileText, READ_MAX_CHARS } from '../lib/file-read';
import { readFileImage, isBotPaused } from '../lib/file-image';
import { canViewChannel } from '../lib/channel-access';
import { encodeRfc5987 } from '../lib/http-utils';
import { config } from '../config';
import { fileAttachmentUpdateInTransaction } from '../lib/file-attachment-updates';

/** Bound uploader text for a plain-text audit notice (no Markdown interpretation). */
function auditFilename(filename: string): string {
    const characters = Array.from(filename.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' '));
    const label = characters.length > 80 ? characters.slice(0, 79).join('') + '…' : characters.join('');
    return `"${label}"`;
}

export async function fileRoutes(app: FastifyInstance) {

    app.route({
        method: ['POST', 'DELETE'], url: '/files/:fileId/trust',
        schema: { params: { type: 'object', required: ['fileId'], properties: {
            fileId: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
        } } },
        handler: async (request, reply) => {
            if (request.isBot) return reply.status(403).send({ error: 'Only the server owner may change file trust' });
            request.pendingEvents ??= [];
            const { fileId } = request.params as { fileId: string };
            const db = request.dbClient!;
            const file = (await db.query(`SELECT f.channel_id, f.message_id, f.filename, c.server_id, s.owner_id,
                    j.injection_probability, COALESCE(a.screening_flag_threshold, 0.7) AS flag_threshold
                FROM files f JOIN channels c ON c.id = f.channel_id JOIN servers s ON s.id = c.server_id
                JOIN messages m ON m.id = f.message_id AND m.deleted_at IS NULL
                LEFT JOIN file_tag_jobs j ON j.file_id = f.id
                LEFT JOIN ai_decision_settings a ON a.server_id = c.server_id
                WHERE f.id = $1 AND f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > NOW())`, [fileId])).rows[0];
            if (!file) return reply.status(404).send({ error: 'File not found' });
            if (file.owner_id.trim() !== request.userId) return reply.status(403).send({ error: 'Only the server owner may change file trust' });
            const member = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [file.server_id, request.userId]);
            if (!member.rows.length) return reply.status(403).send({ error: 'Server membership required' });
            const current = (await db.query(`SELECT trusted_by, trusted_at FROM files WHERE id = $1 AND channel_id = $2
                AND message_id = $3 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) FOR UPDATE`, [fileId, file.channel_id, file.message_id])).rows[0];
            const parent = await db.query('SELECT 1 FROM messages WHERE id = $1 AND deleted_at IS NULL FOR SHARE', [file.message_id]);
            if (!current || !parent.rows.length) return reply.status(404).send({ error: 'File not found' });
            const trust = request.method === 'POST';
            if (trust && !current.trusted_at && !(file.injection_probability !== null && Number(file.injection_probability) >= Number(file.flag_threshold))) {
                return reply.status(409).send({ error: 'File is not flagged for prompt injection' });
            }
            if (trust !== !!current.trusted_at) {
                const changed = await db.query('UPDATE files SET trusted_by = $2, trusted_at = CASE WHEN $2::CHAR(26) IS NULL THEN NULL ELSE NOW() END WHERE id = $1 RETURNING id',
                    [fileId, trust ? request.userId : null]);
                if (!changed.rows.length) return reply.status(403).send({ error: 'Only the server owner may change file trust' });
                const username = (await db.query('SELECT username FROM users WHERE id = $1', [request.userId])).rows[0].username;
                // Unlike POST /messages, this system-notice path never resolves mentions or protocol.
                const content = `${username} ${trust ? 'marked' : 'removed trust from'} ${auditFilename(file.filename)}${trust ? ' as trusted' : ''}.`;
                const noticeId = generateUlid();
                const notice = (await db.query(`INSERT INTO messages (id, channel_id, author_id, content, system_event)
                    VALUES ($1, $2, NULL, $3, 'file_trust') RETURNING created_at`, [noticeId, file.channel_id, content])).rows[0];
                request.pendingEvents.push({ room: `channel:${file.channel_id.trim()}`, event: 'Message', data: {
                    id: noticeId, channelId: file.channel_id.trim(), content, authorId: null, authorUsername: null,
                    createdAt: notice.created_at, systemEvent: 'file_trust',
                } });
                await db.query(`INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
                    VALUES ($1, $2, $3, $4, 'file', $5, $6::jsonb)`,
                    [generateUlid(), file.server_id, request.userId, trust ? 'file_trust' : 'file_untrust', fileId, JSON.stringify({ trusted: trust })]);
            }
            const update = await fileAttachmentUpdateInTransaction(db, fileId);
            if (!update) return reply.status(404).send({ error: 'File not found' });
            request.pendingEvents.push({ room: `channel:${update.channelId}`, event: 'FileAttachmentUpdate', data: update });
            return reply.send(update);
        },
    });

    // POST /files/upload → 201 { id, name, mime, size, width, height, url }
    app.post('/files/upload', {
        config: {
            rateLimit: {
                max: 20,
                timeWindow: '1 minute',
                keyGenerator: (request: any) => request.userId,
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const db = request.dbClient!;

        // Parse multipart. The admin setting is the only size cap: without a fileSize here,
        // multipart stopped at Fastify's 1 MiB bodyLimit before storeFile saw the file (#157)
        const data = await request.file({ limits: { fileSize: await uploadByteLimit(db) } });
        if (!data) {
            return reply.status(400).send({ error: 'No file uploaded' });
        }

        // Read channel_id from fields
        const channelIdField = (data.fields as any).channel_id;
        const channelId = channelIdField?.value;
        if (!channelId || typeof channelId !== 'string') {
            return reply.status(400).send({ error: 'channel_id is required' });
        }

        // People need UploadFiles + SendMessages; a bot needs its channel access + UploadFiles
        const permCheck = await checkFilePermissions(db, channelId, userId, uploadPermissions(!!request.isBot), { isBot: request.isBot });
        if (!permCheck.allowed) {
            return reply.status(permCheck.status!).send({ error: permCheck.error });
        }

        let buffer: Buffer;
        try {
            buffer = await data.toBuffer();
        } catch (err) {
            // Over the setting: multipart stops reading, and the answer is storeFile's own refusal
            if (err instanceof app.multipartErrors.RequestFileTooLargeError) {
                return reply.status(FILE_TOO_LARGE.status).send({ error: FILE_TOO_LARGE.error });
            }
            throw err;
        }

        const result = await storeFile(db, app.db, {
            buffer,
            filename: data.filename,
            uploaderId: userId,
            channelId,
        });
        if (!result.ok) {
            return reply.status(result.status).send({ error: result.error, ...(result.details ? { details: result.details } : {}) });
        }
        return reply.status(201).send(result.file);
    });

    // GET /channels/:id/files/search?q=&tag=&limit= → files in the channel, best match first.
    // Metadata only (names, tags, scores), never file text. Bots may call it for channels they can access.
    app.get('/channels/:id/files/search', {
        config: {
            rateLimit: {
                max: 30,
                timeWindow: '1 minute',
                keyGenerator: (request: any) => request.userId,
            },
        },
        schema: {
            querystring: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    q: { type: 'string', maxLength: 500 },
                    tag: { type: 'string', maxLength: 40 },
                    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
                },
            },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any;
        const { q, tag, limit } = request.query as { q?: string; tag?: string; limit?: number };
        // Authorization happens inside, before anything is read; the search itself runs
        // as the server (bots are not server members, so row-level policies cannot express their access)
        const result = await searchChannelFiles(
            { db: app.db, store: storage, encryptionKey: config.encryptionKey },
            { channelId, userId: request.userId, isBot: !!request.isBot, query: q, tag, limit },
        );
        if (!result.ok) return reply.status(result.status).send({ error: result.error });
        return reply.send(result.body);
    });

    // GET /files/:fileId/text?offset=&limit= → the readable text of a text file or PDF, in pages.
    // For members who can see the file's channel, and for bots with access to it: this is how an
    // agent reads a file it found with file search.
    app.get('/files/:fileId/text', {
        config: {
            rateLimit: {
                max: 30,
                timeWindow: '1 minute',
                keyGenerator: (request: any) => request.userId,
            },
        },
        schema: {
            querystring: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    offset: { type: 'integer', minimum: 0 },
                    limit: { type: 'integer', minimum: 1, maximum: READ_MAX_CHARS },
                },
            },
        },
    }, async (request, reply) => {
        const { fileId } = request.params as any;
        const { offset, limit } = request.query as { offset?: number; limit?: number };
        // Authorization happens inside, before anything is decrypted (see searchChannelFiles above for why the pool)
        const result = await readFileText(
            { db: app.db, store: storage, encryptionKey: config.encryptionKey },
            { fileId, userId: request.userId, isBot: !!request.isBot, offset, limit },
        );
        if (!result.ok) return reply.status(result.status).send({ error: result.error });
        return reply.send(result.body);
    });

    // GET /files/:fileId/image → an image file as base64, scaled down to fit what a model can take
    // (longest side 1568px, about 3.5 MB of base64). agora-mcp's file_read returns it as MCP image content.
    // Same files and access as /text above; paused bots are refused, as for downloads.
    app.get('/files/:fileId/image', {
        config: {
            rateLimit: {
                max: 30,
                timeWindow: '1 minute',
                keyGenerator: (request: any) => request.userId,
            },
        },
    }, async (request, reply) => {
        const { fileId } = request.params as any;
        const result = await readFileImage(
            { db: app.db, store: storage, encryptionKey: config.encryptionKey },
            { fileId, userId: request.userId, isBot: !!request.isBot },
        );
        if (!result.ok) return reply.status(result.status).send({ error: result.error });
        return reply.header('Cache-Control', 'no-store').send(result.body);
    });

    // GET /files/:fileId → binary file content
    // People: ViewChannel in the file's channel. Bots: access to the channel (bot_channel_access),
    // only for files attached to a live message, and never while paused.
    app.get('/files/:fileId', async (request, reply) => {
        const { fileId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;
        const columns = 'f.id, f.uploader_id, f.channel_id, f.filename, f.mime_type, f.size_bytes, f.storage_key, f.encryption_iv, f.encryption_tag, f.deleted_at';
        let file: any;

        if (request.isBot) {
            // Bots are not server members, so ViewChannel cannot be computed for them. Same files as
            // /text (attached to a live message), looked up as the server, then access is checked explicitly
            const fileRes = await app.db.query(
                `SELECT ${columns} FROM files f
                 JOIN messages m ON m.id = f.message_id AND m.deleted_at IS NULL
                 WHERE f.id = $1 AND f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > NOW())`,
                [fileId]
            );
            file = fileRes.rows[0];
            if (!file) return reply.status(404).send({ error: 'File not found' });
            const access = await canViewChannel(app.db, file.channel_id.trim(), userId, true);
            if (!access.allowed) return reply.status(403).send({ error: access.error });
            if (await isBotPaused(app.db, userId)) return reply.status(403).send({ error: 'bot_paused' });
        } else {
            const fileRes = await db.query(`SELECT ${columns} FROM files f WHERE f.id = $1`, [fileId]);
            file = fileRes.rows[0];
            if (!file || file.deleted_at) {
                return reply.status(404).send({ error: 'File not found' });
            }

            // Check ViewChannel permission
            const permCheck = await checkFilePermissions(db, file.channel_id.trim(), userId, Permissions.ViewChannel);
            if (!permCheck.allowed) {
                return reply.status(permCheck.status!).send({ error: permCheck.error });
            }
        }

        const encryptedBuffer = await storage.get(file.storage_key.trim());
        if (!encryptedBuffer) {
            // Keep the row: the blob may still be on its way (e.g. an upgrade that hasn't
            // run the MinIO migration yet); failed uploads already delete their own rows
            return reply.status(404).send({ error: 'File not found' });
        }

        // Decrypt (encryption_iv and encryption_tag are BYTEA → pg returns Buffer)
        const iv = Buffer.isBuffer(file.encryption_iv) ? file.encryption_iv : Buffer.from(file.encryption_iv, 'hex');
        const authTag = Buffer.isBuffer(file.encryption_tag) ? file.encryption_tag : Buffer.from(file.encryption_tag, 'hex');
        const decrypted = decryptFile(encryptedBuffer, config.encryptionKey, iv, authTag);

        // Determine disposition
        const mime = file.mime_type.trim();
        const filename = file.filename.trim();
        const disposition = INLINE_SAFE_MIMES.has(mime) ? 'inline' : 'attachment';
        const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/[\\"/]/g, '_');
        const utf8Name = encodeRfc5987(filename);

        return reply
            .header('Content-Type', mime)
            .header('Content-Disposition', `${disposition}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`)
            .header('Content-Length', decrypted.length)
            .header('Cache-Control', 'private, max-age=3600')
            .header('X-Content-Type-Options', 'nosniff')
            .send(decrypted);
    });

    // DELETE /files/:fileId → 200 { deleted: true }
    app.delete('/files/:fileId', async (request, reply) => {
        const { fileId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;

        // Fetch file metadata
        const fileRes = await db.query(
            'SELECT id, uploader_id, channel_id, storage_key, deleted_at FROM files WHERE id = $1',
            [fileId]
        );
        if (fileRes.rows.length === 0) {
            return reply.status(404).send({ error: 'File not found' });
        }

        const file = fileRes.rows[0];
        if (file.deleted_at) {
            return reply.status(404).send({ error: 'File not found' });
        }

        const channelId = file.channel_id.trim();
        const isUploader = file.uploader_id.trim() === userId.trim();

        if (!isUploader) {
            // Non-uploader needs ManageMessages permission
            const permCheck = await checkFilePermissions(db, channelId, userId, Permissions.ManageMessages);
            if (!permCheck.allowed) {
                return reply.status(403).send({ error: 'You can only delete your own files' });
            }
        }

        // Soft-delete
        await db.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [fileId]);

        // Delete the blob (best-effort)
        try {
            await storage.remove(file.storage_key.trim());
        } catch {
            // Log but don't fail — cleanup worker can handle orphaned objects
        }

        return reply.status(200).send({ deleted: true });
    });
}

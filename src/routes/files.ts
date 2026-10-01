import { FastifyInstance } from 'fastify';
import path from 'path';
import { generateUlid } from '../utils/ulid';
import { Permissions } from '../permissions';
import { checkChannelPermissions as checkFilePermissions } from '../lib/channel-access';
import { storage } from '../lib/storage';
import { encryptFile, decryptFile } from '../lib/encryption';
import { INLINE_SAFE_MIMES } from '../lib/file-validation';
import { storeFile } from '../lib/file-store';
import { searchChannelFiles, MAX_LIMIT } from '../lib/file-search';
import { readFileText, READ_MAX_CHARS } from '../lib/file-read';
import { encodeRfc5987 } from '../lib/http-utils';
import { config } from '../config';


export async function fileRoutes(app: FastifyInstance) {

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

        // Parse multipart
        const data = await request.file();
        if (!data) {
            return reply.status(400).send({ error: 'No file uploaded' });
        }

        // Read channel_id from fields
        const channelIdField = (data.fields as any).channel_id;
        const channelId = channelIdField?.value;
        if (!channelId || typeof channelId !== 'string') {
            return reply.status(400).send({ error: 'channel_id is required' });
        }

        // Check permissions: UploadFiles + SendMessages
        const permCheck = await checkFilePermissions(db, channelId, userId, Permissions.UploadFiles | Permissions.SendMessages);
        if (!permCheck.allowed) {
            return reply.status(permCheck.status!).send({ error: permCheck.error });
        }

        const result = await storeFile(db, app.db, {
            buffer: await data.toBuffer(),
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
    // agent reads a file it found with file search. Bots still cannot download the file itself.
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

    // GET /files/:fileId → binary file content
    app.get('/files/:fileId', async (request, reply) => {
        const { fileId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;

        // Fetch file metadata
        const fileRes = await db.query(
            'SELECT id, uploader_id, channel_id, filename, mime_type, size_bytes, storage_key, encryption_iv, encryption_tag, deleted_at FROM files WHERE id = $1',
            [fileId]
        );
        if (fileRes.rows.length === 0) {
            return reply.status(404).send({ error: 'File not found' });
        }

        const file = fileRes.rows[0];
        if (file.deleted_at) {
            return reply.status(404).send({ error: 'File not found' });
        }

        // Check ViewChannel permission
        const permCheck = await checkFilePermissions(db, file.channel_id.trim(), userId, Permissions.ViewChannel);
        if (!permCheck.allowed) {
            return reply.status(permCheck.status!).send({ error: permCheck.error });
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

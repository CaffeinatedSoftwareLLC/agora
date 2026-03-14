import { FastifyInstance } from 'fastify';
import path from 'path';
import { generateUlid } from '../utils/ulid';
import { computePermissions, Permissions } from '../permissions';
import { checkChannelMembership } from './shared';
import { minioClient, BUCKET_NAME } from '../lib/minio';
import { encryptFile, decryptFile } from '../lib/encryption';
import { sanitizeFilename, validateFileType, FileValidationError, IMAGE_MIMES, INLINE_SAFE_MIMES } from '../lib/file-validation';
import { encodeRfc5987 } from '../lib/http-utils';
import { config } from '../config';

async function getFileSetting(db: any, key: string): Promise<any> {
    const res = await db.query('SELECT value FROM instance_settings WHERE key = $1', [key]);
    return res.rows[0]?.value;
}

async function streamToBuffer(stream: any): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function checkFilePermissions(
    db: any,
    channelId: string,
    userId: string,
    requiredPerms: bigint
): Promise<{ allowed: boolean; error?: string; status?: number }> {
    const channelRow = await db.query('SELECT id, server_id FROM channels WHERE id = $1', [channelId]);
    if (channelRow.rows.length === 0) return { allowed: false, error: 'Channel not found', status: 404 };
    const channel = channelRow.rows[0];

    if (channel.server_id) {
        const serverId = channel.server_id.trim();
        const serverRow = await db.query('SELECT owner_id, everyone_role_id FROM servers WHERE id = $1', [serverId]);
        if (serverRow.rows.length === 0) return { allowed: false, error: 'Server not found', status: 404 };

        const memberCheck = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [channel.server_id, userId]);
        if (memberCheck.rows.length === 0) return { allowed: false, error: 'Not a server member', status: 403 };

        const userRolesRes = await db.query('SELECT role_id FROM member_roles WHERE server_id = $1 AND user_id = $2', [channel.server_id, userId]);
        const roleIds = userRolesRes.rows.map((r: any) => r.role_id.trim());

        const allRoleIds = [...roleIds, serverRow.rows[0].everyone_role_id.trim()];
        const rolesRes = await db.query('SELECT id, permissions FROM roles WHERE id = ANY($1)', [allRoleIds]);
        const roles = new Map<string, { permissions: bigint }>(rolesRes.rows.map((r: any) => [r.id.trim(), { permissions: BigInt(r.permissions) }]));

        const roleOverridesRes = await db.query('SELECT role_id, allow, deny FROM channel_role_overrides WHERE channel_id = $1', [channelId]);
        const channelRoleOverrides = new Map<string, { allow: bigint; deny: bigint }>(roleOverridesRes.rows.map((r: any) => [r.role_id.trim(), { allow: BigInt(r.allow), deny: BigInt(r.deny) }]));

        const memberOverrideRes = await db.query('SELECT allow, deny FROM channel_member_overrides WHERE channel_id = $1 AND user_id = $2', [channelId, userId]);
        const channelMemberOverride = memberOverrideRes.rows[0]
            ? { allow: BigInt(memberOverrideRes.rows[0].allow), deny: BigInt(memberOverrideRes.rows[0].deny) }
            : undefined;

        const perms = computePermissions({
            userId: userId.trim(),
            roleIds,
            server: { ownerId: serverRow.rows[0].owner_id.trim(), everyoneRoleId: serverRow.rows[0].everyone_role_id.trim() },
            roles,
            channelRoleOverrides,
            channelMemberOverride,
        });

        if ((perms & requiredPerms) !== requiredPerms) {
            return { allowed: false, error: 'Missing required permissions', status: 403 };
        }

        return { allowed: true };
    } else {
        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) return { allowed: false, error: 'Not a channel member', status: 403 };
        return { allowed: true };
    }
}

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

        // Read file to buffer
        const buffer = await data.toBuffer();
        const originalName = data.filename;
        const sanitizedName = sanitizeFilename(originalName);
        const ext = path.extname(sanitizedName).slice(1).toLowerCase();

        // Check file size against instance setting
        const maxSizeBytes = await getFileSetting(db, 'files.max_size_bytes');
        if (maxSizeBytes && buffer.length > maxSizeBytes) {
            return reply.status(413).send({ error: 'File exceeds maximum allowed size' });
        }

        // Check extension against allowed list
        const allowedExtRaw = await getFileSetting(db, 'files.allowed_extensions');
        const allowedExtensions: string[] = allowedExtRaw ?? ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'json', 'zip', 'mp3', 'mp4', 'mov'];

        // Validate magic bytes
        let detectedMime: string;
        try {
            const result = await validateFileType(buffer, ext, allowedExtensions);
            detectedMime = result.mime;
        } catch (err) {
            if (err instanceof FileValidationError) {
                return reply.status(err.status).send({ error: err.message, details: err.details });
            }
            throw err;
        }

        // EXIF strip for images
        let processedBuffer = buffer;
        let width: number | undefined;
        let height: number | undefined;

        const exifStripEnabled = await getFileSetting(db, 'files.exif_strip');
        if (IMAGE_MIMES.includes(detectedMime)) {
            const sharp = (await import('sharp')).default;
            const image = sharp(buffer);
            const metadata = await image.metadata();
            width = metadata.width;
            height = metadata.height;

            if (exifStripEnabled !== false) {
                if (detectedMime === 'image/jpeg') {
                    processedBuffer = await image.jpeg({ quality: 95 }).toBuffer();
                } else if (detectedMime === 'image/png') {
                    processedBuffer = await image.png().toBuffer();
                } else if (detectedMime === 'image/webp') {
                    processedBuffer = await image.webp({ quality: 95 }).toBuffer();
                } else if (detectedMime === 'image/gif') {
                    const pages = metadata.pages ?? 1;
                    if (pages > 1) {
                        processedBuffer = buffer; // Keep animated GIFs as-is
                    } else {
                        processedBuffer = await image.gif().toBuffer();
                    }
                }
            }
        }

        // Encrypt
        const { encrypted, iv, authTag } = encryptFile(processedBuffer, config.encryptionKey);

        // Build storage key
        const fileId = generateUlid();
        const storageKey = `${channelId}/${fileId}/${sanitizedName}`;

        // Expiry (optional setting)
        const retentionDays = await getFileSetting(db, 'files.retention_days');
        const expiresAt = retentionDays ? new Date(Date.now() + retentionDays * 86400000) : null;

        // Quota check using SEPARATE pool client
        const pool = app.db;
        const quotaClient = await pool.connect();
        try {
            await quotaClient.query('BEGIN');
            await quotaClient.query("SELECT pg_advisory_xact_lock(hashtext('storage_quota'))");

            const quota = await getFileSetting(db, 'files.storage_quota_bytes');
            if (quota) {
                const totalRes = await quotaClient.query('SELECT COALESCE(SUM(size_bytes), 0) as total FROM files WHERE deleted_at IS NULL');
                if ((Number(totalRes.rows[0].total) + processedBuffer.length) > quota) {
                    await quotaClient.query('ROLLBACK');
                    quotaClient.release();
                    return reply.status(507).send({ error: 'Instance storage quota exceeded' });
                }
            }

            // Insert metadata within quota transaction
            await quotaClient.query(
                `INSERT INTO files (id, uploader_id, channel_id, filename, content_type, mime_type, size_bytes, bucket, path, storage_key, encryption_iv, encryption_tag, width, height, expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
                [fileId, userId, channelId, sanitizedName, detectedMime, detectedMime, processedBuffer.length, BUCKET_NAME, storageKey, storageKey, iv, authTag, width ?? null, height ?? null, expiresAt]
            );

            await quotaClient.query('COMMIT');
        } catch (err) {
            await quotaClient.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            quotaClient.release();
        }

        // Upload encrypted blob to MinIO
        try {
            await minioClient.putObject(BUCKET_NAME, storageKey, encrypted, encrypted.length, {
                'Content-Type': 'application/octet-stream',
            });
        } catch {
            // Compensating cleanup: delete the metadata row if MinIO upload fails
            const cleanupClient = await pool.connect();
            try {
                await cleanupClient.query('DELETE FROM files WHERE id = $1', [fileId]);
            } finally {
                cleanupClient.release();
            }
            return reply.status(502).send({ error: 'Failed to store file' });
        }

        return reply.status(201).send({
            id: fileId,
            name: sanitizedName,
            mime: detectedMime,
            size: processedBuffer.length,
            width: width ?? null,
            height: height ?? null,
            url: `/files/${fileId}`,
        });
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

        // Fetch encrypted blob from MinIO
        let encryptedBuffer: Buffer;
        try {
            const stream = await minioClient.getObject(BUCKET_NAME, file.storage_key.trim());
            encryptedBuffer = await streamToBuffer(stream);
        } catch (err: any) {
            if (err.code === 'NoSuchKey') {
                // Orphan row: soft-delete metadata
                await db.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [fileId]);
                return reply.status(404).send({ error: 'File not found' });
            }
            throw err;
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

        // Delete from MinIO (best-effort)
        try {
            await minioClient.removeObject(BUCKET_NAME, file.storage_key.trim());
        } catch {
            // Log but don't fail — cleanup worker can handle orphaned objects
        }

        return reply.status(200).send({ deleted: true });
    });
}

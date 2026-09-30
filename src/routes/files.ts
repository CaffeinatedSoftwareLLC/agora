import { FastifyInstance } from 'fastify';
import path from 'path';
import { generateUlid } from '../utils/ulid';
import { computePermissions, Permissions } from '../permissions';
import { checkChannelMembership } from './shared';
import { storage } from '../lib/storage';
import { encryptFile, decryptFile } from '../lib/encryption';
import { INLINE_SAFE_MIMES } from '../lib/file-validation';
import { storeFile } from '../lib/file-store';
import { encodeRfc5987 } from '../lib/http-utils';
import { config } from '../config';


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

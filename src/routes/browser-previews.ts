import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { asService } from '../lib/agent-sessions';
import { canViewChannel } from '../lib/channel-access';
import { stampAuthority } from '../lib/direct-agents';
import { hashClaimToken, postNotice } from '../lib/agent-runs';
import { storeFile, getFileSetting, readUploadPart } from '../lib/file-store';
import { IMAGE_MIMES, validateFileType } from '../lib/file-validation';
import { sanitizeMessageText } from '../lib/sanitize-text';
import { storage } from '../lib/storage';
import { decryptFile } from '../lib/encryption';
import { config } from '../config';
import { generateUlid } from '../utils/ulid';
import { PLAN_OWNER_ONLY, PLAN_OWNER_SQL, SUBSCRIPTION_OWNER_ONLY } from '../lib/provider-terms';

const ID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } as const;
/** Seconds the host has to screenshot and upload before the claim expires. */
const LEASE_SECONDS = 90;
/** A preview no host claimed in this long fails, so the session isn't blocked forever. */
const UNCLAIMED_SECONDS = 120;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Only http(s) on a loopback name with an explicit port, no credentials. The host further
 * limits the port to the session's own range (agora-host src/preview.ts); this check keeps
 * anything else out of the queue. Returns the normalized URL or null.
 */
export function previewUrl(raw: string): string | null {
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (!/^https?:$/.test(u.protocol) || !LOOPBACK.has(u.hostname) || !u.port || u.username || u.password) return null;
    return u.href.length <= 2048 ? u.href : null;
}

function emit(request: FastifyRequest, room: string, event: string, data: unknown) {
    (request.pendingEvents ??= []).push({ room, event, data });
}

/** Fail previews nobody claimed and claims whose lease ran out (no screenshot is replayed). */
async function expireStale(db: any, where: string, args: unknown[]) {
    await db.query(`UPDATE browser_previews SET status = 'failed', finished_at = NOW(),
            result = jsonb_build_object('error', CASE WHEN status = 'queued' THEN 'host_did_not_claim' ELSE 'host_timeout' END)
        WHERE ${where} AND ((status = 'queued' AND created_at < NOW() - make_interval(secs => ${UNCLAIMED_SECONDS}))
            OR (status = 'claimed' AND lease_until < NOW()))`, args);
}

const view = (r: any) => ({
    id: r.id.trim(), sessionId: r.session_id.trim(), channelId: r.channel_id.trim(), threadId: r.thread_id?.trim() ?? null,
    url: r.url, status: r.status, result: r.result, messageId: r.message_id?.trim() ?? null, fileId: r.file_id?.trim() ?? null,
    createdAt: r.created_at, finishedAt: r.finished_at,
});

/**
 * Browser preview (docs/canvas-and-preview.md): a screenshot and console log of a page a
 * hosted session serves on localhost. The session's own agent or a director queues it; the
 * session's host claims it, renders the page in a headless browser and posts the image back.
 */
export async function browserPreviewRoutes(app: FastifyInstance) {
    app.post('/channels/:id/browser-previews', { schema: {
        params: { type: 'object', properties: { id: ID } },
        body: { type: 'object', additionalProperties: false, required: ['url'], properties: {
            url: { type: 'string', minLength: 1, maxLength: 2048 },
            sessionId: ID, threadId: ID,
            width: { type: 'integer', minimum: 320, maximum: 1920 },
            height: { type: 'integer', minimum: 240, maximum: 1600 },
            fullPage: { type: 'boolean' },
        } },
    } }, async (request, reply) => {
        const { id: channelId } = request.params as any, b = request.body as any, db = request.dbClient!;
        if (!(await canViewChannel(db, channelId, request.userId, !!request.isBot)).allowed) return reply.status(403).send({ error: 'forbidden' });
        const url = previewUrl(b.url);
        if (!url) return reply.status(400).send({ error: 'url_not_allowed', detail: 'Use http://localhost:<port>/… (or 127.0.0.1 / [::1]) served by the session' });
        // A bot previews its own session only; a person needs to direct agents here
        if (!request.isBot && (!b.sessionId || !await stampAuthority(db, channelId, request.userId, false))) {
            return reply.status(b.sessionId ? 403 : 400).send({ error: b.sessionId ? 'cannot_direct' : 'session_required' });
        }
        const r = await asService(db, async () => {
            const s = (await db.query(`SELECT s.id, s.bot_id, s.state, p.host_id, p.generation, p.auth_mode,
                (s.started_by IS NOT NULL AND s.started_by = ${PLAN_OWNER_SQL}) AS started_by_owner
                FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id JOIN servers srv ON srv.id = s.server_id
                WHERE s.channel_id = $1 AND s.state = 'live' AND ${request.isBot ? 's.bot_id = $2' : 's.id = $2'}
                ORDER BY s.id DESC LIMIT 1 FOR UPDATE OF s`, [channelId, request.isBot ? request.userId : b.sessionId])).rows[0];
            if (!s || (request.isBot && b.sessionId && s.id.trim() !== b.sessionId)) return { status: 409, body: { error: 'no_live_hosted_session' } };
            // A bot on a personal plan acts only inside a session its plan owner started (provider-terms.ts)
            if (request.isBot && s.auth_mode !== 'api_key' && !s.started_by_owner) {
                return { status: 403, body: { error: s.auth_mode === 'siwc' ? PLAN_OWNER_ONLY : SUBSCRIPTION_OWNER_ONLY } };
            }
            if (!(await db.query('SELECT 1 FROM agent_hosts WHERE id = $1 AND revoked_at IS NULL', [s.host_id])).rows.length) return { status: 409, body: { error: 'host_unavailable' } };
            if (b.threadId) {
                const parent = (await db.query('SELECT thread_id, thread_closed_at FROM messages WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL', [b.threadId, channelId])).rows[0];
                if (!parent || parent.thread_id) return { status: 404, body: { error: 'thread_not_found' } };
                if (parent.thread_closed_at) return { status: 409, body: { error: 'thread_closed' } };
            }
            await expireStale(db, 'session_id = $1', [s.id]);
            const id = generateUlid();
            const inserted = await db.query(`INSERT INTO browser_previews (id, session_id, channel_id, thread_id, host_id, profile_generation, requested_by, url, options)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (session_id) WHERE status IN ('queued', 'claimed') DO NOTHING RETURNING id`,
                [id, s.id, channelId, b.threadId ?? null, s.host_id, s.generation, request.userId, url,
                    { width: b.width ?? 1280, height: b.height ?? 800, fullPage: b.fullPage ?? false }]);
            if (!inserted.rows.length) return { status: 409, body: { error: 'preview_in_progress' } };
            return { status: 202, body: { id, sessionId: s.id.trim(), url, status: 'queued' } };
        });
        return reply.status(r.status).send(r.body);
    });

    app.get('/channels/:id/browser-previews/:previewId', { schema: { params: { type: 'object', properties: { id: ID, previewId: ID } } } }, async (request, reply) => {
        const { id: channelId, previewId } = request.params as any, db = request.dbClient!;
        if (!(await canViewChannel(db, channelId, request.userId, !!request.isBot)).allowed) return reply.status(403).send({ error: 'forbidden' });
        const row = await asService(db, async () => {
            await expireStale(db, 'id = $1 AND channel_id = $2', [previewId, channelId]);
            return (await db.query('SELECT * FROM browser_previews WHERE id = $1 AND channel_id = $2', [previewId, channelId])).rows[0];
        });
        return row ? view(row) : reply.status(404).send({ error: 'not_found' });
    });

    // The screenshot a finished preview posted, for the agent that asked (bots can't download files)
    app.get('/channels/:id/browser-previews/:previewId/screenshot', { schema: { params: { type: 'object', properties: { id: ID, previewId: ID } } } }, async (request, reply) => {
        const { id: channelId, previewId } = request.params as any, db = request.dbClient!;
        if (!(await canViewChannel(db, channelId, request.userId, !!request.isBot)).allowed) return reply.status(403).send({ error: 'forbidden' });
        const file = (await asService(db, () => db.query(`SELECT f.storage_key, f.encryption_iv, f.encryption_tag FROM browser_previews p
            JOIN files f ON f.id = p.file_id AND f.deleted_at IS NULL WHERE p.id = $1 AND p.channel_id = $2`, [previewId, channelId]))).rows[0];
        const blob = file && await storage.get(file.storage_key.trim());
        if (!blob) return reply.status(404).send({ error: 'not_found' });
        return reply.header('content-type', 'image/png').header('cache-control', 'private, no-store')
            .send(decryptFile(blob, config.encryptionKey, file.encryption_iv, file.encryption_tag));
    });

    // ─── Host routes (AgentHost token) ───

    app.get('/agent-hosts/@me/browser-previews/next', async (request, reply) => {
        const db = request.dbClient!, host = request.agentHost!;
        const r = await asService(db, async () => {
            if (!(await db.query('SELECT 1 FROM agent_hosts WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL FOR SHARE', [host.id, host.serverId])).rows.length) return { status: 401, body: { error: 'host_revoked' } };
            await expireStale(db, 'host_id = $1', [host.id]);
            const candidates = (await db.query(`SELECT p.id FROM browser_previews p JOIN agent_sessions s ON s.id = p.session_id
                WHERE p.host_id = $1 AND s.server_id = $2 AND p.status = 'queued' ORDER BY p.id LIMIT 20`, [host.id, host.serverId])).rows;
            for (const candidate of candidates) {
                const p = (await db.query(`SELECT * FROM browser_previews WHERE id = $1 AND status = 'queued' FOR UPDATE SKIP LOCKED`, [candidate.id])).rows[0];
                if (!p) continue;
                const s = (await db.query(`SELECT s.id, s.state, s.bot_id, p.name AS profile, p.host_id, p.generation, p.workdir_alias
                    FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id WHERE s.id = $1`, [p.session_id])).rows[0];
                // The request is re-checked at claim: the session, its binding and the requester's standing
                const requester = p.requested_by.trim();
                const allowed = s?.state === 'live' && s.host_id.trim() === host.id && s.generation === p.profile_generation
                    && (requester === s.bot_id.trim() || await stampAuthority(db, p.channel_id.trim(), requester, false));
                if (!allowed) {
                    await db.query(`UPDATE browser_previews SET status = 'failed', result = '{"error":"binding_or_authority_changed"}', finished_at = NOW() WHERE id = $1`, [p.id]);
                    continue;
                }
                const token = randomBytes(32).toString('hex');
                await db.query(`UPDATE browser_previews SET status = 'claimed', claim_token_hash = $2, lease_until = NOW() + make_interval(secs => ${LEASE_SECONDS}) WHERE id = $1`,
                    [p.id, hashClaimToken(token)]);
                return { status: 200, body: { id: p.id.trim(), claimToken: token, sessionId: s.id.trim(), profile: s.profile, workdirAlias: s.workdir_alias,
                    url: p.url, options: p.options, leaseSeconds: LEASE_SECONDS } };
            }
            return { status: 204 };
        });
        return r.status === 204 ? reply.status(204).send() : reply.status(r.status).send(r.body);
    });

    // Multipart: the text fields first, then the PNG screenshot (left out when it failed)
    app.post('/agent-hosts/@me/browser-previews/:previewId/result', { schema: { params: { type: 'object', properties: { previewId: ID } } } }, async (request, reply) => {
        const db = request.dbClient!, host = request.agentHost!, { previewId } = request.params as any;
        if (!request.isMultipart()) return reply.status(415).send({ error: 'multipart_required' });
        const maxBytes = Number(await getFileSetting(db, 'files.max_size_bytes'));
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return reply.status(503).send({ error: 'file_size_limit_required' });
        const fields: Record<string, string> = {};
        let image: Buffer | null = null;
        try {
            for await (const part of request.parts({ limits: { fileSize: maxBytes, files: 1, fields: 8, fieldSize: 64 * 1024 } })) {
                if (part.type === 'file') {
                    image = await readUploadPart(part);
                    if (!image) return reply.status(413).send({ error: 'upload_too_large' });
                } else if (typeof part.value === 'string') fields[part.fieldname] = part.value;
            }
        } catch { return reply.status(413).send({ error: 'upload_too_large' }); }

        let consoleLines: { level: string; text: string }[] = [];
        try {
            const parsed = JSON.parse(fields.console ?? '[]');
            if (!Array.isArray(parsed)) throw new Error();
            consoleLines = parsed.slice(0, 100).map((l: any) => ({
                level: ['error', 'warning', 'info', 'log', 'debug'].includes(l?.level) ? l.level : 'log',
                text: sanitizeMessageText(String(l?.text ?? '')).slice(0, 500),
            }));
        } catch { return reply.status(400).send({ error: 'invalid_console' }); }
        const success = fields.success === 'true';
        const error = /^[a-z][a-z_]{0,100}$/.test(fields.error ?? '') ? fields.error : (success ? undefined : 'preview_failed');
        const title = sanitizeMessageText(fields.title ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200);
        if (success && !image) return reply.status(400).send({ error: 'screenshot_required' });

        const r = await asService(db, async () => {
            if (!(await db.query('SELECT 1 FROM agent_hosts WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL FOR SHARE', [host.id, host.serverId])).rows.length) return { status: 401, body: { error: 'host_revoked' } };
            const p = (await db.query(`SELECT b.*, b.lease_until <= NOW() AS expired, s.bot_id, s.state FROM browser_previews b JOIN agent_sessions s ON s.id = b.session_id
                WHERE b.id = $1 AND b.host_id = $2 AND s.server_id = $3 FOR UPDATE OF b`, [previewId, host.id, host.serverId])).rows[0];
            if (!p) return { status: 404, body: { error: 'not_found' } };
            if (p.claim_token_hash !== hashClaimToken(fields.claimToken ?? '')) return { status: 409, body: { error: 'stale_claim' } };
            if (['succeeded', 'failed'].includes(p.status)) return { status: 200, body: { ok: true, repeated: true } };
            if (p.status !== 'claimed' || p.expired) return { status: 409, body: { error: 'lease_expired' } };
            const channelId = p.channel_id.trim(), botId = p.bot_id.trim();
            const result = { ...(error ? { error } : {}), ...(title ? { title } : {}), console: consoleLines };
            if (!success) {
                await db.query(`UPDATE browser_previews SET status = 'failed', result = $2, finished_at = NOW() WHERE id = $1`, [p.id, result]);
                const n = await postNotice(db, channelId, `Browser preview of ${p.url} failed: ${error}`);
                emit(request, `channel:${n.channelId}`, 'Message', n.event);
                return { status: 200, body: { ok: true } };
            }
            // A PNG from the host only; storeFile validates it again against the instance allowlist
            try {
                const type = await validateFileType(image!, 'png', ['png']);
                if (!IMAGE_MIMES.includes(type.mime)) return { status: 415, body: { error: 'png_required' } };
            } catch { return { status: 415, body: { error: 'png_required' } }; }
            const stored = await storeFile(db, app.db, { buffer: image!, filename: `preview-${p.id.trim()}.png`, uploaderId: botId, channelId });
            if (!stored.ok) {
                await db.query(`UPDATE browser_previews SET status = 'failed', result = $2, finished_at = NOW() WHERE id = $1`,
                    [p.id, { ...result, error: 'screenshot_not_stored' }]);
                const n = await postNotice(db, channelId, `Browser preview of ${p.url} could not be stored: ${stored.error}`);
                emit(request, `channel:${n.channelId}`, 'Message', n.event);
                return { status: 200, body: { ok: true, stored: false } };
            }
            const messageId = generateUlid(), threadId = p.thread_id?.trim() ?? null;
            const content = previewMessage(p.url, title, consoleLines);
            // Posted as the session's agent without routing it: a screenshot wakes nobody
            await db.query(`INSERT INTO messages (id, channel_id, author_id, content, thread_id) VALUES ($1, $2, $3, $4, $5)`,
                [messageId, channelId, botId, content, threadId]);
            await db.query('UPDATE files SET message_id = $1 WHERE id = $2', [messageId, stored.file.id]);
            await db.query(`UPDATE browser_previews SET status = 'succeeded', result = $2, finished_at = NOW(), message_id = $3, file_id = $4 WHERE id = $1`,
                [p.id, result, messageId, stored.file.id]);
            const author = (await db.query('SELECT username, avatar_url FROM users WHERE id = $1', [botId])).rows[0];
            emit(request, `channel:${channelId}`, 'Message', {
                id: messageId, content, authorId: botId, authorUsername: author.username, authorBot: true, authorAvatarUrl: author.avatar_url ?? null,
                channelId, createdAt: new Date().toISOString(), mentions: [], mentionsEveryone: false, attachments: [stored.file],
                ...(threadId ? { threadId } : {}),
            });
            if (threadId) {
                const parent = (await db.query(`UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW() WHERE id = $1
                    RETURNING reply_count, last_reply_at, thread_closed_at`, [threadId])).rows[0];
                emit(request, `channel:${channelId}`, 'ThreadMetadataUpdate', { channelId, messageId: threadId, replyCount: parent.reply_count,
                    lastReplyAt: parent.last_reply_at, threadClosedAt: parent.thread_closed_at ?? null });
            }
            return { status: 201, body: { ok: true, messageId, fileId: stored.file.id } };
        });
        return reply.status(r.status).send(r.body);
    });
}

/** The chat post that carries the screenshot: the URL, page title and a console digest. */
export function previewMessage(url: string, title: string, lines: { level: string; text: string }[]): string {
    const errors = lines.filter(l => l.level === 'error').length, warnings = lines.filter(l => l.level === 'warning').length;
    const head = `Browser preview of ${url}${title ? ` (“${title}”)` : ''}. Console: ${errors} error(s), ${warnings} warning(s)${lines.length ? `, ${lines.length} line(s)` : ''}.`;
    if (!lines.length) return head;
    let body = '';
    for (const l of lines) {
        const next = `${l.level.toUpperCase()}: ${l.text.replace(/```/g, "'''")}\n`;
        if (head.length + body.length + next.length > 3800) { body += '…\n'; break; }
        body += next;
    }
    return `${head}\n\`\`\`\n${body}\`\`\``;
}

import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { requireAdmin } from './ai-config';
import { auditAiChange, changedFields } from '../lib/ai-audit';
import { checkChannelPermissions } from '../lib/channel-access';
import { Permissions } from '../permissions';
import { checkBudget, recordUsage, resolveRoute, type ResolvedRoute } from '../ai/routing';
import { TRANSCRIBABLE_MIME_TYPES } from '../ai/adapters/openai';
import { pcmToMp3, wavToPcm } from '../ai/mp3';
import {
    VOICE_COLUMNS, cacheSpeech, cachedSpeech, loadVoiceSettings, mentionedIds, speakableText,
    voiceEngines, voiceRouteStates, voiceSettingsFromRow, type VoiceSettings,
} from '../ai/voice';

/**
 * Voice in and out (docs/voice.md). Admins choose the engines (the `stt` and `tts`
 * capability routes, plus browser fallbacks); members record a clip to transcribe
 * into the composer and have messages read aloud.
 */

/** The Audio API's upload limit; a 10-minute Opus clip is a few MB. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/**
 * Upper bound on the audio a recording of `seconds` can need: 128 KB/s covers 48 kHz 16-bit
 * mono WAV, far above the Opus/AAC a browser records (~4-16 KB/s), plus room for container headers.
 */
const AUDIO_BYTES_PER_SECOND = 128 * 1024;
const AUDIO_MARGIN_BYTES = 256 * 1024;
export function audioByteCap(maxRecordingSeconds: number): number {
    return Math.min(MAX_AUDIO_BYTES, maxRecordingSeconds * AUDIO_BYTES_PER_SECOND + AUDIO_MARGIN_BYTES);
}

/** The container the first bytes say this is (webm, ogg, wav, mp3, m4a/aac, flac), or null. */
export function sniffAudio(b: Buffer): string | null {
    if (b.length < 12) return null;
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
    if (b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
    if (b.toString('latin1', 0, 4) === 'fLaC') return 'flac';
    if (b.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
    if (b.toString('latin1', 0, 3) === 'ID3') return 'mp3';
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3'; // MPEG/ADTS frame sync
    return null;
}

/** Read-aloud audio is sent as MP3 (a phone may be on mobile data); speech needs little. */
const SPEECH_MP3_KBPS = 48;

const settingsSchema = {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: {
        voiceInputEnabled: { type: 'boolean' },
        browserSttFallback: { type: 'boolean' },
        maxRecordingSeconds: { type: 'integer', minimum: 5, maximum: 600 },
        sttLanguage: { type: ['string', 'null'], pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$' },
        readAloudEnabled: { type: 'boolean' },
        readAloudServer: { type: 'boolean' },
        browserTtsFallback: { type: 'boolean' },
        readAloudVoice: { type: ['string', 'null'], pattern: '^[A-Za-z0-9_.:+-]{1,64}$' },
        readAloudMaxChars: { type: 'integer', minimum: 100, maximum: 4000 },
    },
};

async function adminView(db: any, serverId: string, settings: VoiceSettings) {
    const routes = await voiceRouteStates(db, serverId);
    const warnings: string[] = [];
    if (settings.readAloudServer && !routes.tts.enabled) {
        warnings.push('Read-aloud is set to use the server\'s Speech route, but no Speech route is configured and enabled. Members get their browser\'s voices instead (if allowed) or nothing.');
    }
    if (settings.voiceInputEnabled && !routes.stt.enabled && !settings.browserSttFallback) {
        warnings.push('Voice input is on, but there is no enabled Transcription route and the browser fallback is off, so members have no microphone button.');
    }
    return { ...settings, routes, engines: voiceEngines(settings, routes), warnings };
}

/** A person (not a bot) who may see the channel; returns its server, or replies with the refusal. */
async function channelForVoice(request: FastifyRequest, reply: FastifyReply, perms: bigint): Promise<string | null> {
    if (request.isBot) { reply.status(403).send({ error: 'Voice is for people, not bots' }); return null; }
    const { id: channelId } = request.params as { id: string };
    const db = request.dbClient!;
    const access = await checkChannelPermissions(db, channelId, request.userId, perms);
    if (!access.allowed) { reply.status(access.status ?? 403).send({ error: access.error ?? 'forbidden' }); return null; }
    const channel = await db.query('SELECT server_id FROM channels WHERE id = $1', [channelId]);
    const serverId = channel.rows[0]?.server_id?.trim();
    if (!serverId) { reply.status(409).send({ error: 'Voice needs a server channel', code: 'voice_unavailable' }); return null; }
    return serverId;
}

/** Resolve a voice route and its budget; replies with the refusal when it can't be used. */
async function voiceRoute(db: any, reply: FastifyReply, serverId: string, capability: 'stt' | 'tts', opts: { budget?: boolean } = {}): Promise<ResolvedRoute | null> {
    const resolved = await resolveRoute(db, serverId, capability);
    if (!resolved.ok) { reply.status(503).send({ error: resolved.error, code: 'voice_unavailable' }); return null; }
    if (opts.budget !== false && !(await withinBudget(db, reply, resolved.value))) return null;
    return resolved.value;
}

/** The route's daily limits; replies 429 when one is spent. */
async function withinBudget(db: any, reply: FastifyReply, resolved: ResolvedRoute): Promise<boolean> {
    const budget = await checkBudget(db, resolved.route);
    if (!budget.ok) { reply.status(429).send({ error: budget.error, code: 'budget_exceeded' }); return false; }
    return true;
}

/**
 * Provider calls can take a while: don't hold the request's transaction (and its pool
 * connection) open across them. Commits what the handler has done and gives the client back.
 */
async function releaseRequestClient(request: FastifyRequest) {
    const client = request.dbClient;
    if (!client) return;
    request.dbClient = null;
    try {
        await client.query('COMMIT');
        request.txCommitted = true;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        request.txCommitted = false;
        request.txFailure = err;
        client.release(err instanceof Error ? err : true);
        throw err;
    }
    client.release();
}

/** Record usage in its own short transaction once the request's client has been released. */
async function recordUsageFresh(app: FastifyInstance, rec: Parameters<typeof recordUsage>[1]) {
    const client = await (app as any).db.connect();
    try {
        await client.query('BEGIN');
        await recordUsage(client, rec);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function voiceRoutes(app: FastifyInstance) {
    // Rate limits run twice: by address at onRequest (before auth knows the user), and by user
    // in preHandler, which is after auth has set request.userId. Off when rate limiting is off.
    const limitedBy = (name: string, ipMax: number, userMax: number) => {
        const check = (app as any).createRateLimit
            ? (app as any).createRateLimit({ max: userMax, timeWindow: '1 minute', keyGenerator: (r: any) => `${name}:${r.userId ?? r.ip}` })
            : null;
        return {
            config: { rateLimit: { max: ipMax, timeWindow: '1 minute' } },
            // The plugin's own handler skips a request it already counted at onRequest, so count by user directly
            preHandler: check ? [async (request: FastifyRequest, reply: FastifyReply) => {
                const r = await check(request);
                if (r.isAllowed || !r.isExceeded) return;
                return reply.status(429).header('Retry-After', String(r.ttlInSeconds)).send({ error: 'Rate limit exceeded, retry later', code: 'rate_limited' });
            }] : [],
        };
    };

    // Recorded clips arrive as the raw body (audio/webm, audio/mp4, ...). Scoped to this plugin.
    app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES }, (_request, body, done) => done(null, body));

    // ─── Admin: engines and switches ───

    // GET /servers/:serverId/ai/voice → settings, the stt/tts routes' state, the engines members get
    app.get('/servers/:serverId/ai/voice', { preHandler: [requireAdmin] }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;
        return reply.send(await adminView(db, serverId, await loadVoiceSettings(db, serverId)));
    });

    // PATCH /servers/:serverId/ai/voice → change any subset (the row is created on first write)
    app.patch('/servers/:serverId/ai/voice', { preHandler: [requireAdmin], schema: { body: settingsSchema } }, async (request, reply) => {
        const { serverId } = request.params as any;
        const body = request.body as Partial<VoiceSettings>;
        const db = request.dbClient!;

        const keys = (Object.keys(body) as (keyof VoiceSettings)[]).filter(k => k in VOICE_COLUMNS);
        if (keys.length === 0) return reply.status(400).send({ error: 'No recognised settings to change' });

        await db.query('INSERT INTO ai_voice_settings (server_id) VALUES ($1) ON CONFLICT DO NOTHING', [serverId]);
        const current = await db.query('SELECT * FROM ai_voice_settings WHERE server_id = $1 FOR UPDATE', [serverId]);
        const before = voiceSettingsFromRow(current.rows[0]);

        const params: unknown[] = keys.map(k => body[k]);
        const sets = keys.map((k, i) => `${VOICE_COLUMNS[k]} = $${i + 1}`);
        params.push(serverId);
        const updated = await db.query(
            `UPDATE ai_voice_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE server_id = $${params.length} RETURNING *`,
            params
        );
        const after = voiceSettingsFromRow(updated.rows[0]);

        const changed = changedFields(before as any, after as any);
        if (changed.length > 0) {
            await auditAiChange(db, request, {
                serverId, action: 'ai_voice_update', targetType: 'ai_voice', targetId: null,
                changes: {
                    before: Object.fromEntries(changed.map(k => [k, (before as any)[k]])),
                    after: Object.fromEntries(changed.map(k => [k, (after as any)[k]])),
                    changed,
                },
            });
        }
        return reply.send(await adminView(db, serverId, after));
    });

    // ─── Members ───

    // GET /channels/:id/voice → which engine the client uses for input and output, and their limits
    app.get('/channels/:id/voice', async (request, reply) => {
        const serverId = await channelForVoice(request, reply, Permissions.ViewChannel);
        if (!serverId) return reply;
        const db = request.dbClient!;
        const settings = await loadVoiceSettings(db, serverId);
        const engines = voiceEngines(settings, await voiceRouteStates(db, serverId));
        return reply.send({
            input: engines.input,
            output: engines.output,
            maxRecordingSeconds: settings.maxRecordingSeconds,
            language: settings.sttLanguage,
            maxChars: settings.readAloudMaxChars,
        });
    });

    // POST /channels/:id/voice/transcribe (raw audio body) → 200 { text }
    app.post('/channels/:id/voice/transcribe', {
        bodyLimit: MAX_AUDIO_BYTES,
        ...limitedBy('transcribe', 300, 30),
        // The cap follows the server's recording limit; refuse on Content-Length, then while the body streams
        preParsing: async (request, _reply, payload) => {
            let cap = audioByteCap(120);
            try {
                const row = await request.dbClient?.query(
                    `SELECT v.max_recording_seconds FROM ai_voice_settings v JOIN channels c ON c.server_id = v.server_id WHERE c.id = $1`,
                    [(request.params as any).id]
                );
                if (row?.rows[0]) cap = audioByteCap(row.rows[0].max_recording_seconds);
            } catch { /* the default cap still applies */ }
            const tooBig = () => Object.assign(new Error(`The recording is too long (limit ${Math.round(cap / 1024)} KB)`), { statusCode: 413 });
            const declared = Number(request.headers['content-length']);
            if (Number.isFinite(declared) && declared > cap) throw tooBig();
            let seen = 0;
            const limiter = new Transform({
                transform(chunk, _enc, cb) {
                    seen += chunk.length;
                    if (seen > cap) return cb(tooBig());
                    cb(null, chunk);
                },
            });
            payload.on('error', e => limiter.destroy(e));
            return payload.pipe(limiter);
        },
    }, async (request, reply) => {
        const serverId = await channelForVoice(request, reply, Permissions.ViewChannel | Permissions.SendMessages);
        if (!serverId) return reply;
        const db = request.dbClient!;

        const mime = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!TRANSCRIBABLE_MIME_TYPES.includes(mime) || !Buffer.isBuffer(request.body)) {
            return reply.status(415).send({ error: `Send the recording as one of: ${TRANSCRIBABLE_MIME_TYPES.join(', ')}` });
        }
        const audio = request.body as Buffer;
        if (audio.length === 0) return reply.status(400).send({ error: 'The recording is empty' });
        if (!sniffAudio(audio)) return reply.status(415).send({ error: 'That is not a recognised audio recording (webm, ogg, wav, mp3, m4a or flac)' });

        const settings = await loadVoiceSettings(db, serverId);
        if (!settings.voiceInputEnabled) return reply.status(403).send({ error: 'Voice input is turned off on this server', code: 'voice_off' });
        const route = await voiceRoute(db, reply, serverId, 'stt');
        if (!route) return reply;

        const channelId = (request.params as any).id as string;
        const userId = request.userId;
        await releaseRequestClient(request);

        const started = Date.now();
        let error: string | null = null;
        let result: Awaited<ReturnType<NonNullable<typeof route.adapter.transcribe>>> | null = null;
        try {
            result = await route.adapter.transcribe!(route.credentials, {
                // The Audio API takes ISO 639-1 only ("pt", not "pt-BR")
                model: route.model, audio, mime, language: settings.sttLanguage?.split('-')[0],
                signal: AbortSignal.timeout(config.voiceProviderTimeoutMs),
            });
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
        await recordUsageFresh(app, {
            serverId, capability: 'stt', providerId: route.providerId, adapter: route.adapter.id, model: route.model,
            route: route.route, usage: result?.usage ?? { inputTokens: 0, outputTokens: 0 },
            latencyMs: Date.now() - started, channelId, userId, error,
        });
        if (!result) return reply.status(502).send({ error: error ?? 'Transcription failed', code: 'provider_error' });
        return reply.send({ text: result.text });
    });

    // POST /channels/:id/messages/:msgId/speech → audio (MP3 when the engine returns WAV)
    app.post('/channels/:id/messages/:msgId/speech', {
        ...limitedBy('speech', 600, 60),
    }, async (request, reply) => {
        const serverId = await channelForVoice(request, reply, Permissions.ViewChannel);
        if (!serverId) return reply;
        const { id: channelId, msgId } = request.params as { id: string; msgId: string };
        const db = request.dbClient!;

        const settings = await loadVoiceSettings(db, serverId);
        if (!settings.readAloudEnabled || !settings.readAloudServer) {
            return reply.status(403).send({ error: 'Read-aloud with the server\'s voice is turned off on this server', code: 'voice_off' });
        }

        const msg = await db.query(
            'SELECT content, deleted_at, system_event FROM messages WHERE id = $1 AND channel_id = $2',
            [msgId, channelId]
        );
        const row = msg.rows[0];
        if (!row || row.deleted_at) return reply.status(404).send({ error: 'Message not found' });
        if (row.system_event || !row.content?.trim()) return reply.status(422).send({ error: 'This message has nothing to read aloud', code: 'nothing_to_read' });

        // The budget is checked after the cache: replaying audio already made costs no provider call (#143)
        const route = await voiceRoute(db, reply, serverId, 'tts', { budget: false });
        if (!route) return reply;

        const voice = settings.readAloudVoice ?? undefined;
        // By content, not edited_at: the assistant fills in its streamed replies without marking them edited
        const contentHash = createHash('sha256').update(row.content).digest('base64url');
        const key = [msgId, contentHash, route.providerId, route.model, voice ?? '', settings.readAloudMaxChars].join('|');
        const hit = cachedSpeech(key);
        if (hit) return reply.header('Cache-Control', 'private, max-age=3600').type(hit.mime).send(hit.data);
        if (!(await withinBudget(db, reply, route))) return reply;

        const ids = mentionedIds(row.content);
        const names = new Map<string, string>();
        if (ids.length > 0) {
            const users = await db.query('SELECT id, username FROM users WHERE id = ANY($1)', [ids]);
            for (const u of users.rows) names.set(u.id.trim(), u.username);
        }
        const text = speakableText(row.content, settings.readAloudMaxChars, names);
        if (!text) return reply.status(422).send({ error: 'This message has nothing to read aloud', code: 'nothing_to_read' });

        const userId = request.userId;
        await releaseRequestClient(request);

        const started = Date.now();
        let error: string | null = null;
        let audio: { data: Buffer; mime: string } | null = null;
        let usage = { inputTokens: 0, outputTokens: 0 };
        try {
            const result = await route.adapter.tts!(route.credentials, {
                model: route.model, text, voice, signal: AbortSignal.timeout(config.voiceProviderTimeoutMs),
            });
            usage = result.usage;
            audio = result.mime === 'audio/wav'
                ? { data: pcmToMp3(wavToPcm(result.data), SPEECH_MP3_KBPS), mime: 'audio/mpeg' }
                : { data: result.data, mime: result.mime };
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
        await recordUsageFresh(app, {
            serverId, capability: 'tts', providerId: route.providerId, adapter: route.adapter.id, model: route.model,
            route: route.route, usage, latencyMs: Date.now() - started, channelId, userId, messageId: msgId, error,
        });
        if (!audio) return reply.status(502).send({ error: error ?? 'Speech failed', code: 'provider_error' });

        cacheSpeech(key, audio);
        return reply.header('Cache-Control', 'private, max-age=3600').type(audio.mime).send(audio.data);
    });
}

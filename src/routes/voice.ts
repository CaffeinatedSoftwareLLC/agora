import { createHash } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
async function voiceRoute(db: any, reply: FastifyReply, serverId: string, capability: 'stt' | 'tts'): Promise<ResolvedRoute | null> {
    const resolved = await resolveRoute(db, serverId, capability);
    if (!resolved.ok) { reply.status(503).send({ error: resolved.error, code: 'voice_unavailable' }); return null; }
    const budget = await checkBudget(db, resolved.value.route);
    if (!budget.ok) { reply.status(429).send({ error: budget.error, code: 'budget_exceeded' }); return null; }
    return resolved.value;
}

export async function voiceRoutes(app: FastifyInstance) {

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
        config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (request: any) => request.userId } },
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

        const settings = await loadVoiceSettings(db, serverId);
        if (!settings.voiceInputEnabled) return reply.status(403).send({ error: 'Voice input is turned off on this server', code: 'voice_off' });
        const route = await voiceRoute(db, reply, serverId, 'stt');
        if (!route) return reply;

        const started = Date.now();
        let error: string | null = null;
        let result: Awaited<ReturnType<NonNullable<typeof route.adapter.transcribe>>> | null = null;
        try {
            result = await route.adapter.transcribe!(route.credentials, {
                // The Audio API takes ISO 639-1 only ("pt", not "pt-BR")
                model: route.model, audio, mime, language: settings.sttLanguage?.split('-')[0],
            });
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
        await recordUsage(db, {
            serverId, capability: 'stt', providerId: route.providerId, adapter: route.adapter.id, model: route.model,
            route: route.route, usage: result?.usage ?? { inputTokens: 0, outputTokens: 0 },
            latencyMs: Date.now() - started, channelId: (request.params as any).id, userId: request.userId, error,
        });
        if (!result) return reply.status(502).send({ error: error ?? 'Transcription failed', code: 'provider_error' });
        return reply.send({ text: result.text });
    });

    // POST /channels/:id/messages/:msgId/speech → audio (MP3 when the engine returns WAV)
    app.post('/channels/:id/messages/:msgId/speech', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (request: any) => request.userId } },
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

        const route = await voiceRoute(db, reply, serverId, 'tts');
        if (!route) return reply;

        const voice = settings.readAloudVoice ?? undefined;
        // By content, not edited_at: the assistant fills in its streamed replies without marking them edited
        const contentHash = createHash('sha256').update(row.content).digest('base64url');
        const key = [msgId, contentHash, route.providerId, route.model, voice ?? '', settings.readAloudMaxChars].join('|');
        const hit = cachedSpeech(key);
        if (hit) return reply.header('Cache-Control', 'private, max-age=3600').type(hit.mime).send(hit.data);

        const ids = mentionedIds(row.content);
        const names = new Map<string, string>();
        if (ids.length > 0) {
            const users = await db.query('SELECT id, username FROM users WHERE id = ANY($1)', [ids]);
            for (const u of users.rows) names.set(u.id.trim(), u.username);
        }
        const text = speakableText(row.content, settings.readAloudMaxChars, names);
        if (!text) return reply.status(422).send({ error: 'This message has nothing to read aloud', code: 'nothing_to_read' });

        const started = Date.now();
        let error: string | null = null;
        let audio: { data: Buffer; mime: string } | null = null;
        let usage = { inputTokens: 0, outputTokens: 0 };
        try {
            const result = await route.adapter.tts!(route.credentials, { model: route.model, text, voice });
            usage = result.usage;
            audio = result.mime === 'audio/wav'
                ? { data: pcmToMp3(wavToPcm(result.data), SPEECH_MP3_KBPS), mime: 'audio/mpeg' }
                : { data: result.data, mime: result.mime };
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
        await recordUsage(db, {
            serverId, capability: 'tts', providerId: route.providerId, adapter: route.adapter.id, model: route.model,
            route: route.route, usage, latencyMs: Date.now() - started, channelId, userId: request.userId, messageId: msgId, error,
        });
        if (!audio) return reply.status(502).send({ error: error ?? 'Speech failed', code: 'provider_error' });

        cacheSpeech(key, audio);
        return reply.header('Cache-Control', 'private, max-age=3600').type(audio.mime).send(audio.data);
    });
}

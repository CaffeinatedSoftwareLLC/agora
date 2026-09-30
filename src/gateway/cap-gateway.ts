import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { CAPABILITIES, type Capability, type ConversationMessage, type Usage } from '../ai/adapters';
import { resolveRoute, checkBudget, recordUsage, type ResolvedRoute } from '../ai/routing';
import { storeFile } from '../lib/file-store';
import { publishEvents, type BridgedEvent } from '../lib/event-bridge';
import { hashToken } from '../runtime/runner';
import type { RunLimits } from '../runtime/limits';
import { tripBot, checkTokenMisuse } from '../runtime/tripwires';
import { postBotMessage, postSystemMessage, PostError } from './post-message';

/**
 * Capability gateway (WBS 3.4, sandbox-isolation-spec §3, §7, §11). The only service
 * sandboxes can reach. Authenticates the per-run bearer token, enforces declared
 * capabilities, per-run call and artifact caps, route budgets, and file limits, and
 * calls providers on the run's behalf — provider keys never enter the sandbox.
 */

export interface GatewayRun {
    runId: string;
    serverId: string;
    channelId: string | null;
    threadId: string | null;
    submittedBy: string;
    capabilities: string[];
    limits: RunLimits;
}

declare module 'fastify' {
    interface FastifyRequest {
        run?: GatewayRun;
    }
}

const MAX_FILE_BODY = 100 * 1024 * 1024; // hard cap; the instance file limit is checked by storeFile

type HandlerCtx = { run: GatewayRun; route: ResolvedRoute; input: any; db: Pool; publish: (events: BridgedEvent[]) => Promise<void> };
type Handler = (ctx: HandlerCtx) => Promise<{ status?: number; body: unknown }>;

export const IMAGE_ASPECT_RATIOS = ['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export const IMAGE_SIZES = ['512', '1K', '2K', '4K'];

/** Shared shape checks: a plain object with only `allowed` keys. */
function objectWith(input: any, allowed: string[]): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Body must be an object';
    const extra = Object.keys(input).find(k => !allowed.includes(k));
    return extra ? `Unknown field "${extra}"` : null;
}

const isText = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isName = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_ .-]{1,40}$/.test(v);

/** Input validation per capability; returns an error message or null. */
const VALIDATORS: Partial<Record<Capability, (input: any) => string | null>> = {
    chat: (input) => {
        const shape = objectWith(input, ['messages', 'system', 'maxTokens']);
        if (shape) return shape;
        const { messages, system, maxTokens } = input;
        if (!Array.isArray(messages) || messages.length < 1 || messages.length > 50) return 'messages must be an array of 1–50 items';
        for (const m of messages) {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'message role must be "user" or "assistant"';
            if (typeof m.content !== 'string' || m.content.length > 32000) return 'message content must be a string up to 32000 chars';
        }
        if (system !== undefined && (typeof system !== 'string' || system.length > 20000)) return 'system must be a string up to 20000 chars';
        if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096)) return 'maxTokens must be an integer 1–4096';
        return null;
    },
    search: (input) => {
        const shape = objectWith(input, ['query', 'maxResults']);
        if (shape) return shape;
        if (!isText(input.query, 2000)) return 'query must be a non-empty string up to 2000 chars';
        if (input.maxResults !== undefined && (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 20)) {
            return 'maxResults must be an integer 1–20';
        }
        return null;
    },
    image: (input) => {
        const shape = objectWith(input, ['prompt', 'aspectRatio', 'imageSize']);
        if (shape) return shape;
        if (!isText(input.prompt, 8000)) return 'prompt must be a non-empty string up to 8000 chars';
        if (input.aspectRatio !== undefined && !IMAGE_ASPECT_RATIOS.includes(input.aspectRatio)) return `aspectRatio must be one of ${IMAGE_ASPECT_RATIOS.join(', ')}`;
        if (input.imageSize !== undefined && !IMAGE_SIZES.includes(input.imageSize)) return `imageSize must be one of ${IMAGE_SIZES.join(', ')}`;
        return null;
    },
    tts: (input) => {
        const shape = objectWith(input, ['text', 'voice', 'speakers']);
        if (shape) return shape;
        if (!isText(input.text, 8000)) return 'text must be a non-empty string up to 8000 chars';
        if (input.voice !== undefined && !isName(input.voice)) return 'voice must be a voice name';
        if (input.speakers !== undefined) {
            if (input.voice !== undefined) return 'Use either voice or speakers, not both';
            if (!Array.isArray(input.speakers) || input.speakers.length < 1 || input.speakers.length > 2) return 'speakers must be an array of 1–2 items';
            for (const s of input.speakers) {
                if (!s || !isName(s.speaker) || !isName(s.voice) || Object.keys(s).length !== 2) return 'each speaker must be { speaker, voice }';
            }
        }
        return null;
    },
};

/** Run a provider call and record usage (success or failure) against the run. */
async function metered<T extends { usage: Usage }>(ctx: HandlerCtx, capability: Capability, call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const { run, route, db } = ctx;
    const started = Date.now();
    let value: T | null = null;
    let error: string | null = null;
    try {
        value = await call();
    } catch (err) {
        error = err instanceof Error ? err.message : String(err);
    }
    await recordUsage(db, {
        serverId: run.serverId, capability, providerId: route.providerId, adapter: route.adapter.id,
        model: route.model, route: route.route, usage: value?.usage ?? { inputTokens: 0, outputTokens: 0 },
        latencyMs: Date.now() - started, channelId: run.channelId, userId: run.submittedBy, runId: run.runId, error,
    });
    return value ? { ok: true, value } : { ok: false, error: error ?? 'Provider call failed' };
}

const providerError = (error: string) => ({ status: 502, body: { error, code: 'provider_error' } });

/** Capability implementations. `decide` and `video` come later. */
const HANDLERS: Partial<Record<Capability, Handler>> = {
    chat: async (ctx) => {
        const { route, input } = ctx;
        const result = await metered(ctx, 'chat', async () => {
            let text = '';
            let failure: Error | null = null;
            let usage: Usage = { inputTokens: 0, outputTokens: 0 };
            await route.adapter.streamChat!(
                route.credentials,
                { model: route.model, messages: input.messages as ConversationMessage[], systemPrompt: input.system, maxTokens: input.maxTokens ?? 1024 },
                {
                    onToken: (t) => { text += t; },
                    onDone: async (u) => { usage = u; },
                    onError: async (e) => { failure = e; },
                },
            );
            if (failure) throw failure;
            return { text, usage };
        });
        return result.ok ? { body: result.value } : providerError(result.error);
    },

    search: async (ctx) => {
        const { run, route, input, db } = ctx;
        const result = await metered(ctx, 'search', () =>
            route.adapter.search!(route.credentials, { model: route.model, query: input.query, maxResults: input.maxResults }));
        if (!result.ok) return providerError(result.error);
        const { answer, citations, display, usage } = result.value;
        if (!display) return { body: { answer, citations, usage } };

        // Gemini grounding terms: show the answer unmodified with Google's Search
        // Suggestions. The gateway posts that display into the run's thread itself.
        if (!run.channelId) return { status: 409, body: { error: 'This run has no channel to show grounded results in', code: 'no_channel' } };
        const { messageId, events } = await postSystemMessage(db, {
            channelId: run.channelId,
            threadId: run.threadId,
            systemEvent: 'runtime_search',
            systemData: { kind: 'runtime_search', runId: run.runId, query: input.query, citations, suggestionsHtml: display.html, queries: display.queries },
            content: answer,
        });
        await ctx.publish(events);
        return { body: { answer, citations, usage, displayedIn: messageId } };
    },

    image: async (ctx) => {
        const { route, input } = ctx;
        const result = await metered(ctx, 'image', () =>
            route.adapter.generateImage!(route.credentials, { model: route.model, prompt: input.prompt, aspectRatio: input.aspectRatio, imageSize: input.imageSize }));
        if (!result.ok) return providerError(result.error);
        const { data, mime, text, usage } = result.value;
        return { body: { data: data.toString('base64'), mime, ...(text ? { text } : {}), usage } };
    },

    tts: async (ctx) => {
        const { route, input } = ctx;
        const result = await metered(ctx, 'tts', () =>
            route.adapter.tts!(route.credentials, { model: route.model, text: input.text, voice: input.voice, speakers: input.speakers }));
        if (!result.ok) return providerError(result.error);
        const { data, mime, usage } = result.value;
        return { body: { data: data.toString('base64'), mime, usage } };
    },
};

function fail(reply: FastifyReply, status: number, code: string, error: string) {
    return reply.status(status).send({ error, code });
}

/** Atomically count one call against the run's cap. */
async function consumeCall(db: Pool, run: GatewayRun): Promise<boolean> {
    const res = await db.query(
        `UPDATE exec_runs SET capability_calls = capability_calls + 1
         WHERE id = $1 AND capability_calls < $2 RETURNING capability_calls`,
        [run.runId, run.limits.capabilityCalls]
    );
    return res.rows.length > 0;
}

export async function buildCapGateway(opts: { db: Pool; redis: Redis; logger?: boolean }): Promise<FastifyInstance> {
    const { db, redis } = opts;
    const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });

    /** Tripwires (3.8) must never turn a rejection into a 500; log and carry on. */
    async function trip(action: () => Promise<{ events: BridgedEvent[] } | null>) {
        try {
            const result = await action();
            if (result?.events.length) await publishEvents(redis, result.events);
        } catch (err) {
            app.log.error({ err }, 'Tripwire failed');
        }
    }

    /** Reserve one of the run's artifact slots; released if storing the file fails. */
    async function reserveArtifact(run: GatewayRun): Promise<boolean> {
        const reserved = await db.query(
            'UPDATE exec_runs SET artifact_count = artifact_count + 1 WHERE id = $1 AND artifact_count < $2 RETURNING artifact_count',
            [run.runId, run.limits.artifacts ?? 10]
        );
        return reserved.rows.length > 0;
    }

    async function releaseArtifact(run: GatewayRun) {
        await db.query('UPDATE exec_runs SET artifact_count = artifact_count - 1 WHERE id = $1', [run.runId]);
    }

    /** Count a call against the run's cap; at the cap, pause the bot and reply 429. */
    async function consumeOrTrip(run: GatewayRun, reply: FastifyReply): Promise<boolean> {
        if (await consumeCall(db, run)) return true;
        await trip(() => tripBot(db, run.runId, 'call_cap'));
        fail(reply, 429, 'call_limit', `Capability call limit reached (${run.limits.capabilityCalls} per run)`);
        return false;
    }

    app.get('/health', async () => ({ status: 'ok' }));

    async function authenticate(request: FastifyRequest, reply: FastifyReply) {
        const header = request.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!token.startsWith('art_')) return fail(reply, 401, 'unauthorized', 'Missing or malformed run token');

        const tokenHash = hashToken(token);
        const res = await db.query(
            `SELECT t.capabilities, r.id, r.server_id, r.channel_id, r.thread_id, r.submitted_by, r.limits,
                    u.bot_paused_at
             FROM exec_run_tokens t
             JOIN exec_runs r ON r.id = t.run_id
             LEFT JOIN users u ON u.id = r.submitted_by
             WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > NOW() AND r.status = 'running'`,
            [tokenHash]
        );
        const row = res.rows[0];
        if (!row) {
            // A real token outside its run's lifetime was leaked by that run: trip its bot
            await trip(() => checkTokenMisuse(db, tokenHash));
            return fail(reply, 401, 'unauthorized', 'Run token is invalid, expired, or the run has ended');
        }
        if (row.bot_paused_at) return fail(reply, 423, 'bot_paused', 'The bot that submitted this run is paused');
        if (!row.submitted_by) return fail(reply, 403, 'no_submitter', 'The run has no submitting bot');

        request.run = {
            runId: row.id.trim(),
            serverId: row.server_id.trim(),
            channelId: row.channel_id?.trim() ?? null,
            threadId: row.thread_id?.trim() ?? null,
            submittedBy: row.submitted_by.trim(),
            capabilities: row.capabilities ?? [],
            limits: row.limits,
        };
    }

    // ─── Capabilities ───
    app.post('/v1/capabilities/:name', { preHandler: authenticate }, async (request, reply) => {
        const run = request.run!;
        const { name } = request.params as { name: string };
        if (!(CAPABILITIES as readonly string[]).includes(name)) return fail(reply, 404, 'unknown_capability', `Unknown capability "${name}"`);
        const capability = name as Capability;
        if (!run.capabilities.includes(capability)) {
            return fail(reply, 403, 'not_declared', `This run did not declare the "${capability}" capability`);
        }

        const handler = HANDLERS[capability];
        if (!handler) return fail(reply, 501, 'not_implemented', `"${capability}" is not available yet`);

        const invalid = VALIDATORS[capability]?.(request.body);
        if (invalid) return fail(reply, 400, 'invalid_input', invalid);

        if (!(await consumeOrTrip(run, reply))) return reply;

        const resolved = await resolveRoute(db, run.serverId, capability);
        if (!resolved.ok) return fail(reply, 503, 'capability_unavailable', resolved.error);
        const budget = await checkBudget(db, resolved.value.route);
        if (!budget.ok) return fail(reply, 429, 'budget_exceeded', budget.error);

        const result = await handler({ run, route: resolved.value, input: request.body ?? {}, db, publish: events => publishEvents(redis, events) });
        return reply.status(result.status ?? 200).send(result.body);
    });

    // ─── Messages ───
    app.post('/v1/messages', {
        preHandler: authenticate,
        schema: {
            body: {
                type: 'object', required: ['content'], additionalProperties: false,
                properties: { content: { type: 'string', minLength: 1, maxLength: 4000 } },
            },
        },
    }, async (request, reply) => {
        const run = request.run!;
        if (!run.channelId) return fail(reply, 409, 'no_channel', 'This run has no channel to post to');
        if (!(await consumeOrTrip(run, reply))) return reply;
        try {
            const { messageId, events } = await postBotMessage(db, {
                channelId: run.channelId, threadId: run.threadId, authorId: run.submittedBy,
                content: (request.body as { content: string }).content,
            });
            await publishEvents(redis, events);
            return reply.status(201).send({ id: messageId });
        } catch (err) {
            if (err instanceof PostError) return fail(reply, err.status, err.code, err.message);
            throw err;
        }
    });

    // ─── Results cards (WBS 4.1) ───
    const countsSchema = {
        type: 'object', required: ['passed', 'failed', 'skipped'], additionalProperties: false,
        properties: {
            passed: { type: 'integer', minimum: 0, maximum: 10_000_000 },
            failed: { type: 'integer', minimum: 0, maximum: 10_000_000 },
            skipped: { type: 'integer', minimum: 0, maximum: 10_000_000 },
            durationMs: { type: 'integer', minimum: 0, maximum: 604_800_000 },
        },
    };
    app.post('/v1/reports', {
        preHandler: authenticate,
        bodyLimit: 2 * 1024 * 1024,
        schema: {
            body: {
                type: 'object', required: ['title', 'totals'], additionalProperties: false,
                properties: {
                    title: { type: 'string', minLength: 1, maxLength: 200 },
                    summary: { type: 'string', maxLength: 4000 },
                    summarySource: { type: 'string', enum: ['model', 'computed'] },
                    totals: countsSchema,
                    suites: {
                        type: 'array', maxItems: 50,
                        items: { ...countsSchema, required: ['name', ...countsSchema.required], properties: { ...countsSchema.properties, name: { type: 'string', minLength: 1, maxLength: 300 } } },
                    },
                    failures: {
                        type: 'array', maxItems: 20,
                        items: {
                            type: 'object', required: ['name', 'message'], additionalProperties: false,
                            properties: {
                                name: { type: 'string', minLength: 1, maxLength: 500 },
                                suite: { type: 'string', maxLength: 300 },
                                message: { type: 'string', maxLength: 2000 },
                            },
                        },
                    },
                    attachment: {
                        type: 'object', required: ['name', 'content'], additionalProperties: false,
                        properties: {
                            name: { type: 'string', minLength: 1, maxLength: 255 },
                            content: { type: 'string', minLength: 1, maxLength: 1_100_000 },
                        },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const run = request.run!;
        if (!run.channelId) return fail(reply, 409, 'no_channel', 'This run has no channel to post to');
        const body = request.body as {
            title: string; summary?: string; summarySource?: 'model' | 'computed';
            totals: Record<string, number>; suites?: unknown[]; failures?: unknown[];
            attachment?: { name: string; content: string };
        };
        if (!(await consumeOrTrip(run, reply))) return reply;

        let fileId: string | undefined;
        if (body.attachment) {
            if (!(await reserveArtifact(run))) return fail(reply, 429, 'artifact_limit', `Artifact limit reached (${run.limits.artifacts ?? 10} per run)`);
            const stored = await storeFile(db, db, {
                buffer: Buffer.from(body.attachment.content, 'utf8'), filename: body.attachment.name,
                uploaderId: run.submittedBy, channelId: run.channelId,
            });
            if (!stored.ok) {
                await releaseArtifact(run);
                return reply.status(stored.status).send({ error: stored.error, code: 'file_rejected', ...(stored.details ? { details: stored.details } : {}) });
            }
            fileId = stored.file.id;
        }

        const { passed, failed, skipped } = body.totals;
        const systemData = {
            kind: 'runtime_report', runId: run.runId, title: body.title,
            summary: body.summary ?? null, summarySource: body.summarySource ?? null,
            totals: body.totals, suites: body.suites ?? [], failures: body.failures ?? [],
        };
        // Plain-text fallback for clients that don't render cards (e.g. agents reading chat)
        const content = `${failed ? '❌' : '✅'} ${body.title}: ${passed} passed, ${failed} failed, ${skipped} skipped`
            + (body.summary ? `\n\n${body.summary}` : '');
        try {
            const { messageId, events } = await postBotMessage(db, {
                channelId: run.channelId, threadId: run.threadId, authorId: run.submittedBy,
                content: content.slice(0, 4000), fileIds: fileId ? [fileId] : undefined,
                systemEvent: 'runtime_report', systemData,
            });
            await publishEvents(redis, events);
            return reply.status(201).send({ id: messageId, ...(fileId ? { fileId } : {}) });
        } catch (err) {
            if (err instanceof PostError) return fail(reply, err.status, err.code, err.message);
            throw err;
        }
    });

    // ─── Files (raw body; any content type) ───
    await app.register(async (files) => {
        files.removeAllContentTypeParsers();
        files.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_FILE_BODY }, (_req, body, done) => done(null, body));

        files.post('/v1/files', { preHandler: authenticate, bodyLimit: MAX_FILE_BODY }, async (request, reply) => {
            const run = request.run!;
            if (!run.channelId) return fail(reply, 409, 'no_channel', 'This run has no channel to post to');
            const body = request.body;
            if (!Buffer.isBuffer(body) || body.length === 0) return fail(reply, 400, 'empty_file', 'File body is empty');

            let filename: string;
            let message = '';
            try {
                filename = decodeURIComponent(String(request.headers['x-agora-filename'] ?? ''));
                if (request.headers['x-agora-message']) message = decodeURIComponent(String(request.headers['x-agora-message'])).slice(0, 4000);
            } catch {
                return fail(reply, 400, 'bad_header', 'Filename or message header is not valid URI encoding');
            }
            if (!filename || filename.length > 255) return fail(reply, 400, 'bad_filename', 'X-Agora-Filename is required (max 255 chars)');

            if (!(await reserveArtifact(run))) return fail(reply, 429, 'artifact_limit', `Artifact limit reached (${run.limits.artifacts ?? 10} per run)`);

            const stored = await storeFile(db, db, { buffer: body, filename, uploaderId: run.submittedBy, channelId: run.channelId });
            if (!stored.ok) {
                await releaseArtifact(run);
                return reply.status(stored.status).send({ error: stored.error, code: 'file_rejected', ...(stored.details ? { details: stored.details } : {}) });
            }

            try {
                const { events } = await postBotMessage(db, {
                    channelId: run.channelId, threadId: run.threadId, authorId: run.submittedBy,
                    content: message, fileIds: [stored.file.id],
                });
                await publishEvents(redis, events);
            } catch (err) {
                if (err instanceof PostError) return fail(reply, err.status, err.code, err.message);
                throw err;
            }
            return reply.status(201).send({ id: stored.file.id, url: stored.file.url, name: stored.file.name, mime: stored.file.mime, size: stored.file.size });
        });
    });

    return app;
}

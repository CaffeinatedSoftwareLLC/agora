import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { CAPABILITIES, type Capability, type ConversationMessage } from '../ai/adapters';
import { resolveRoute, checkBudget, recordUsage, type ResolvedRoute } from '../ai/routing';
import { storeFile } from '../lib/file-store';
import { publishEvents } from '../lib/event-bridge';
import { hashToken } from '../runtime/runner';
import type { RunLimits } from '../runtime/limits';
import { postBotMessage, PostError } from './post-message';

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

type Handler = (ctx: { run: GatewayRun; route: ResolvedRoute; input: any; db: Pool }) => Promise<{ status?: number; body: unknown }>;

/** Input validation per capability; returns an error message or null. */
const VALIDATORS: Partial<Record<Capability, (input: any) => string | null>> = {
    chat: (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Body must be an object';
        const allowed = new Set(['messages', 'system', 'maxTokens']);
        const extra = Object.keys(input).find(k => !allowed.has(k));
        if (extra) return `Unknown field "${extra}"`;
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
};

/** Capability implementations. Phase 4 adds search / image / tts / decide. */
const HANDLERS: Partial<Record<Capability, Handler>> = {
    chat: async ({ run, route, input, db }) => {
        const started = Date.now();
        let text = '';
        let failure: Error | null = null;
        let usage = { inputTokens: 0, outputTokens: 0 };
        try {
            await route.adapter.streamChat(
                route.credentials,
                { model: route.model, messages: input.messages as ConversationMessage[], systemPrompt: input.system, maxTokens: input.maxTokens ?? 1024 },
                {
                    onToken: (t) => { text += t; },
                    onDone: async (u) => { usage = u; },
                    onError: async (e) => { failure = e; },
                },
            );
        } catch (err) {
            failure = err instanceof Error ? err : new Error(String(err));
        }
        await recordUsage(db, {
            serverId: run.serverId, capability: 'chat', providerId: route.providerId, adapter: route.adapter.id,
            model: route.model, route: route.route, usage, latencyMs: Date.now() - started,
            channelId: run.channelId, userId: run.submittedBy, runId: run.runId,
            error: failure ? (failure as Error).message : null,
        });
        if (failure) return { status: 502, body: { error: (failure as Error).message, code: 'provider_error' } };
        return { body: { text, usage } };
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

    app.get('/health', async () => ({ status: 'ok' }));

    async function authenticate(request: FastifyRequest, reply: FastifyReply) {
        const header = request.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!token.startsWith('art_')) return fail(reply, 401, 'unauthorized', 'Missing or malformed run token');

        const res = await db.query(
            `SELECT t.capabilities, r.id, r.server_id, r.channel_id, r.thread_id, r.submitted_by, r.limits,
                    u.bot_paused_at
             FROM exec_run_tokens t
             JOIN exec_runs r ON r.id = t.run_id
             LEFT JOIN users u ON u.id = r.submitted_by
             WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > NOW() AND r.status = 'running'`,
            [hashToken(token)]
        );
        const row = res.rows[0];
        if (!row) return fail(reply, 401, 'unauthorized', 'Run token is invalid, expired, or the run has ended');
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

        if (!(await consumeCall(db, run))) {
            return fail(reply, 429, 'call_limit', `Capability call limit reached (${run.limits.capabilityCalls} per run)`);
        }

        const resolved = await resolveRoute(db, run.serverId, capability);
        if (!resolved.ok) return fail(reply, 503, 'capability_unavailable', resolved.error);
        const budget = await checkBudget(db, resolved.value.route);
        if (!budget.ok) return fail(reply, 429, 'budget_exceeded', budget.error);

        const result = await handler({ run, route: resolved.value, input: request.body ?? {}, db });
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
        if (!(await consumeCall(db, run))) {
            return fail(reply, 429, 'call_limit', `Capability call limit reached (${run.limits.capabilityCalls} per run)`);
        }
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

            // Reserve an artifact slot; released if storage fails
            const reserved = await db.query(
                'UPDATE exec_runs SET artifact_count = artifact_count + 1 WHERE id = $1 AND artifact_count < $2 RETURNING artifact_count',
                [run.runId, run.limits.artifacts ?? 10]
            );
            if (reserved.rows.length === 0) return fail(reply, 429, 'artifact_limit', `Artifact limit reached (${run.limits.artifacts ?? 10} per run)`);

            const stored = await storeFile(db, db, { buffer: body, filename, uploaderId: run.submittedBy, channelId: run.channelId });
            if (!stored.ok) {
                await db.query('UPDATE exec_runs SET artifact_count = artifact_count - 1 WHERE id = $1', [run.runId]);
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

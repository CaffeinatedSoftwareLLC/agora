import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FixedWindowLimiter } from './rate-limit.js';
import { utcDay, type InstallReport, type TelemetryStore } from './telemetry-store.js';

/**
 * The telemetry collector (docs/telemetry.md, docs/agent-boxes.md §12.4–12.5):
 *
 *   POST /telemetry/v1/install  { result, step, version, os, osVersion }  → 204
 *   POST /telemetry/v1/problem  { report, version?, os? }                  → 201 { reportId }
 *   GET  /telemetry/v1/problems[/:id], GET /telemetry/v1/installs          (RELAY_ADMIN_TOKEN)
 *
 * Exactly the listed keys, or 400. Nothing about the caller is kept or logged: the limits
 * below are global, not per address, so not even a rate-limit table holds an IP.
 */
export const PROBLEM_MAX_BYTES = 256 * 1024;
/** JSON escaping can grow a 256 KB report; the byte limit is checked on the decoded text. */
export const PROBLEM_BODY_LIMIT = 6 * PROBLEM_MAX_BYTES;
export const PROBLEM_DAYS = 90;

export interface TelemetryOptions {
    store: TelemetryStore;
    /** Bearer token for the read routes; without one they answer 404. */
    adminToken?: string;
    now: () => number;
    installsPerMinute?: number;
    problemsPerMinute?: number;
    /** Stored problem reports at most, in total (keeps a small database bounded). */
    maxStoredBytes?: number;
}

const short = (max: number) => ({ type: 'string', minLength: 1, maxLength: max, pattern: '^[\\x20-\\x7e]+$' });

const installBody = {
    type: 'object',
    required: ['result', 'step', 'version', 'os', 'osVersion'],
    additionalProperties: false,
    properties: {
        result: { type: 'string', enum: ['ok', 'failed'] },
        // The installer's step ids: install/lib/common.sh, install/windows/lib/AgoraInstall.psm1
        step: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-z][a-z0-9.-]{0,63}$' }] },
        version: short(64),
        os: short(64),
        osVersion: short(64),
    },
} as const;

const problemBody = {
    type: 'object',
    required: ['report'],
    additionalProperties: false,
    properties: {
        report: { type: 'string', minLength: 1, maxLength: PROBLEM_MAX_BYTES },
        version: short(64),
        os: short(64),
    },
} as const;

const INSTALL_KEYS = new Set(Object.keys(installBody.properties));
const PROBLEM_KEYS = new Set(Object.keys(problemBody.properties));

/**
 * Fastify's validator drops unknown keys instead of refusing them; these routes promise a 400
 * for anything extra, so the keys are checked before it runs.
 */
function exactKeys(allowed: Set<string>) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
        const body = req.body;
        if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !allowed.has(k))) {
            req.outcome = 'invalid_body';
            return reply.code(400).send({ error: 'invalid_body' });
        }
    };
}

function sameToken(given: string, expected: string): boolean {
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

export function telemetryRoutes(app: FastifyInstance, opts: TelemetryOptions): void {
    const { store, now } = opts;
    const installLimiter = new FixedWindowLimiter(opts.installsPerMinute ?? 120, 60_000, now);
    const problemLimiter = new FixedWindowLimiter(opts.problemsPerMinute ?? 10, 60_000, now);
    const maxStored = opts.maxStoredBytes ?? 200 * 1024 * 1024;
    const sweep = setInterval(() => {
        installLimiter.sweep();
        problemLimiter.sweep();
    }, 60_000);
    sweep.unref();
    app.addHook('onClose', async () => clearInterval(sweep));

    const limited = (limiter: FixedWindowLimiter) => async (req: FastifyRequest, reply: FastifyReply) => {
        const hit = limiter.take('all');
        if (!hit.ok) {
            req.outcome = 'rate_limited';
            reply.header('retry-after', String(hit.retryAfter));
            return reply.code(429).send({ error: 'rate_limited' });
        }
    };

    app.post<{ Body: InstallReport }>(
        '/telemetry/v1/install',
        { schema: { body: installBody }, onRequest: limited(installLimiter), preValidation: exactKeys(INSTALL_KEYS) },
        async (req, reply) => {
            const { result, step, version, os, osVersion } = req.body;
            await store.recordInstall({ result, step, version, os, osVersion }, utcDay(now()));
            req.outcome = `install_${result}`;
            return reply.code(204).send();
        },
    );

    app.post<{ Body: { report: string; version?: string; os?: string } }>(
        '/telemetry/v1/problem',
        { bodyLimit: PROBLEM_BODY_LIMIT, schema: { body: problemBody }, onRequest: limited(problemLimiter), preValidation: exactKeys(PROBLEM_KEYS) },
        async (req, reply) => {
            const { report, version, os } = req.body;
            if (Buffer.byteLength(report, 'utf8') > PROBLEM_MAX_BYTES) {
                req.outcome = 'payload_too_large';
                return reply.code(413).send({ error: 'payload_too_large' });
            }
            const usage = await store.problemUsage();
            if (usage.bytes + Buffer.byteLength(report, 'utf8') > maxStored) {
                req.outcome = 'problem_storage_full';
                return reply.code(503).send({ error: 'storage_full' });
            }
            // Random, and the only thing that names a report; quoted by the user in an issue
            const reportId = `pr_${randomBytes(12).toString('base64url')}`;
            await store.recordProblem({ id: reportId, day: utcDay(now()), version: version ?? null, os: os ?? null, report });
            req.outcome = 'problem_stored';
            return reply.code(201).send({ reportId });
        },
    );

    // ─── Reading them (Caffeinated Software only) ───

    const admin = async (req: FastifyRequest, reply: FastifyReply) => {
        const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
        if (!opts.adminToken || !m || !sameToken(m[1], opts.adminToken)) {
            req.outcome = 'telemetry_admin_refused';
            // Not 401: the routes don't exist for anyone without the token
            return reply.code(404).send({ error: 'not_found' });
        }
    };

    app.get('/telemetry/v1/problems', {
        onRequest: admin,
        schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' } } } },
    }, async (req) => {
        // Query values are strings (the relay turns type coercion off)
        const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 100), 500);
        req.outcome = 'problems_listed';
        return { problems: await store.listProblems(limit) };
    });

    app.get<{ Params: { id: string } }>('/telemetry/v1/problems/:id', {
        onRequest: admin,
        schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^pr_[A-Za-z0-9_-]{16}$' } } } },
    }, async (req, reply) => {
        const problem = await store.getProblem(req.params.id);
        if (!problem) {
            req.outcome = 'problem_not_found';
            return reply.code(404).send({ error: 'not_found' });
        }
        req.outcome = 'problem_read';
        return { problem };
    });

    app.get('/telemetry/v1/installs', {
        onRequest: admin,
        schema: { querystring: { type: 'object', additionalProperties: false, properties: { days: { type: 'string', pattern: '^[1-9][0-9]{0,3}$' } } } },
    }, async (req) => {
        const days = Number((req.query as { days?: string }).days ?? 30);
        req.outcome = 'installs_listed';
        return { installs: await store.installCounts(utcDay(now() - days * 86_400_000)) };
    });
}

/** Deletes problem reports older than `days`. */
export async function pruneProblems(store: TelemetryStore, now: number, days = PROBLEM_DAYS): Promise<number> {
    return store.pruneProblemsBefore(utcDay(now - days * 86_400_000));
}

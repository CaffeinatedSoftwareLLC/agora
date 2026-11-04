import { FastifyInstance } from 'fastify';
import { requireInstanceAdmin } from '../auth/middleware';
import { getRedis } from '../auth/token-blacklist';
import { agoraVersion, buildApiDoctorReport, redact } from '../lib/doctor';
import { generateUlid } from '../utils/ulid';

/**
 * Admin → Instance → Report setup problem (docs/agent-boxes.md §12.5). Preview builds the
 * report and shows it; nothing leaves the instance until the admin sends it, with telemetry
 * on or off. Send forwards the text the admin saw (redacted again) to the collector in
 * agora-push-relay and returns its report id.
 */
export const PROBLEM_MAX_BYTES = 256 * 1024;
const SEND_TIMEOUT_MS = 15_000;

export type CollectorFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProblemReportOptions {
    /** Tests replace the network call. */
    fetch?: CollectorFetch;
    /** Defaults to AGORA_TELEMETRY_URL, then https://push.agora.host. */
    collectorUrl?: string;
}

export function collectorBase(env: NodeJS.ProcessEnv = process.env): string {
    return (env.AGORA_TELEMETRY_URL || 'https://push.agora.host').replace(/\/+$/, '');
}

export async function problemReportRoutes(app: FastifyInstance, opts: ProblemReportOptions = {}) {
    const doFetch: CollectorFetch = opts.fetch ?? ((url, init) => fetch(url, init));

    app.post('/admin/problem-report/preview', {
        preHandler: [requireInstanceAdmin],
    }, async (_request, reply) => {
        // The pool, not the request's client: the box tables have no app_user grants, and a
        // failed check must not abort the request's transaction
        const pool = (app as any).db;
        let redis: ReturnType<typeof getRedis> | null = null;
        try {
            redis = getRedis();
        } catch {
            redis = null;
        }
        const report = await buildApiDoctorReport({
            query: (sql, params) => pool.query(sql, params),
            redis,
        });
        return reply.send({ report });
    });

    app.post('/admin/problem-report/send', {
        preHandler: [requireInstanceAdmin],
        bodyLimit: 2 * PROBLEM_MAX_BYTES,
        schema: {
            body: {
                type: 'object',
                required: ['report'],
                additionalProperties: false,
                properties: { report: { type: 'string', minLength: 1, maxLength: PROBLEM_MAX_BYTES } },
            },
        },
    }, async (request, reply) => {
        const { report } = request.body as { report: string };
        const text = redact(report);
        if (Buffer.byteLength(text, 'utf8') > PROBLEM_MAX_BYTES) return reply.status(413).send({ error: 'report_too_large' });

        const url = `${opts.collectorUrl ?? collectorBase()}/telemetry/v1/problem`;
        let res: Response;
        try {
            res = await doFetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ report: text, version: agoraVersion(), os: process.platform }),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
                redirect: 'error',
            });
        } catch {
            return reply.status(502).send({ error: 'collector_unreachable' });
        }
        const body = await res.json().catch(() => null) as { reportId?: unknown } | null;
        if (res.status !== 201 || typeof body?.reportId !== 'string' || !/^pr_[A-Za-z0-9_-]{16}$/.test(body.reportId)) {
            return reply.status(502).send({ error: 'collector_refused', status: res.status });
        }

        await request.dbClient!.query(
            `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, changes) VALUES ($1, $2, $3, $4, $5, $6)`,
            [generateUlid(), request.userId, 'problem_report_sent', 'instance', null, JSON.stringify({ reportId: body.reportId, bytes: Buffer.byteLength(text, 'utf8') })],
        );
        return reply.send({ reportId: body.reportId });
    });
}

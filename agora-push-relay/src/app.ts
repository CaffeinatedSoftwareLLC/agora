import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { HANDLE_RE, hashHandle } from './crypto.js';
import { normalizeInstance } from './origin.js';
import { FixedWindowLimiter } from './rate-limit.js';
import type { HandleStore, Platform } from './store.js';
import type { Sender } from './senders/types.js';

/** Contract (docs/planning/mobile-apps.md section 8): 30 pushes a minute per handle. */
export const PUSH_PER_MINUTE = 30;
/** Request bodies are a few hundred bytes; anything near this is not a real client. */
export const BODY_LIMIT = 8 * 1024;

export interface AppOptions {
    store: HandleStore;
    senders: Partial<Record<Platform, Sender>>;
    /** Per client IP, on POST /v1/register. */
    registerPerMinute?: number;
    trustProxy?: FastifyServerOptions['trustProxy'];
    logger?: FastifyServerOptions['logger'];
    now?: () => number;
}

/** Outcome counts, the only thing the relay reports about traffic. */
export type Counters = Record<string, number>;

declare module 'fastify' {
    interface FastifyRequest {
        outcome?: string;
    }
}

const registerBody = {
    type: 'object',
    required: ['platform', 'token', 'instance'],
    additionalProperties: false,
    properties: {
        platform: { type: 'string', enum: ['android', 'ios'] },
        // FCM tokens are ~150-250 printable ASCII characters, APNs tokens 64 hex digits.
        token: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[\\x21-\\x7e]+$' },
        instance: { type: 'string', minLength: 1, maxLength: 2048 },
        // The handle this app already holds for the token and instance, if any (HANDLE_RE).
        previous: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    },
} as const;

const pushBody = {
    type: 'object',
    required: ['instance', 'type', 'title', 'body', 'url'],
    additionalProperties: false,
    properties: {
        instance: { type: 'string', minLength: 1, maxLength: 2048 },
        type: { type: 'string', minLength: 1, maxLength: 64 },
        title: { type: 'string', minLength: 1, maxLength: 120 },
        body: { type: 'string', maxLength: 120 },
        // A path on the instance: one leading "/", no scheme, no "//host", no whitespace or backslash.
        url: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^/(?![/\\\\])[^\\s\\\\]*$' },
    },
} as const;

interface RegisterBody {
    platform: Platform;
    token: string;
    instance: string;
    previous?: string;
}
interface PushBody {
    instance: string;
    type: string;
    title: string;
    body: string;
    url: string;
}

/** The handle from `Authorization: Bearer <handle>`, or null if it is missing or malformed. */
function bearer(req: FastifyRequest): string | null {
    const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
    return m && HANDLE_RE.test(m[1]) ? m[1] : null;
}

function fail(req: FastifyRequest, reply: FastifyReply, status: number, error: string, outcome = error) {
    req.outcome = outcome;
    return reply.code(status).send({ error });
}

export function buildApp(opts: AppOptions): FastifyInstance & { counters: Counters } {
    const { store, senders } = opts;
    const now = opts.now ?? Date.now;
    const pushLimiter = new FixedWindowLimiter(PUSH_PER_MINUTE, 60_000, now);
    const registerLimiter = new FixedWindowLimiter(opts.registerPerMinute ?? 10, 60_000, now);
    const counters: Counters = {};

    const app = Fastify({
        logger: opts.logger ?? false,
        bodyLimit: BODY_LIMIT,
        trustProxy: opts.trustProxy ?? false,
        // Fastify's own request lines carry the URL and client address. The relay logs one
        // line per request itself, with the route and an outcome code only.
        logController: new LogController({ disableRequestLogging: true }),
        // No type coercion: a number where a string belongs is a 400, not "42".
        ajv: { customOptions: { coerceTypes: false } },
    }) as unknown as FastifyInstance & { counters: Counters };
    app.decorate('counters', counters);

    const sweep = setInterval(() => {
        pushLimiter.sweep();
        registerLimiter.sweep();
    }, 60_000);
    sweep.unref();
    app.addHook('onClose', async () => clearInterval(sweep));

    app.addHook('onResponse', async (req, reply) => {
        const route = req.routeOptions.url ?? 'unmatched';
        const outcome = req.outcome ?? String(reply.statusCode);
        counters[outcome] = (counters[outcome] ?? 0) + 1;
        if (route !== '/healthz') req.log.info({ route, method: req.method, status: reply.statusCode, outcome, ms: Math.round(reply.elapsedTime) }, 'request');
    });

    // Validation and parse errors are logged as codes only: their messages can quote input.
    app.setErrorHandler((err: { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
        const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
        if (err.validation) return fail(req, reply, 400, 'invalid_body');
        if (status === 413) return fail(req, reply, 413, 'payload_too_large');
        if (status === 415) return fail(req, reply, 415, 'unsupported_media_type');
        if (status < 500) return fail(req, reply, status, 'bad_request', `bad_request_${err.code ?? status}`);
        req.log.error({ code: err.code ?? 'internal' }, 'unhandled error');
        return fail(req, reply, 500, 'internal');
    });
    app.setNotFoundHandler((req, reply) => fail(req, reply, 404, 'not_found'));

    // The app may call register and DELETE from its WebView, so allow any origin. No cookies are involved.
    const cors = async (_req: FastifyRequest, reply: FastifyReply) => {
        reply.header('access-control-allow-origin', '*');
    };
    const preflight = async (req: FastifyRequest, reply: FastifyReply) => {
        req.outcome = 'preflight';
        return reply
            .code(204)
            .header('access-control-allow-origin', '*')
            .header('access-control-allow-methods', 'POST, DELETE')
            .header('access-control-allow-headers', 'authorization, content-type')
            .header('access-control-max-age', '86400')
            .send();
    };
    app.options('/v1/register', preflight);
    app.options('/v1/handles', preflight);

    app.get('/healthz', async () => ({ status: 'ok', providers: { android: Boolean(senders.android), ios: Boolean(senders.ios) } }));

    app.post<{ Body: RegisterBody }>(
        '/v1/register',
        {
            schema: { body: registerBody },
            onRequest: [
                cors,
                // Counted before the body is parsed, so junk bodies count too.
                async (req, reply) => {
                    const hit = registerLimiter.take(req.ip);
                    if (!hit.ok) {
                        reply.header('retry-after', String(hit.retryAfter));
                        return fail(req, reply, 429, 'rate_limited');
                    }
                },
            ],
        },
        async (req, reply) => {
            const { platform, token, previous } = req.body;
            const instance = normalizeInstance(req.body.instance);
            if (!instance) return fail(req, reply, 400, 'invalid_instance');
            if (platform === 'ios' && !/^[0-9a-fA-F]{8,200}$/.test(token)) return fail(req, reply, 400, 'invalid_token');
            if (!senders[platform]) return fail(req, reply, 503, 'platform_unavailable');
            // 200 with the same handle when `previous` still holds this platform, instance and
            // token; otherwise 201 with a new handle, whether or not `previous` exists.
            if (previous && store.renew(previous, platform, instance, token, now())) {
                req.outcome = `renewed_${platform}`;
                return reply.code(200).send({ handle: previous });
            }
            const handle = store.register(platform, instance, token, now());
            req.outcome = `registered_${platform}`;
            return reply.code(201).send({ handle });
        },
    );

    app.post<{ Body: PushBody }>('/v1/push', { schema: { body: pushBody } }, async (req, reply) => {
        const handle = bearer(req);
        const reg = handle ? store.lookup(handle) : null;
        if (!reg) return fail(req, reply, 401, 'unknown_handle');
        if (normalizeInstance(req.body.instance) !== reg.instance) return fail(req, reply, 403, 'instance_mismatch');
        const hit = pushLimiter.take(reg.handleHash);
        if (!hit.ok) {
            reply.header('retry-after', String(hit.retryAfter));
            return fail(req, reply, 429, 'rate_limited');
        }
        const sender = senders[reg.platform];
        if (!sender) return fail(req, reply, 503, 'platform_unavailable');
        const { type, title, body, url } = req.body;
        const result = await sender.send(reg.token, { type, title, body, url, instance: reg.instance });
        if (result.ok) {
            store.touch(reg.handleHash, now());
            req.outcome = `sent_${reg.platform}`;
            return reply.code(202).send({});
        }
        if (result.gone) {
            store.deleteByHash(reg.handleHash);
            return fail(req, reply, 410, 'gone', `gone_${result.reason}`);
        }
        return fail(req, reply, 502, 'provider_error', result.reason);
    });

    app.delete('/v1/handles', { onRequest: cors }, async (req, reply) => {
        const handle = bearer(req);
        if (!handle) return fail(req, reply, 401, 'unknown_handle');
        req.outcome = store.deleteByHash(hashHandle(handle)) ? 'deleted' : 'delete_noop';
        return reply.code(204).send();
    });

    return app;
}

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isServerOwner } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { originAllowed, originSchemeMatches, sessionTokenFromHeaders } from '../auth/session-cookie';
import { verifyToken } from '../auth/tokens';
import { passwordReauth } from './account-deletion';
import { shellHub } from '../lib/boxes/shell-hub';
import {
    SHELL_PROTOCOL, TICKET_TTL_SECONDS, activeRunOf, issueTicket, limitsOf, openSessionOf, recentSessions, shellBox, shellRefusal,
} from '../lib/boxes/shell';

/**
 * The owner's side of the terminal in a box (docs/box-terminal.md). People only: a bot token or a
 * host token never reaches these routes (the auth step refuses them: BOT_ALLOWED_ROUTES and
 * isAgentHostRoute), and each route checks again that the caller owns the box's server.
 *
 * Opening a terminal is two steps. `POST …/terminal/ticket` checks everything and hands out a
 * 30-second single-use ticket; the browser then opens its own socket with it
 * (src/lib/boxes/shell-hub.ts), which checks it all again.
 */

const ID = { type: 'string', minLength: 26, maxLength: 26 } as const;

type Out = { status: number; body?: object };

/**
 * Run `fn` as the table owner, then reply. The reply is sent after asService returns, never inside
 * it: sending commits the request's transaction, and asService still has its savepoint to release.
 * A refusal is a returned value, not a throw, so the audit row written for it is kept.
 */
async function serve(request: FastifyRequest, reply: FastifyReply, fn: (db: any) => Promise<Out>) {
    const db = request.dbClient!;
    const out = await asService(db, () => fn(db));
    return out.body === undefined ? reply.status(out.status).send() : reply.status(out.status).send(out.body);
}

/** The box's row for the terminal if the caller owns its server, else the refusal to return. */
async function ownedShellBox(request: FastifyRequest, db: any): Promise<{ box: any } | { refusal: Out }> {
    if (!request.userId || request.isBot) return { refusal: { status: 403, body: { error: 'forbidden' } } };
    const { boxId } = request.params as { boxId: string };
    const box = await shellBox(db, boxId);
    // "No such box" and "not your box" answer the same, so the route is not a way to find boxes
    const notFound: Out = { status: 404, body: { error: 'box_not_found' } };
    if (!box) return { refusal: notFound };
    if (!await isServerOwner(db, box.server_id.trim(), request.userId)) {
        // A member, a director or another server's owner asked: on the record (once a minute per
        // person and box), with no detail back
        await shellRefusal(db, {
            serverId: box.server_id.trim(), actorId: request.userId.trim(), boxId: box.id.trim(), code: 'not_owner',
            via: `${request.method} ${request.routeOptions.url}`,
        });
        return { refusal: notFound };
    }
    return { box };
}

export async function boxTerminalRoutes(app: FastifyInstance) {
    // GET /boxes/:boxId/terminal → what Settings needs to show the button and who has a terminal open
    app.get('/boxes/:boxId/terminal', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { params: { type: 'object', properties: { boxId: ID } } } }, (request, reply) => serve(request, reply, async db => {
        const owned = await ownedShellBox(request, db);
        if ('refusal' in owned) return owned.refusal;
        const box = owned.box;
        const open = await openSessionOf(db, box.id.trim());
        return {
            status: 200,
            body: {
                protocol: SHELL_PROTOCOL,
                box: { id: box.id.trim(), name: box.name, adapter: box.adapter },
                // supported: the box's agora-host has spoken the terminal protocol at least once.
                // An older box image never has: it needs its update first.
                supported: Number(box.shell_protocol) >= SHELL_PROTOCOL,
                hostConnected: !!shellHub()?.hostConnected(box.id.trim(), box.generation),
                running: box.desired_state === 'running' && box.state === 'running',
                open: open && { id: open.id, openedByName: open.openedByName, openedAt: open.openedAt, mine: open.openedBy === request.userId!.trim() },
                activeRun: await activeRunOf(db, box.profile_id.trim()),
                limits: limitsOf(box),
                ticketTtlSeconds: TICKET_TTL_SECONDS,
            },
        };
    }));

    // POST /boxes/:boxId/terminal/ticket { password, takeover? } → { ticket, expiresInSeconds }
    app.post('/boxes/:boxId/terminal/ticket', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
            params: { type: 'object', properties: { boxId: ID } },
            body: {
                type: 'object', required: ['password'], additionalProperties: false,
                properties: { password: { type: 'string', minLength: 1, maxLength: 1024 }, takeover: { type: 'boolean' } },
            },
        },
    }, (request, reply) => serve(request, reply, async db => {
        const owned = await ownedShellBox(request, db);
        if ('refusal' in owned) return owned.refusal;
        const box = owned.box;
        const boxId = box.id.trim();
        const userId = request.userId!.trim();
        const refuse = async (status: number, code: string, extra: object = {}): Promise<Out> => {
            await shellRefusal(db, { serverId: box.server_id.trim(), actorId: userId, boxId, code, via: 'ticket' });
            return { status, body: { error: code, ...extra } };
        };
        // A person with a browser session: not a bearer token someone copied out of a script, and
        // from this site's own pages (the cookie is SameSite=Strict and CSRF-checked already)
        if (!request.cookieAuth) return refuse(403, 'cookie_session_required');
        if (!request.headers.origin || !originAllowed(request.headers) || !originSchemeMatches(request.headers, !!(request.raw.socket as any).encrypted)) return refuse(403, 'origin_not_allowed');
        const jti = jtiOf(request, app.jwtSecret);
        if (!jti) return refuse(403, 'cookie_session_required');

        if (box.desired_state !== 'running' || box.state !== 'running') return refuse(409, 'box_not_running');
        if (!(Number(box.shell_protocol) >= SHELL_PROTOCOL)) return refuse(409, 'box_needs_update');
        if (!shellHub()?.hostConnected(boxId, box.generation)) return refuse(409, 'box_not_ready');

        // The owner's password again, counted against the login limit: a stolen cookie or a script
        // in the page does not know it
        const user = (await db.query('SELECT password_hash FROM users WHERE id = $1 AND NOT bot', [userId])).rows[0];
        const reauth = await passwordReauth(app, request, userId, user?.password_hash ?? null, (request.body as any).password);
        if (reauth !== 'ok') {
            if (reauth === 'locked') return refuse(429, 'too_many_attempts');
            if (reauth === 'unavailable') return { status: 503, body: { error: 'login_unavailable' } };
            return refuse(403, reauth);
        }

        const open = await openSessionOf(db, boxId);
        if (open) {
            if (!(request.body as any).takeover) {
                return { status: 409, body: { error: 'terminal_in_use', openedByName: open.openedByName, openedAt: open.openedAt } };
            }
            // Confirmed: the open terminal ends now (its own transaction), and this one may follow
            await shellHub()?.close(open.id, 'taken_over');
            const stillOpen = await openSessionOf(db, boxId);
            if (stillOpen) return { status: 409, body: { error: 'terminal_in_use', openedByName: stillOpen.openedByName, openedAt: stillOpen.openedAt } };
        }
        const t = await issueTicket(db, { boxId, userId, jti, generation: box.generation });
        return { status: 200, body: { ...t, activeRun: await activeRunOf(db, box.profile_id.trim()) } };
    }));

    // DELETE /boxes/:boxId/terminal → 204: end the open terminal, if any
    app.delete('/boxes/:boxId/terminal', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { params: { type: 'object', properties: { boxId: ID } } } }, (request, reply) => serve(request, reply, async db => {
        const owned = await ownedShellBox(request, db);
        if ('refusal' in owned) return owned.refusal;
        const open = await openSessionOf(db, owned.box.id.trim());
        if (open) await shellHub()?.close(open.id, 'closed_by_owner');
        return { status: 204 };
    }));

    // GET /boxes/:boxId/terminal/sessions → { sessions }: the owner's record (who, when, how long, bytes)
    app.get('/boxes/:boxId/terminal/sessions', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { params: { type: 'object', properties: { boxId: ID } } } }, (request, reply) => serve(request, reply, async db => {
        const owned = await ownedShellBox(request, db);
        if ('refusal' in owned) return owned.refusal;
        return { status: 200, body: { sessions: await recentSessions(db, owned.box.id.trim()) } };
    }));
}

/** The session id of the cookie the request came with (the ticket is bound to it). */
function jtiOf(request: FastifyRequest, secret: string): string | null {
    const token = sessionTokenFromHeaders(request.headers);
    if (!token) return null;
    try { return verifyToken(token, secret).jti ?? null; } catch { return null; }
}

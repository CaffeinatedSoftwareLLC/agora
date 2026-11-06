import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { decryptString } from '../lib/encryption';
import { config } from '../config';
import { expireBoxLogins } from './boxes';
import { loginBlockedHosts } from '../lib/boxes/edge-requests';

/**
 * The box's agora-host side of a CLI login (docs/agent-boxes.md §8.2). Host token routes, for
 * hosts of kind 'box' only; each sees only its own box's logins. Like the siwc plan requests
 * (agent-plans.ts), the host polls for a request, reports what the CLI printed, and for Claude
 * reads the code the owner pasted, once.
 *
 * Host requests carry no user identity, so they run as the table owner; every query is scoped
 * to the host's own box.
 */

const ID = { type: 'string', minLength: 26, maxLength: 26 } as const;
const OPEN = ['requested', 'claimed', 'awaiting_user', 'awaiting_code', 'code_sent'];

/** Which reported status may follow which (a wrong code makes Claude ask again: code_sent → awaiting_code). */
const NEXT: Record<string, string[]> = {
    claimed: ['awaiting_user', 'awaiting_code', 'succeeded', 'failed'],
    awaiting_user: ['awaiting_user', 'succeeded', 'failed'],
    awaiting_code: ['awaiting_code', 'succeeded', 'failed'],
    code_sent: ['awaiting_code', 'succeeded', 'failed'],
};

/** The host's box, or a 403 when the host isn't a box's. */
async function hostBox(request: FastifyRequest, reply: FastifyReply): Promise<{ boxId: string; adapter: string; profile: string } | null> {
    const host = request.agentHost!;
    const row = (await request.dbClient!.query(
        `SELECT b.id, p.adapter, p.name FROM agent_hosts h
         JOIN agent_boxes b ON b.host_id = h.id AND b.id = h.box_id
         JOIN agent_profiles p ON p.id = b.profile_id
         WHERE h.id = $1 AND h.server_id = $2 AND h.kind = 'box' AND b.desired_state <> 'deleted'`,
        [host.id, host.serverId]
    )).rows[0];
    if (!row) { reply.status(403).send({ error: 'box_hosts_only' }); return null; }
    return { boxId: row.id.trim(), adapter: row.adapter, profile: row.name };
}

/**
 * Where each CLI's own sign-in page may be. The box reports the URL its CLI printed, and the
 * agent in the box could report anything, so the server holds the line: the owner is only ever
 * sent to the provider's own hosts (and their subdomains), over https.
 */
export const LOGIN_HOSTS: Record<string, string[]> = {
    claude: ['claude.ai', 'claude.com', 'anthropic.com'],
    codex: ['openai.com', 'chatgpt.com'],
    // `devin auth login --force-manual-token-flow` prints https://app.devin.ai/auth/cli/continue?...,
    // or a windsurf.com link when it can't resolve its deployment
    devin: ['devin.ai', 'windsurf.com'],
};
export function loginUrlAllowed(adapter: string, raw: string): boolean {
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return (LOGIN_HOSTS[adapter] ?? []).some(d => host === d || host.endsWith(`.${d}`));
}

const CLEARED = `verification_url = NULL, user_code = NULL, pasted_code_enc = NULL, pasted_code_iv = NULL, pasted_code_tag = NULL`;

/** The box's login `id`, locked; 404 if it isn't this box's, 409 once it has ended. */
async function openLogin(request: FastifyRequest, reply: FastifyReply, boxId: string): Promise<any | null> {
    const db = request.dbClient!;
    await expireBoxLogins(db, boxId);
    const { id } = request.params as any;
    const row = (await db.query(`SELECT * FROM box_login_requests WHERE id = $1 AND box_id = $2 FOR UPDATE`, [id, boxId])).rows[0];
    if (!row) { reply.status(404).send({ error: 'unknown_login' }); return null; }
    if (!OPEN.includes(row.status) || row.status === 'requested') { reply.status(409).send({ error: 'login_closed' }); return null; }
    return row;
}

export async function boxHostRoutes(app: FastifyInstance) {
    // GET /agent-hosts/@me/box-login → 200 { id, adapter, profile } (claims the oldest request) | 204
    app.get('/agent-hosts/@me/box-login', async (request, reply) => {
        const box = await hostBox(request, reply);
        if (!box) return reply;
        const db = request.dbClient!;
        await expireBoxLogins(db, box.boxId);
        const row = (await db.query(
            `UPDATE box_login_requests SET status = 'claimed', updated_at = NOW()
             WHERE id = (SELECT id FROM box_login_requests WHERE box_id = $1 AND status = 'requested'
                         ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
             RETURNING id`,
            [box.boxId]
        )).rows[0];
        if (!row) return reply.status(204).send();
        return reply.send({ id: row.id.trim(), adapter: box.adapter, profile: box.profile });
    });

    // POST /agent-hosts/@me/box-login/:id { status, verificationUrl?, userCode?, error? } → 200 { ok }
    app.post('/agent-hosts/@me/box-login/:id', {
        schema: {
            params: { type: 'object', properties: { id: ID } },
            body: {
                type: 'object', required: ['status'], additionalProperties: false,
                properties: {
                    status: { type: 'string', enum: ['awaiting_user', 'awaiting_code', 'succeeded', 'failed'] },
                    verificationUrl: { type: 'string', maxLength: 2000, pattern: '^https://[^\\s]+$' },
                    userCode: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[\\x21-\\x7e]+$' },
                    error: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
                },
            },
        },
    }, async (request, reply) => {
        const box = await hostBox(request, reply);
        if (!box) return reply;
        const login = await openLogin(request, reply, box.boxId);
        if (!login) return reply;
        const b = request.body as { status: string; verificationUrl?: string; userCode?: string; error?: string };
        if (!NEXT[login.status]?.includes(b.status)) return reply.status(409).send({ error: 'bad_transition', from: login.status });
        const db = request.dbClient!;
        if (b.status === 'awaiting_user' || b.status === 'awaiting_code') {
            if (!b.verificationUrl) return reply.status(400).send({ error: 'verificationUrl is required' });
            if (!loginUrlAllowed(box.adapter, b.verificationUrl)) return reply.status(400).send({ error: 'verification_url_not_allowed' });
            if (b.status === 'awaiting_user' && !b.userCode) return reply.status(400).send({ error: 'userCode is required' });
            await db.query(
                `UPDATE box_login_requests SET status = $2, verification_url = $3, user_code = $4, error = NULL, updated_at = NOW() WHERE id = $1`,
                [login.id, b.status, b.verificationUrl, b.userCode ?? null]
            );
            return reply.send({ ok: true });
        }
        // The login ended: what passed through Agora for it goes now. A failure while the edge was
        // refusing a domain is that, not a bare login_failed: the owner can allow it and retry
        // Only the CLI's own failures are rewritten; the host's other codes (a bad code, a stop) stay
        let error = b.status === 'failed' ? (b.error ?? 'login_failed') : null;
        if ((error === 'login_failed' || error === 'login_timeout') && (await loginBlockedHosts(db, box.boxId, box.adapter)).length > 0) error = 'needs_domain';
        await db.query(`UPDATE box_login_requests SET status = $2, error = $3, ${CLEARED}, updated_at = NOW() WHERE id = $1`,
            [login.id, b.status, error]);
        await db.query(`UPDATE agent_boxes SET login_state = $2, updated_at = NOW() WHERE id = $1`,
            [box.boxId, b.status === 'succeeded' ? 'logged_in' : 'failed']);
        return reply.send({ ok: true });
    });

    // GET /agent-hosts/@me/box-login/:id/code → 200 { code } once | 204
    app.get('/agent-hosts/@me/box-login/:id/code', {
        schema: { params: { type: 'object', properties: { id: ID } } },
    }, async (request, reply) => {
        const box = await hostBox(request, reply);
        if (!box) return reply;
        const login = await openLogin(request, reply, box.boxId);
        if (!login) return reply;
        if (!login.pasted_code_enc) return reply.status(204).send();
        const code = decryptString(login.pasted_code_enc, config.encryptionKey, login.pasted_code_iv, login.pasted_code_tag);
        await request.dbClient!.query(
            `UPDATE box_login_requests SET status = 'code_sent', pasted_code_enc = NULL, pasted_code_iv = NULL, pasted_code_tag = NULL, updated_at = NOW()
             WHERE id = $1`,
            [login.id]
        );
        return reply.send({ code });
    });
}

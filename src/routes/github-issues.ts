import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { canViewChannel } from '../lib/channel-access';
import { cannotDirect, isServerOwner, stampAuthority } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { hashClaimToken, type Notice } from '../lib/agent-runs';
import { cardUpdate } from '../lib/task-cards';
import { sanitizeMessageText } from '../lib/sanitize-text';
import {
    ISSUE_BODY_MAX, ISSUE_LIST_LIMIT, LIST_FRESH_MINUTES, REPO_PATTERN, commentFailed, commentPosted, issueDescription, issueUrlOk, validRepo,
    type ListedIssue,
} from '../lib/github-issues';
import { CommandError, profileByName } from './agent-commands';
import { cleanTitle, startCard } from './task-board';

/**
 * GitHub issues bridge (docs/github-issues.md).
 *
 * - Linking a channel to a repository, and picking the host whose `gh` serves it: the server
 *   owner alone, because `gh` runs with the owner's own GitHub login on that machine.
 * - Listing open issues and importing one as a task card: people who may direct agents in
 *   the channel (the owner and directors), as for the task board's Check PR.
 * - Status comments on the issue: queued by the server when a card's pull request opens,
 *   merges or closes (src/lib/github-issues.ts reportToIssue), fixed text only.
 */

const ID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } as const;
const LEASE_SECONDS = 90;

function emit(request: FastifyRequest, notices: Array<Notice | null>) {
    request.pendingEvents ??= [];
    for (const n of notices) if (n) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
}

async function channelServer(db: any, channelId: string): Promise<string | null> {
    return (await db.query('SELECT server_id FROM channels WHERE id = $1', [channelId])).rows[0]?.server_id?.trim() ?? null;
}

async function readLink(db: any, channelId: string) {
    const row = (await db.query(
        `SELECT g.repo, btrim(g.host_id) AS host_id, h.name AS host_name, h.revoked_at, g.updated_at
         FROM channel_github_repos g JOIN agent_hosts h ON h.id = g.host_id WHERE g.channel_id = $1`, [channelId])).rows[0];
    return row ? { repo: row.repo, hostId: row.host_id, hostName: row.host_name, hostRevoked: !!row.revoked_at, updatedAt: row.updated_at } : null;
}

/** Issues from a finished list, with the card each one already became in this channel. */
async function listedIssues(db: any, channelId: string, repo: string, issues: ListedIssue[]) {
    const cards = (await db.query(
        `SELECT btrim(id) AS id, issue_number FROM task_cards WHERE channel_id = $1 AND lower(issue_repo) = lower($2) AND issue_number = ANY($3::int[])`,
        [channelId, repo, issues.map(i => i.number)])).rows;
    const byNumber = new Map(cards.map((c: any) => [Number(c.issue_number), c.id]));
    return issues.map(i => ({ ...i, cardId: byNumber.get(i.number) ?? null }));
}

/** Queued GitHub work of a channel whose link changed. A comment it cancels is retried by the next Check PR. */
async function cancelQueued(db: any, channelId: string) {
    await db.query(`UPDATE github_commands SET status = 'failed', result = '{"error":"binding_changed"}', finished_at = NOW()
        WHERE channel_id = $1 AND status = 'queued'`, [channelId]);
}

export async function githubIssueRoutes(app: FastifyInstance) {
    const root = '/channels/:id/github';

    /** A person who can see the channel; with `manage`, one who may direct agents here. */
    async function denied(request: FastifyRequest, channelId: string, manage: boolean) {
        const db = request.dbClient!;
        if (request.isBot) return { status: 403, body: { error: 'people_only' } };
        if (!(await canViewChannel(db, channelId, request.userId, false)).allowed) return { status: 403, body: { error: 'forbidden' } };
        if (manage && !await stampAuthority(db, channelId, request.userId, false)) return { status: 403, body: await cannotDirect(db, channelId, request.userId) };
        return null;
    }

    // GET /channels/:id/github → { link: { repo, hostId, hostName, hostRevoked } | null, canLink, canImport }
    app.get(root, { schema: { params: { type: 'object', properties: { id: ID } } } }, async (request, reply) => {
        const { id: channelId } = request.params as any, db = request.dbClient!;
        const no = await denied(request, channelId, false);
        if (no) return reply.status(no.status).send(no.body);
        const serverId = await channelServer(db, channelId);
        if (!serverId) return reply.status(404).send({ error: 'channel_not_found' });
        const link = await asService(db, () => readLink(db, channelId));
        return reply.send({
            link,
            canLink: await isServerOwner(db, serverId, request.userId!),
            canImport: !!await stampAuthority(db, channelId, request.userId, false),
        });
    });

    // PUT /channels/:id/github { repo, hostId } → 200 { link }. The owner only.
    app.put(root, {
        schema: {
            params: { type: 'object', properties: { id: ID } },
            body: { type: 'object', additionalProperties: false, required: ['repo', 'hostId'], properties: {
                repo: { type: 'string', maxLength: 140, pattern: REPO_PATTERN }, hostId: ID,
            } },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any, b = request.body as { repo: string; hostId: string }, db = request.dbClient!;
        const no = await denied(request, channelId, false);
        if (no) return reply.status(no.status).send(no.body);
        if (!validRepo(b.repo)) return reply.status(400).send({ error: 'invalid_repo' });
        const serverId = await channelServer(db, channelId);
        if (!serverId) return reply.status(404).send({ error: 'channel_not_found' });
        if (!await isServerOwner(db, serverId, request.userId!)) return reply.status(403).send({ error: 'owner_only' });
        const link = await asService(db, async () => {
            const host = (await db.query('SELECT 1 FROM agent_hosts WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL', [b.hostId, serverId])).rows[0];
            if (!host) return null;
            // Queued work was for the old repository or host: it never runs on the new one
            await cancelQueued(db, channelId);
            await db.query(
                `INSERT INTO channel_github_repos (channel_id, server_id, repo, host_id, linked_by) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (channel_id) DO UPDATE SET repo = EXCLUDED.repo, host_id = EXCLUDED.host_id, linked_by = EXCLUDED.linked_by, updated_at = NOW()`,
                [channelId, serverId, b.repo, b.hostId, request.userId]);
            return readLink(db, channelId);
        });
        if (!link) return reply.status(400).send({ error: 'host_not_found' });
        return reply.send({ link });
    });

    // DELETE /channels/:id/github → 204. Cards made from its issues keep their link.
    app.delete(root, { schema: { params: { type: 'object', properties: { id: ID } } } }, async (request, reply) => {
        const { id: channelId } = request.params as any, db = request.dbClient!;
        const no = await denied(request, channelId, false);
        if (no) return reply.status(no.status).send(no.body);
        const serverId = await channelServer(db, channelId);
        if (!serverId) return reply.status(404).send({ error: 'channel_not_found' });
        if (!await isServerOwner(db, serverId, request.userId!)) return reply.status(403).send({ error: 'owner_only' });
        await asService(db, async () => {
            await cancelQueued(db, channelId);
            await db.query('DELETE FROM channel_github_repos WHERE channel_id = $1', [channelId]);
        });
        return reply.status(204).send();
    });

    // POST /channels/:id/github/issues → 202 { id, status }: the host lists the open issues.
    // One list at a time per channel: a request while one is pending returns that one.
    app.post(`${root}/issues`, { schema: { params: { type: 'object', properties: { id: ID } } } }, async (request, reply) => {
        const { id: channelId } = request.params as any, db = request.dbClient!;
        const no = await denied(request, channelId, true);
        if (no) return reply.status(no.status).send(no.body);
        const r = await asService(db, async () => {
            const link = (await db.query(
                `SELECT g.* FROM channel_github_repos g JOIN agent_hosts h ON h.id = g.host_id
                 WHERE g.channel_id = $1 AND h.revoked_at IS NULL FOR UPDATE OF g`, [channelId])).rows[0];
            if (!link) return { status: 409, body: { error: 'no_repo_linked' } };
            const pending = (await db.query(
                `SELECT btrim(id) AS id, status FROM github_commands WHERE channel_id = $1 AND action = 'issue_list'
                 AND status IN ('queued', 'claimed') AND repo = $2 AND host_id = $3 ORDER BY id DESC LIMIT 1`,
                [channelId, link.repo, link.host_id])).rows[0];
            if (pending) return { status: 202, body: pending };
            const id = generateUlid();
            await db.query(
                `INSERT INTO github_commands (id, server_id, channel_id, host_id, requested_by, action, repo, payload)
                 VALUES ($1, $2, $3, $4, $5, 'issue_list', $6, $7)`,
                [id, link.server_id, channelId, link.host_id, request.userId, link.repo, { limit: ISSUE_LIST_LIMIT }]);
            return { status: 202, body: { id, status: 'queued' } };
        });
        return reply.status(r.status).send(r.body);
    });

    // GET /channels/:id/github/commands/:commandId → { id, action, status, repo, result } (issue lists only)
    app.get(`${root}/commands/:commandId`, {
        schema: { params: { type: 'object', properties: { id: ID, commandId: ID } } },
    }, async (request, reply) => {
        const { id: channelId, commandId } = request.params as any, db = request.dbClient!;
        const no = await denied(request, channelId, true);
        if (no) return reply.status(no.status).send(no.body);
        const out = await asService(db, async () => {
            const c = (await db.query(
                `SELECT btrim(id) AS id, action, status, repo, result FROM github_commands
                 WHERE id = $1 AND channel_id = $2 AND action = 'issue_list'`, [commandId, channelId])).rows[0];
            if (!c) return null;
            const result = c.result ?? null;
            if (c.status === 'succeeded' && Array.isArray(result?.issues)) result.issues = await listedIssues(db, channelId, c.repo, result.issues);
            return { ...c, result };
        });
        return out ? reply.send(out) : reply.status(404).send({ error: 'not_found' });
    });

    // POST /channels/:id/github/issues/import { commandId, number, profile?, start? } → 201 { action, card }
    // The issue's title, text and link come from the host's list, never from the request.
    app.post(`${root}/issues/import`, {
        schema: {
            params: { type: 'object', properties: { id: ID } },
            body: { type: 'object', additionalProperties: false, required: ['commandId', 'number'], properties: {
                commandId: ID, number: { type: 'integer', minimum: 1, maximum: 2147483647 },
                profile: { type: ['string', 'null'], minLength: 1, maxLength: 32 }, start: { type: 'boolean' },
            } },
        },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any, b = request.body as any, db = request.dbClient!;
        const no = await denied(request, channelId, true);
        if (no) return reply.status(no.status).send(no.body);
        if (b.start && !b.profile) return reply.status(400).send({ error: 'no_assignee' });
        const notices: Notice[] = [];
        try {
            const r = await asService(db, async () => {
                const list = (await db.query(
                    `SELECT repo, result, finished_at > NOW() - make_interval(mins => $3) AS fresh FROM github_commands
                     WHERE id = $1 AND channel_id = $2 AND action = 'issue_list' AND status = 'succeeded'`,
                    [b.commandId, channelId, LIST_FRESH_MINUTES])).rows[0];
                if (!list) throw new CommandError(404, { error: 'issue_list_not_found' });
                if (!list.fresh) throw new CommandError(409, { error: 'issue_list_stale' });
                const issue = (list.result?.issues ?? []).find((i: ListedIssue) => i.number === b.number) as ListedIssue | undefined;
                if (!issue) throw new CommandError(404, { error: 'issue_not_in_list' });
                const profileId = b.profile ? (await profileByName(db, channelId, b.profile)).id.trim() : null;
                const exists = (await db.query(
                    `SELECT btrim(id) AS id FROM task_cards WHERE channel_id = $1 AND lower(issue_repo) = lower($2) AND issue_number = $3`,
                    [channelId, list.repo, issue.number])).rows[0];
                if (exists) throw new CommandError(409, { error: 'issue_already_imported', cardId: exists.id });
                const taskId = generateUlid();
                const title = cleanTitle(issue.title) || `Issue #${issue.number}`;
                await db.query(
                    `INSERT INTO task_cards (id, server_id, channel_id, title, description, status, profile_id, created_by, issue_repo, issue_number, issue_url)
                     SELECT $1, c.server_id, c.id, $3, $4, 'todo', $5, $6, $7, $8, $9 FROM channels c WHERE c.id = $2`,
                    [taskId, channelId, title.slice(0, 200), sanitizeMessageText(issueDescription(issue)), profileId, request.userId,
                     list.repo, issue.number, issueUrlOk(issue.url, issue.number) ? issue.url : null]);
                let action = 'created';
                if (b.start) {
                    const who = (await db.query('SELECT username FROM users WHERE id = $1', [request.userId])).rows[0]?.username ?? 'someone';
                    action = (await startCard(db, channelId, taskId, request.userId!, who, notices)).action;
                }
                const update = await cardUpdate(db, taskId);
                notices.push(update!);
                return { status: 201, body: { action, card: update!.event.card } };
            });
            emit(request, notices);
            return reply.status(r.status).send(r.body);
        } catch (err: any) {
            if (err instanceof CommandError) return reply.status(err.status).send(err.body);
            if (err.code === '23505' && err.constraint === 'idx_task_cards_issue') return reply.status(409).send({ error: 'issue_already_imported' });
            if (err.code === '23505') return reply.status(409).send({ error: 'session_live' });
            throw err;
        }
    });

    // ─── Host routes (AgentHost token) ───

    // GET /agent-hosts/@me/github-commands/next → 200 { id, claimToken, action, repo, payload } | 204
    app.get('/agent-hosts/@me/github-commands/next', async (request, reply) => {
        const db = request.dbClient!, host = request.agentHost!;
        const notices: Notice[] = [];
        const r = await asService(db, async () => {
            if (!(await db.query('SELECT 1 FROM agent_hosts WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL FOR SHARE', [host.id, host.serverId])).rows.length)
                return { status: 401, body: { error: 'host_revoked' } };
            // A claim the host never answered: a list is asked again by the person; a comment may
            // have posted, so it is said in the card's thread and not retried
            const expired = (await db.query(`UPDATE github_commands SET status = 'failed', result = '{"error":"host_timeout"}', finished_at = NOW()
                WHERE host_id = $1 AND status = 'claimed' AND lease_until < NOW() RETURNING *`, [host.id])).rows;
            for (const c of expired) if (c.action === 'issue_comment') notices.push(await commentFailed(db, c, 'host_timeout'));
            const candidates = (await db.query(
                `SELECT * FROM github_commands WHERE host_id = $1 AND server_id = $2 AND status = 'queued' ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`,
                [host.id, host.serverId])).rows;
            for (const c of candidates) {
                // Every call runs only on the host the owner linked, for the repository still linked to
                // the channel; a list also only for someone who may still direct agents there
                const link = (await db.query('SELECT repo, host_id FROM channel_github_repos WHERE channel_id = $1', [c.channel_id])).rows[0];
                const bound = link && link.repo.toLowerCase() === c.repo.toLowerCase() && link.host_id.trim() === host.id;
                const ok = bound && (c.action !== 'issue_list'
                    || c.requested_by && await stampAuthority(db, c.channel_id.trim(), c.requested_by.trim(), false));
                if (!ok) {
                    const error = c.action === 'issue_list' ? 'binding_or_authority_changed' : 'binding_changed';
                    await db.query(`UPDATE github_commands SET status = 'failed', result = $2, finished_at = NOW() WHERE id = $1`, [c.id, { error }]);
                    if (c.action === 'issue_comment') notices.push(await commentFailed(db, c, error));
                    continue;
                }
                const token = randomBytes(32).toString('hex');
                await db.query(`UPDATE github_commands SET status = 'claimed', claim_token_hash = $2, lease_until = NOW() + make_interval(secs => $3) WHERE id = $1`,
                    [c.id, hashClaimToken(token), LEASE_SECONDS]);
                return { status: 200, body: { id: c.id.trim(), claimToken: token, action: c.action, repo: c.repo, payload: c.payload } };
            }
            return { status: 204, body: undefined };
        });
        emit(request, notices);
        return r.body === undefined ? reply.status(r.status).send() : reply.status(r.status).send(r.body);
    });

    // POST /agent-hosts/@me/github-commands/:commandId/result { claimToken, success, result } → 200 { ok }
    app.post('/agent-hosts/@me/github-commands/:commandId/result', {
        schema: {
            params: { type: 'object', properties: { commandId: ID } },
            body: { type: 'object', additionalProperties: false, required: ['claimToken', 'success', 'result'], properties: {
                claimToken: { type: 'string', minLength: 10, maxLength: 200 }, success: { type: 'boolean' },
                result: { type: 'object', additionalProperties: false, properties: {
                    error: { type: 'string', pattern: '^[a-z][a-z_]{0,100}$' },
                    url: { type: 'string', maxLength: 2048 },
                    issues: { type: 'array', maxItems: ISSUE_LIST_LIMIT, items: {
                        type: 'object', additionalProperties: false, required: ['number', 'title', 'url', 'author', 'updatedAt', 'body'], properties: {
                            number: { type: 'integer', minimum: 1, maximum: 2147483647 }, title: { type: 'string', maxLength: 256 },
                            url: { type: 'string', maxLength: 2048 }, author: { type: 'string', maxLength: 64 },
                            updatedAt: { type: 'string', maxLength: 40 }, body: { type: 'string', maxLength: ISSUE_BODY_MAX + 1 },
                        },
                    } },
                } },
            } },
        },
    }, async (request, reply) => {
        const db = request.dbClient!, host = request.agentHost!, { commandId } = request.params as any, b = request.body as any;
        let notice: Notice | null = null;
        const r = await asService(db, async () => {
            if (!(await db.query('SELECT 1 FROM agent_hosts WHERE id = $1 AND server_id = $2 AND revoked_at IS NULL FOR SHARE', [host.id, host.serverId])).rows.length)
                return { status: 401, body: { error: 'host_revoked' } };
            const c = (await db.query(`SELECT *, lease_until <= NOW() AS expired FROM github_commands WHERE id = $1 AND host_id = $2 AND server_id = $3 FOR UPDATE`,
                [commandId, host.id, host.serverId])).rows[0];
            if (!c) return { status: 404, body: { error: 'not_found' } };
            if (c.claim_token_hash !== hashClaimToken(b.claimToken)) return { status: 409, body: { error: 'stale_claim' } };
            if (['succeeded', 'failed'].includes(c.status)) return { status: 200, body: { ok: true, repeated: true } };
            if (c.status !== 'claimed' || c.expired) return { status: 409, body: { error: 'lease_expired' } };
            let result: any = b.success ? {} : { error: b.result.error ?? 'github_command_failed' };
            if (b.success && c.action === 'issue_list') {
                if (!Array.isArray(b.result.issues)) return { status: 400, body: { error: 'invalid_issue_list' } };
                // Only issues whose link points where it should; text is cleaned as chat text is
                result = { issues: b.result.issues.filter((i: ListedIssue) => issueUrlOk(i.url, i.number)).map((i: ListedIssue) => ({
                    number: i.number, title: sanitizeMessageText(i.title).slice(0, 256), url: i.url, author: sanitizeMessageText(i.author).slice(0, 64),
                    updatedAt: i.updatedAt, body: sanitizeMessageText(i.body).slice(0, ISSUE_BODY_MAX + 1),
                })) };
            }
            if (b.success && c.action === 'issue_comment') {
                if (typeof b.result.url === 'string' && /^https:\/\/\S+$/.test(b.result.url)) result = { url: b.result.url };
                await commentPosted(db, c);
            }
            await db.query('UPDATE github_commands SET status = $2, result = $3, finished_at = NOW() WHERE id = $1',
                [c.id, b.success ? 'succeeded' : 'failed', result]);
            // A comment that didn't land is said in the card's thread, not dropped silently
            if (!b.success && c.action === 'issue_comment') notice = await commentFailed(db, c, result.error);
            return { status: 200, body: { ok: true } };
        });
        emit(request, [notice]);
        return reply.status(r.status).send(r.body);
    });
}

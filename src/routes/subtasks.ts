import type { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { canViewChannel } from '../lib/channel-access';
import { cannotDirect, isServerOwner, stampAuthority } from '../lib/direct-agents';
import { asService } from '../lib/agent-sessions';
import { budgetRemaining, MAX_SUBTASK_DEPTH, sessionUpdate, type Notice } from '../lib/agent-runs';
import { insertBotMessage, MAX_LIVE_SUBTASKS } from '../lib/agent-subtasks';
import { sanitizeMessageText } from '../lib/sanitize-text';
import { PLAN_OWNER_ONLY, PLAN_OWNER_ONLY_MESSAGE, SUBSCRIPTION_OWNER_ONLY, SUBSCRIPTION_OWNER_ONLY_MESSAGE } from '../lib/provider-terms';
import { CommandError, SESSION_SELECT, botInChannel, profileByName, sessionJson } from './agent-commands';

/**
 * Subtask delegation (docs/task-board.md, src/lib/agent-subtasks.ts).
 *
 * POST /channels/:id/subtasks: an agent, during a hosted run of its session here, hands a
 * scoped brief to a child session. The child gets a new thread holding only the brief (a
 * clean context: no native session, no summary, no channel history in its prompt) and a
 * token budget taken from what its parent has left. When the child's run succeeds its
 * summary, and nothing else, is posted back to the thread the parent named, which wakes
 * the parent.
 *
 * A child on the parent's own profile needs no further authority: it is the parent's work.
 * A child on another agent's profile is directing that agent, so the caller needs the
 * authority to direct here, and a 'subscription' agent only takes subtasks from sessions
 * the server owner started, a 'siwc' agent only from sessions its plan owner started
 * (src/lib/provider-terms.ts).
 */

const ID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } as const;

export async function subtaskRoutes(app: FastifyInstance) {
    app.post('/channels/:id/subtasks', {
        schema: { body: { type: 'object', required: ['parentSessionId', 'title', 'brief'], additionalProperties: false, properties: {
            parentSessionId: ID,
            title: { type: 'string', minLength: 1, maxLength: 200 },
            brief: { type: 'string', minLength: 1, maxLength: 3600 },
            profile: { type: 'string', minLength: 1, maxLength: 32 },
            // Where the summary goes: a thread the parent is working in (default: the parent's own thread, else the channel)
            reportThreadId: ID,
            tokenBudget: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
            client_key: { type: 'string', minLength: 1, maxLength: 100 },
        } } },
    }, async (request, reply) => {
        const { id: channelId } = request.params as any, b = request.body as any, db = request.dbClient!;
        if (!request.isBot) return reply.status(403).send({ error: 'agents_only' });
        if (!(await canViewChannel(db, channelId, request.userId, true)).allowed) return reply.status(403).send({ error: 'forbidden' });
        const title = sanitizeMessageText(b.title).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
        const brief = sanitizeMessageText(b.brief);
        if (!title || !brief) return reply.status(400).send({ error: 'empty_content' });
        const botId = request.userId.trim();
        const notices: Notice[] = [];
        try {
            const result = await asService(db, async () => {
                // A retried run sends the same key: hand back the subtask it already started
                if (b.client_key) {
                    const earlier = (await db.query(
                        `SELECT s.id FROM messages m JOIN agent_sessions s ON s.thread_id = m.thread_id AND s.parent_session_id = $3
                         WHERE m.author_id = $1 AND m.client_key = $2`, [botId, b.client_key, b.parentSessionId])).rows[0];
                    if (earlier) {
                        const row = (await db.query(`${SESSION_SELECT} WHERE s.id = $1`, [earlier.id])).rows[0];
                        return { status: 200, body: { action: 'repeated', session: sessionJson(row) } };
                    }
                }

                // Lock order: profiles → session, as in /start and run completion
                const meta = (await db.query(`SELECT profile_id FROM agent_sessions WHERE id = $1 AND channel_id = $2 AND bot_id = $3`,
                    [b.parentSessionId, channelId, botId])).rows[0];
                if (!meta) throw new CommandError(404, { error: 'parent_not_found' });
                const childProfile = b.profile ? await profileByName(db, channelId, b.profile)
                    : (await db.query('SELECT * FROM agent_profiles WHERE id = $1 FOR SHARE', [meta.profile_id])).rows[0];
                await db.query('SELECT 1 FROM agent_profiles WHERE id = $1 FOR SHARE', [meta.profile_id]);
                const parent = (await db.query(`SELECT s.*, (SELECT count(*) FROM agent_sessions c WHERE c.parent_session_id = s.id AND c.state = 'live')::int AS live_children,
                        EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id = s.id AND r.status = 'claimed') AS running
                    FROM agent_sessions s WHERE s.id = $1 FOR UPDATE OF s`, [b.parentSessionId])).rows[0];
                // Only during the parent's own hosted run: the brief is part of that run's work
                if (parent.state !== 'live' || !parent.running) throw new CommandError(409, { error: 'parent_not_running' });
                if (parent.live_children >= MAX_LIVE_SUBTASKS) throw new CommandError(409, { error: 'too_many_subtasks' });
                const depth = (await db.query(`WITH RECURSIVE up AS (
                        SELECT parent_session_id, 0 AS depth FROM agent_sessions WHERE id = $1
                        UNION ALL SELECT s.parent_session_id, up.depth + 1 FROM agent_sessions s JOIN up ON s.id = up.parent_session_id WHERE up.depth < 10
                    ) SELECT max(depth)::int AS depth FROM up`, [parent.id])).rows[0].depth;
                if (depth >= MAX_SUBTASK_DEPTH) throw new CommandError(409, { error: 'subtask_depth' });

                // Another agent's profile: directing that agent
                const otherAgent = childProfile.id !== parent.profile_id;
                if (otherAgent && !await stampAuthority(db, channelId, botId, true)) throw new CommandError(403, await cannotDirect(db, channelId, botId));
                // The child inherits who started the parent: that decides the subscription rule for it
                // A 'siwc' child runs on its plan owner's ChatGPT plan: only sessions that person started
                if (childProfile.auth_mode === 'siwc') {
                    if (!parent.started_by || !childProfile.plan_owner_id || parent.started_by.trim() !== childProfile.plan_owner_id.trim())
                        throw new CommandError(403, { error: PLAN_OWNER_ONLY, message: PLAN_OWNER_ONLY_MESSAGE });
                } else if (childProfile.auth_mode !== 'api_key' && !(parent.started_by && await isServerOwner(db, parent.server_id.trim(), parent.started_by.trim())))
                    throw new CommandError(403, { error: SUBSCRIPTION_OWNER_ONLY, message: SUBSCRIPTION_OWNER_ONLY_MESSAGE });
                const childBot = childProfile.bot_id.trim();
                await botInChannel(db, childBot, channelId);

                const remaining = await budgetRemaining(db, parent.id.trim());
                if (remaining <= 0) throw new CommandError(409, { error: 'budget_exhausted' });
                const tokenBudget = Math.min(b.tokenBudget ?? remaining, remaining);

                let reportThreadId: string | null = b.reportThreadId ?? parent.thread_id?.trim() ?? null;
                if (reportThreadId) {
                    const ok = await db.query(`SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL AND deleted_at IS NULL`, [reportThreadId, channelId]);
                    if (!ok.rows.length) throw new CommandError(400, { error: 'unknown_thread' });
                }

                // The child's thread: a subtask notice in the channel, then the brief from the parent agent
                const sessionId = generateUlid(), threadId = generateUlid();
                const content = `Subtask for ${childProfile.name}: ${title}`;
                const systemData = { kind: 'subtask', sessionId, parentSessionId: parent.id.trim(), profile: childProfile.name };
                await db.query(
                    `INSERT INTO messages (id, channel_id, author_id, content, system_event, system_data) VALUES ($1, $2, NULL, $3, 'subtask', $4)`,
                    [threadId, channelId, content, JSON.stringify(systemData)]
                );
                notices.push({ channelId: channelId.trim(), event: { id: threadId, content, authorId: null, authorUsername: null, channelId: channelId.trim(),
                    createdAt: new Date().toISOString(), systemEvent: 'subtask', systemData } });
                await db.query(
                    `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, started_by, workspace_id,
                         thread_id, parent_session_id, report_thread_id, title, token_budget)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [sessionId, parent.server_id, channelId, childBot, childProfile.id, parent.started_by, childProfile.workspace_id,
                     threadId, parent.id, reportThreadId, title, tokenBudget]
                );
                const posted = await insertBotMessage(db, { channelId, botId, content: brief, threadId, clientKey: b.client_key ?? null });
                notices.push(...posted);
                await db.query(
                    `INSERT INTO agent_inbox (id, session_id, message_id, thread_id, reason) VALUES ($1, $2, $3, $4, 'delegate')`,
                    [generateUlid(), sessionId, posted[0].event.id, threadId]
                );
                notices.push(await sessionUpdate(db, sessionId, false));
                const row = (await db.query(`${SESSION_SELECT} WHERE s.id = $1`, [sessionId])).rows[0];
                return { status: 201, body: { action: 'started', session: sessionJson(row) } };
            });
            request.pendingEvents ??= [];
            for (const n of notices) request.pendingEvents.push({ room: `channel:${n.channelId}`, event: n.eventName ?? 'Message', data: n.event });
            return reply.status(result.status).send(result.body);
        } catch (err: any) {
            if (err instanceof CommandError) return reply.status(err.status).send(err.body);
            // The same client_key raced another request, or the agent is already live in this thread
            if (err.code === '23505') return reply.status(409).send({ error: 'client_key_conflict' });
            throw err;
        }
    });
}

import type { Pool, PoolClient } from 'pg';
import { generateUlid } from '../utils/ulid';
import { postNotice, sessionUpdate, type Notice } from './agent-runs';

/**
 * Terminal sessions (#112, docs/agent-sessions.md "Terminal sessions"): an agent the user
 * runs in their own terminal and connects through agora-mcp with presence (src/lib/agent-presence.ts).
 *
 * - agora-mcp's bot socket connects in `channel` or `mcp` mode → one live terminal session per
 *   channel the bot is in (attachTerminal). Hosted runs pass `--no-presence`, so they never
 *   create one.
 * - While it is live, the bot's hosted channel session in that channel takes no wakes
 *   (routeMessage, src/lib/agent-sessions.ts): one responder per bot.
 * - agora-mcp reports working/idle and the tool calls it saw (terminalActivity). Token use
 *   is unknown for most CLIs, and no budget applies: Agora can't stop a user's own CLI.
 * - When the last socket goes, the session ends after a grace period (endTerminal); a
 *   heartbeat keeps seen_at fresh and sweepStaleTerminals ends rows nobody heartbeats
 *   (another API process died, or this one restarted). Ending releases its reservations
 *   (trigger in migration 041).
 *
 * These run on the pool as the table owner, in their own short transactions: the gateway has
 * no request transaction.
 */

export const HEARTBEAT_MS = 30_000;

/** How long a terminal session survives without a socket, for reconnects. */
export function terminalGraceMs(): number {
    const raw = Number(process.env.AGORA_TERMINAL_GRACE_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

export type TerminalMode = 'channel' | 'mcp';

export interface Attached { channelId: string; sessionId: string }

async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const result = await fn(c);
        await c.query('COMMIT');
        return result;
    } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        c.release();
    }
}

/** The text of the one-time notice when a terminal session and a hosted one overlap. */
export function standbyNotice(bot: string, hostedId: string): string {
    return `${bot} is connected from a terminal, so it answers from there. Its hosted session (${hostedId}) is on standby: `
        + 'messages do not wake it while the terminal is connected. Close the terminal (or end the hosted session) to switch.';
}

/**
 * Post the standby notice once per terminal session, if the bot also has a live hosted
 * channel session here. Runs inside the caller's transaction.
 */
export async function noticeStandby(c: PoolClient | any, channelId: string, botId: string, notices: Notice[]): Promise<void> {
    const row = (await c.query(
        `SELECT t.id, u.username, h.id AS hosted_id FROM agent_sessions t
         JOIN users u ON u.id = t.bot_id
         JOIN agent_sessions h ON h.channel_id = t.channel_id AND h.bot_id = t.bot_id AND h.kind = 'hosted'
              AND h.state = 'live' AND h.thread_id IS NULL
         WHERE t.channel_id = $1 AND t.bot_id = $2 AND t.kind = 'terminal' AND t.state = 'live' AND t.standby_notice_at IS NULL
         FOR UPDATE OF t`,
        [channelId, botId]
    )).rows[0];
    if (!row) return;
    await c.query('UPDATE agent_sessions SET standby_notice_at = NOW() WHERE id = $1', [row.id]);
    notices.push(await postNotice(c, channelId, standbyNotice(row.username, row.hosted_id.trim())));
}

/**
 * agora-mcp connected with presence: make (or keep) a live terminal session in each channel.
 * A session still in its grace period is reused, so a reconnect keeps its ID and reservations.
 */
export async function attachTerminal(pool: Pool, botId: string, channelIds: string[], mode: TerminalMode): Promise<{ attached: Attached[]; notices: Notice[] }> {
    if (channelIds.length === 0) return { attached: [], notices: [] };
    return tx(pool, async (c) => {
        const attached: Attached[] = [];
        const notices: Notice[] = [];
        const owner = (await c.query('SELECT bot_owner_id FROM users WHERE id = $1', [botId])).rows[0]?.bot_owner_id ?? null;
        for (const channelId of channelIds) {
            const channel = (await c.query('SELECT server_id FROM channels WHERE id = $1', [channelId])).rows[0];
            if (!channel) continue;
            const existing = (await c.query(
                `UPDATE agent_sessions SET seen_at = NOW(), terminal_mode = $3, last_active_at = NOW()
                 WHERE channel_id = $1 AND bot_id = $2 AND kind = 'terminal' AND state = 'live' RETURNING id`,
                [channelId, botId, mode]
            )).rows[0];
            let sessionId: string;
            if (existing) {
                sessionId = existing.id.trim();
            } else {
                sessionId = generateUlid();
                const inserted = await c.query(
                    `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, kind, started_by, terminal_mode, seen_at)
                     VALUES ($1, $2, $3, $4, NULL, 'terminal', $5, $6, NOW())
                     ON CONFLICT (channel_id, bot_id) WHERE state = 'live' AND kind = 'terminal' DO NOTHING RETURNING id`,
                    [sessionId, channel.server_id, channelId, botId, owner, mode]
                );
                if (!inserted.rows[0]) {
                    // Another socket of this bot attached first
                    sessionId = (await c.query(
                        `SELECT id FROM agent_sessions WHERE channel_id = $1 AND bot_id = $2 AND kind = 'terminal' AND state = 'live'`,
                        [channelId, botId]
                    )).rows[0].id.trim();
                }
            }
            attached.push({ channelId, sessionId });
            notices.push(await sessionUpdate(c, sessionId, false));
            await noticeStandby(c, channelId, botId, notices);
        }
        return { attached, notices };
    });
}

/** agora-mcp reported working/idle and its tool-call count. */
export async function terminalActivity(pool: Pool, botId: string, working: boolean, toolCalls: number | null): Promise<Notice[]> {
    return tx(pool, async (c) => {
        const rows = await c.query(
            `UPDATE agent_sessions SET working = $2, tool_calls = GREATEST(tool_calls, COALESCE($3, tool_calls)),
                 seen_at = NOW(), last_active_at = CASE WHEN $2 THEN NOW() ELSE last_active_at END
             WHERE bot_id = $1 AND kind = 'terminal' AND state = 'live' RETURNING id`,
            [botId, working, toolCalls]
        );
        const notices: Notice[] = [];
        for (const r of rows.rows) notices.push(await sessionUpdate(c, r.id.trim(), working));
        return notices;
    });
}

/** Keep the bots this process holds sockets for from being swept. */
export async function heartbeatTerminals(pool: Pool, botIds: string[]): Promise<void> {
    if (botIds.length === 0) return;
    await pool.query(
        `UPDATE agent_sessions SET seen_at = NOW() WHERE bot_id = ANY($1) AND kind = 'terminal' AND state = 'live'`,
        [botIds]
    );
}

async function endWhere(c: PoolClient, where: string, params: unknown[]): Promise<Notice[]> {
    const rows = await c.query(
        `UPDATE agent_sessions SET state = 'ended', end_reason = 'disconnected', ended_at = NOW(), working = false
         WHERE kind = 'terminal' AND state = 'live' AND ${where} RETURNING id`,
        params
    );
    const notices: Notice[] = [];
    for (const r of rows.rows) notices.push(await sessionUpdate(c, r.id.trim(), false));
    return notices;
}

/** Presence dropped and the grace period passed: end the bot's terminal sessions. */
export function endTerminal(pool: Pool, botId: string): Promise<Notice[]> {
    return tx(pool, c => endWhere(c, 'bot_id = $1', [botId]));
}

/** End terminal sessions nobody has heartbeated for longer than the grace period plus two beats. */
export function sweepStaleTerminals(pool: Pool, staleMs = terminalGraceMs() + 2 * HEARTBEAT_MS): Promise<Notice[]> {
    return tx(pool, c => endWhere(c, `(seen_at IS NULL OR seen_at < NOW() - $1 * interval '1 millisecond')`, [staleMs]));
}

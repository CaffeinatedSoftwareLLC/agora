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
 * - agora-mcp reports working/idle and the tool calls it saw (terminalActivity), and whether a
 *   chat_wait is open (terminalListening). A session neither working nor listening is idle
 *   (idle_since, #230): the chip says so, and handoff nudges don't count it as reached.
 * - The agent may report its context and usage-window use itself (agent_status,
 *   storeTerminalStatus); at 80% it gets one "hand off" notice. Token use is unknown for most
 *   CLIs, and no budget applies: Agora can't stop a user's own CLI.
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
 * `tokenId` is the bot token the socket authenticated with: the session records it (the
 * plan-owner rule counts a terminal as its owner's only for posts made with an owner-minted
 * token, src/lib/agent-sessions.ts). A session without one (live before migration 090) adopts
 * it. A socket with another token marks the session mixed (token_mixed): then no token speaks
 * for it until it ends.
 */
export async function attachTerminal(pool: Pool, botId: string, channelIds: string[], mode: TerminalMode, listening = mode === 'channel', tokenId: string | null = null): Promise<{ attached: Attached[]; notices: Notice[] }> {
    if (channelIds.length === 0) return { attached: [], notices: [] };
    return tx(pool, async (c) => {
        const attached: Attached[] = [];
        const notices: Notice[] = [];
        const owner = (await c.query('SELECT bot_owner_id FROM users WHERE id = $1', [botId])).rows[0]?.bot_owner_id ?? null;
        for (const channelId of channelIds) {
            const channel = (await c.query('SELECT server_id FROM channels WHERE id = $1', [channelId])).rows[0];
            if (!channel) continue;
            const existing = (await c.query(
                // A new socket on a row kept through the grace period may be a fresh CLI (a restart,
                // /clear): what the old one reported about itself, and its one limit warning, go
                `UPDATE agent_sessions SET seen_at = NOW(), terminal_mode = $3, last_active_at = NOW(), listening = $4,
                     idle_since = CASE WHEN $4 OR working THEN NULL ELSE COALESCE(idle_since, NOW()) END,
                     context_percent = NULL, usage_percent = NULL, usage_label = NULL, status_note = NULL,
                     status_at = NULL, limit_warned_at = NULL,
                     token_mixed = token_mixed OR (token_id IS NOT NULL AND token_id IS DISTINCT FROM $5::char(26)),
                     token_id = CASE WHEN token_mixed OR (token_id IS NOT NULL AND token_id IS DISTINCT FROM $5::char(26)) THEN NULL
                                     ELSE COALESCE(token_id, $5::char(26)) END
                 WHERE channel_id = $1 AND bot_id = $2 AND kind = 'terminal' AND state = 'live' RETURNING id`,
                [channelId, botId, mode, listening, tokenId]
            )).rows[0];
            let sessionId: string;
            if (existing) {
                sessionId = existing.id.trim();
            } else {
                sessionId = generateUlid();
                const inserted = await c.query(
                    `INSERT INTO agent_sessions (id, server_id, channel_id, bot_id, profile_id, kind, started_by, terminal_mode, seen_at, listening, idle_since, token_id)
                     VALUES ($1, $2, $3, $4, NULL, 'terminal', $5, $6, NOW(), $7, CASE WHEN $7 THEN NULL ELSE NOW() END, $8)
                     ON CONFLICT (channel_id, bot_id) WHERE state = 'live' AND kind = 'terminal' DO NOTHING RETURNING id`,
                    [sessionId, channel.server_id, channelId, botId, owner, mode, listening, tokenId]
                );
                if (!inserted.rows[0]) {
                    // Another socket of this bot attached first: as for a session already live above
                    sessionId = (await c.query(
                        `UPDATE agent_sessions SET token_mixed = token_mixed OR (token_id IS NOT NULL AND token_id IS DISTINCT FROM $3::char(26)),
                             token_id = CASE WHEN token_mixed OR (token_id IS NOT NULL AND token_id IS DISTINCT FROM $3::char(26)) THEN NULL
                                             ELSE COALESCE(token_id, $3::char(26)) END
                         WHERE channel_id = $1 AND bot_id = $2 AND kind = 'terminal' AND state = 'live' RETURNING id`,
                        [channelId, botId, tokenId]
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

/**
 * The tool name agora-mcp reports with Activity, as stored (#230): a short identifier only.
 * Anything else becomes null, so the UI never shows raw text from the socket.
 */
export function cleanToolName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const name = raw.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
    return name.length > 0 ? name : null;
}

/**
 * agora-mcp reported working/idle, its tool-call count and the last tool it called. A session
 * that is neither working nor listening is idle from the first such report (idle_since).
 */
export async function terminalActivity(pool: Pool, botId: string, working: boolean, toolCalls: number | null, lastTool: string | null = null): Promise<Notice[]> {
    return tx(pool, async (c) => {
        const rows = await c.query(
            `UPDATE agent_sessions SET working = $2, tool_calls = GREATEST(tool_calls, COALESCE($3, tool_calls)),
                 seen_at = NOW(), last_active_at = CASE WHEN $2 THEN NOW() ELSE last_active_at END,
                 idle_since = CASE WHEN $2 OR listening THEN NULL ELSE COALESCE(idle_since, NOW()) END,
                 last_tool = COALESCE($4, last_tool)
             WHERE bot_id = $1 AND kind = 'terminal' AND state = 'live' RETURNING id`,
            [botId, working, toolCalls, lastTool]
        );
        const notices: Notice[] = [];
        for (const r of rows.rows) notices.push(await sessionUpdate(c, r.id.trim(), working));
        return notices;
    });
}

/**
 * The bot's presence changed between listening (a chat_wait open, or a Claude Code Channel)
 * and not (#230): keep it on its live terminal sessions, with idle_since. Rows already in that
 * state are left alone, so a repeat posts no update.
 */
export async function terminalListening(pool: Pool, botId: string, listening: boolean): Promise<string[]> {
    // No AgentSessionUpdate: an mcp-mode agent flips twice per message it wakes on, and every
    // update makes each watcher reload its session list. Watchers see listening through
    // AgentPresence, and idle_since through the next session poll.
    const rows = await pool.query(
        `UPDATE agent_sessions SET listening = $2, seen_at = NOW(),
             idle_since = CASE WHEN $2 OR working THEN NULL ELSE COALESCE(idle_since, NOW()) END
         WHERE bot_id = $1 AND kind = 'terminal' AND state = 'live' AND listening <> $2 RETURNING id`,
        [botId, listening]
    );
    return rows.rows.map((r: any) => r.id.trim());
}

/** What an agent reports about itself through agora-mcp's agent_status tool (#230). */
export interface TerminalStatus {
    contextPercent?: number;
    usagePercent?: number;
    usageLabel?: string;
    note?: string;
}

/** At this share of its context or usage window, an agent should hand off. */
export const LIMIT_WARN_PERCENT = 80;

/** The one notice when a terminal agent reports it is near a limit. */
export function limitNotice(bot: string, contextPercent: number | null, usagePercent: number | null, usageLabel: string | null): string {
    const parts: string[] = [];
    if (contextPercent !== null && contextPercent >= LIMIT_WARN_PERCENT) parts.push(`context at ${contextPercent}%`);
    if (usagePercent !== null && usagePercent >= LIMIT_WARN_PERCENT) parts.push(`usage at ${usagePercent}%${usageLabel ? ` (${usageLabel})` : ''}`);
    return `${bot} reports ${parts.join(' and ')}. It should hand off before it runs out: post where the work stands, `
        + 'then continue in a fresh session.';
}

export interface LimitWarning {
    sessionId: string; channelId: string;
    contextPercent: number | null; usagePercent: number | null; usageLabel: string | null;
}

/**
 * Store an agent_status report on the bot's live terminal sessions, in the caller's transaction
 * as the table owner. Omitted fields keep their last value (a new usage percent without a label
 * clears the old label). Returns the sessions it updated and the ones that reached
 * LIMIT_WARN_PERCENT for the first time: their limit_warned_at is set here, so each warns once.
 */
export async function storeTerminalStatus(c: PoolClient | any, botId: string, status: TerminalStatus): Promise<{ updated: string[]; warn: LimitWarning[] }> {
    const rows = (await c.query(
        `UPDATE agent_sessions SET
             context_percent = COALESCE($2, context_percent),
             usage_percent = COALESCE($3, usage_percent),
             usage_label = CASE WHEN $3::smallint IS NOT NULL OR $4::text IS NOT NULL THEN $4 ELSE usage_label END,
             status_note = COALESCE($5, status_note),
             status_at = NOW(), seen_at = NOW(),
             -- Back under the line (a new usage window, a compacted context): the next approach warns again
             limit_warned_at = CASE WHEN COALESCE($2::smallint, context_percent, 0) < ${LIMIT_WARN_PERCENT}
                                     AND COALESCE($3::smallint, usage_percent, 0) < ${LIMIT_WARN_PERCENT}
                                    THEN NULL ELSE limit_warned_at END
         WHERE bot_id = $1 AND kind = 'terminal' AND state = 'live'
         RETURNING id, channel_id, context_percent, usage_percent, usage_label, limit_warned_at`,
        [botId, status.contextPercent ?? null, status.usagePercent ?? null, status.usageLabel ?? null, status.note ?? null]
    )).rows;
    const warn: LimitWarning[] = [];
    for (const r of rows) {
        const near = (r.context_percent ?? -1) >= LIMIT_WARN_PERCENT || (r.usage_percent ?? -1) >= LIMIT_WARN_PERCENT;
        if (!near || r.limit_warned_at) continue;
        const marked = await c.query(
            'UPDATE agent_sessions SET limit_warned_at = NOW() WHERE id = $1 AND limit_warned_at IS NULL RETURNING id', [r.id]);
        if (marked.rows.length === 0) continue;
        warn.push({ sessionId: r.id.trim(), channelId: r.channel_id.trim(), contextPercent: r.context_percent ?? null,
            usagePercent: r.usage_percent ?? null, usageLabel: r.usage_label ?? null });
    }
    return { updated: rows.map((r: any) => r.id.trim()), warn };
}

/** Keep the bots this process holds sockets for from being swept. */
export async function heartbeatTerminals(pool: Pool, botIds: string[]): Promise<void> {
    if (botIds.length === 0) return;
    await pool.query(
        `UPDATE agent_sessions SET seen_at = NOW() WHERE bot_id = ANY($1) AND kind = 'terminal' AND state = 'live'`,
        [botIds]
    );
}

/** Why a terminal session ended: its socket went away, or Claude Code's SessionEnd hook said so. */
export type TerminalEndReason = 'disconnected' | 'session_end';

async function endWhere(c: PoolClient, where: string, params: unknown[], reason: TerminalEndReason = 'disconnected'): Promise<Notice[]> {
    const rows = await c.query(
        `UPDATE agent_sessions SET state = 'ended', end_reason = '${reason}', ended_at = NOW(), working = false
         WHERE kind = 'terminal' AND state = 'live' AND ${where} RETURNING id`,
        params
    );
    const notices: Notice[] = [];
    for (const r of rows.rows) notices.push(await sessionUpdate(c, r.id.trim(), false));
    return notices;
}

/**
 * The agent's session is over (agora-mcp's SessionEnd hook, POST /bots/@me/terminal-sessions/end):
 * end the bot's terminal sessions now, in the caller's transaction (as the table owner). After
 * /clear agora-mcp keeps its socket; its next Listening or Activity attaches a fresh session
 * (reattachTerminal).
 */
export function endTerminalSessionNow(c: PoolClient | any, botId: string): Promise<Notice[]> {
    return endWhere(c, 'bot_id = $1', [botId], 'session_end');
}

/**
 * A still-connected presence socket reported Listening or Activity: if the bot has no live
 * terminal session (the SessionEnd hook ended it), attach one again. Null when one is live.
 */
export async function reattachTerminal(pool: Pool, botId: string, channelIds: string[], mode: TerminalMode, listening = mode === 'channel', tokenId: string | null = null): Promise<{ attached: Attached[]; notices: Notice[] } | null> {
    const live = await pool.query(`SELECT 1 FROM agent_sessions WHERE bot_id = $1 AND kind = 'terminal' AND state = 'live' LIMIT 1`, [botId]);
    if (live.rows.length > 0) return null;
    return attachTerminal(pool, botId, channelIds, mode, listening, tokenId);
}

/** Presence dropped and the grace period passed: end the bot's terminal sessions. */
export function endTerminal(pool: Pool, botId: string): Promise<Notice[]> {
    return tx(pool, c => endWhere(c, 'bot_id = $1', [botId]));
}

/** End terminal sessions nobody has heartbeated for longer than the grace period plus two beats. */
export function sweepStaleTerminals(pool: Pool, staleMs = terminalGraceMs() + 2 * HEARTBEAT_MS): Promise<Notice[]> {
    return tx(pool, c => endWhere(c, `(seen_at IS NULL OR seen_at < NOW() - $1 * interval '1 millisecond')`, [staleMs]));
}

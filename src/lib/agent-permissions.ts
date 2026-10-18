import type { PoolClient } from 'pg';
import { generateUlid } from '../utils/ulid';
import type { Notice } from './agent-runs';

/**
 * Tool permissions for hosted agents (#73) and rate-limit sleep (#87).
 *
 * Profiles carry tool presets and "always" rules; the host turns them into each CLI's own
 * allow flags at every claim (agora-host/src/presets.ts). When a run is denied a tool, the
 * host reports the rule that would allow it and the server posts an approval card in the
 * session's channel. The owner or a director approves it once (granted to the session's
 * next run) and the owner can approve it always (added to the profile).
 */

/** Same as agora-host's TOOL_RULE: a Claude permission rule or a Codex capability word. */
export const TOOL_RULE = '^[A-Za-z][A-Za-z0-9_]{0,99}(\\([^(),\\r\\n]{1,200}\\))?$';
export const PRESET_NAME = '^[a-z][a-z0-9_-]{0,31}$';
const toolRule = new RegExp(TOOL_RULE);

export const toolPresetsSchema = { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', pattern: PRESET_NAME } } as const;
export const allowedToolsSchema = { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 310, pattern: TOOL_RULE } } as const;
export const deniedToolsSchema = { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 310, pattern: TOOL_RULE } } as const;

/** How long an approval card can be answered. */
export const REQUEST_TTL_HOURS = 24;
/** Sleep bounds when the CLI's reset time is missing or implausible. */
export const DEFAULT_SLEEP_MS = 30 * 60 * 1000;
const MIN_SLEEP_MS = 60 * 1000;
const MAX_SLEEP_MS = 24 * 60 * 60 * 1000;

function systemMessage(id: string, channelId: string, content: string, systemEvent: string, systemData: Record<string, unknown>): Notice {
    return {
        channelId,
        event: { id, content, authorId: null, authorUsername: null, channelId, createdAt: new Date().toISOString(), systemEvent, systemData },
    };
}

export function cardText(profile: string, tool: string, status: string, who?: string): string {
    if (status === 'once') return `${who ?? 'Someone'} approved \`${tool}\` for ${profile} once.`;
    if (status === 'always') return `${who ?? 'Someone'} always allowed \`${tool}\` for ${profile}.`;
    if (status === 'denied') return `${who ?? 'Someone'} denied \`${tool}\` for ${profile}.`;
    return `${profile} was denied \`${tool}\`. Approve it once to let its next run use it, or always allow it for this agent (owner only).`;
}

/**
 * File approval requests for the tools a run was denied: one card per tool not already
 * allowed or pending. Runs inside the host call's transaction, session already locked.
 */
export async function fileDeniedTools(c: PoolClient, run: any, tools: string[] | undefined, notices: Notice[]): Promise<void> {
    const wanted = [...new Set((tools ?? []).filter(t => toolRule.test(t)))].slice(0, 10);
    if (wanted.length === 0) return;
    const s = await c.query(
        `SELECT s.server_id, s.channel_id, s.profile_id, p.name, p.allowed_tools FROM agent_sessions s
         JOIN agent_profiles p ON p.id = s.profile_id WHERE s.id = $1`,
        [run.session_id]
    );
    const session = s.rows[0];
    if (!session) return;
    const channelId = session.channel_id.trim();
    for (const tool of wanted) {
        if ((session.allowed_tools as string[]).includes(tool)) continue;
        const id = generateUlid();
        const inserted = await c.query(
            `INSERT INTO agent_tool_requests (id, server_id, session_id, profile_id, run_id, tool)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (session_id, tool) WHERE status = 'pending' DO NOTHING RETURNING id`,
            [id, session.server_id, run.session_id, session.profile_id, run.id, tool]
        );
        if (inserted.rows.length === 0) continue;
        const messageId = generateUlid();
        const data = { kind: 'agent_tool_approval', requestId: id, sessionId: run.session_id.trim(), profile: session.name, tool, status: 'pending' };
        const content = cardText(session.name, tool, 'pending');
        await c.query(
            `INSERT INTO messages (id, channel_id, author_id, content, system_event, system_data)
             VALUES ($1, $2, NULL, $3, 'agent_tool_approval', $4)`,
            [messageId, channelId, content, JSON.stringify(data)]
        );
        await c.query(`UPDATE agent_tool_requests SET message_id = $2 WHERE id = $1`, [id, messageId]);
        notices.push(systemMessage(messageId, channelId, content, 'agent_tool_approval', data));
    }
}

/**
 * One-time grants for a new run: approvals not yet used, or used by an earlier attempt of
 * the same batch (a retry keeps its grant).
 */
export async function takeGrants(c: PoolClient, sessionId: string, batchId: string, runId: string): Promise<string[]> {
    const rows = await c.query(
        `UPDATE agent_tool_requests SET consumed_by_run = $3
         WHERE session_id = $1 AND status = 'once'
           AND (consumed_by_run IS NULL OR consumed_by_run IN (SELECT id FROM agent_runs WHERE batch_id = $2 AND id <> $3))
         RETURNING tool`,
        [sessionId, batchId, runId]
    );
    return [...new Set(rows.rows.map((r: any) => r.tool as string))].slice(0, 50);
}

/** When a rate-limited session wakes: the CLI's reset time, kept within sane bounds. */
export function sleepUntil(resetAt: string | null | undefined, now = Date.now()): Date {
    const parsed = resetAt ? Date.parse(resetAt) : NaN;
    const ms = Number.isFinite(parsed) ? parsed - now : DEFAULT_SLEEP_MS;
    return new Date(now + Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, ms)));
}

/** "2 h 13 min" */
export function duration(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / 60000));
    const h = Math.floor(minutes / 60);
    return h > 0 ? `${h} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
}

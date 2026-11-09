import type { PoolClient } from 'pg';
import { generateUlid } from '../utils/ulid';
import type { Notice } from './agent-runs';
import { notifyApproval } from './notifications';

/**
 * Provider-terms guardrails (docs/provider-terms.md).
 *
 * A hosted profile runs its CLI on the CLI's own account login ('subscription') or on an
 * API key ('api_key'). Consumer subscriptions are personal: Anthropic's terms forbid
 * routing requests through Free/Pro/Max credentials on behalf of other users, and OpenAI
 * and Google say the same of their accounts. So only the server owner (the plan owner) and
 * their own automation may trigger a run on a subscription profile:
 *
 * - a direct message (mention, sole agent, thread reply) from the owner;
 * - the owner's /start or /resume;
 * - with servers.subscription_wakes = 'owner_bots' (the default): any post by the owner's own
 *   bot (ownerBotOf: bot_owner_id is the owner, on a token nobody else made, not from a hosted
 *   session someone else started), for every reason (direct, protocol, hand-off, lurk), to a
 *   session the owner started. Like the owner opening several CLIs on their own account;
 * - with 'owner_only': agent-to-agent hand-offs (agora-collab START/ACK/TURN/DECIDE, handoff
 *   offers) to a session the owner started, from a session the owner started or from the
 *   owner's own bot in a live terminal session opened with a personal or invite token the owner
 *   made (#361); lurk wakes for the owner's own messages only.
 *
 * Everyone else (other people, their bots, the owner's bot on a token someone else made or in a
 * run someone else started) is refused with a channel notice. api_key profiles keep the
 * ordinary authority rules (owner, directors, bots the owner allowed to direct).
 *
 * A profile with run approval (the host's requireRunApproval, forced on for a Gemini profile
 * on account login) also needs the owner to approve each wake on a card first.
 */

export type AuthMode = 'subscription' | 'api_key' | 'siwc';

export function subscriptionNotice(agent: string): string {
    return `${agent} runs on the owner's personal subscription; ask the owner, or configure an API key profile.`;
}

/**
 * The run's host refused a wake the server let through (agora-host checkTerms,
 * subscription_owner_only). Not the server's refusal text: the two have different causes, and
 * the usual one here is a host on an older agora-host than the server (a box not yet rebuilt
 * after a stack upgrade, a machine host not restarted).
 */
export function hostRefusalNotice(agent: string): string {
    return `${agent}'s host refused this run: it runs on the owner's personal subscription, and the host didn't count the message as the owner's. `
        + 'The server did, so if the owner or one of their own bots sent it, that host runs an older agora-host than the server: update it.';
}

/**
 * Plan-owned profiles (docs/codex-chatgpt-plan.md). A 'subscription' profile's plan belongs
 * to the server owner; a 'siwc' profile's to the person who connected their ChatGPT plan to
 * it (agent_profiles.plan_owner_id). Only the plan owner can wake either. api_key: nobody's.
 *
 * SQL for a profile's plan owner, given `p` (agent_profiles) and `srv` (servers) in scope.
 */
export const PLAN_OWNER_SQL = `(CASE WHEN p.auth_mode = 'siwc' THEN p.plan_owner_id WHEN p.auth_mode = 'subscription' OR p.host_mode THEN srv.owner_id END)`;

/**
 * Host mode (docs/agent-boxes.md §10): a profile run unboxed on a machine host is owner-only,
 * whatever its auth. An api_key profile in host mode follows the subscription rule (the server
 * owner wakes it); a siwc profile keeps its plan owner (the server owner or the person who
 * registered that machine's host). The auth mode the wake rules apply, given `p` in scope:
 */
export const WAKE_AUTH_SQL = `(CASE WHEN p.host_mode AND p.auth_mode = 'api_key' THEN 'subscription' ELSE p.auth_mode END)`;
/** The same for a profile row already read (needs auth_mode and host_mode). */
export function wakeAuthMode(row: { auth_mode?: string | null; host_mode?: boolean | null }): string | null {
    return row.host_mode && row.auth_mode === 'api_key' ? 'subscription' : row.auth_mode ?? null;
}

/**
 * Who besides the plan owner may wake a plan-owned agent (servers.subscription_wakes, migration
 * 091): 'owner_bots' adds the plan owner's own bots (ownerBotOf); 'owner_only' is the stricter
 * #361 rule.
 */
export type SubscriptionWakes = 'owner_bots' | 'owner_only';
export const SUBSCRIPTION_WAKES: readonly SubscriptionWakes[] = ['owner_bots', 'owner_only'];

export function subscriptionWakesOf(value: unknown): SubscriptionWakes {
    // Anything unexpected is the stricter mode
    return value === 'owner_bots' ? 'owner_bots' : 'owner_only';
}

/** The server's subscription_wakes setting. */
export async function serverSubscriptionWakes(db: any, serverId: string): Promise<SubscriptionWakes> {
    const row = (await db.query('SELECT subscription_wakes FROM servers WHERE id = $1', [serverId])).rows[0];
    return subscriptionWakesOf(row?.subscription_wakes);
}

/**
 * Whether a terminal session's posts on its own token count as its bot owner's, and why not
 * (agent-commands.ts OwnerTokenState): 'ok', or 'mixed', 'other_bot_owner', 'started_by_other',
 * 'agent_token' (a host's, box's or model agent's token), 'other_maker', 'owner_only_token'
 * (with 'owner_only' only a token the bot's owner made counts), 'no_token'. ONE definition for
 * the session chip (SESSION_SELECT) and for routing (ownerBotOf's terminal case), so the chip's
 * "counts as you" can't disagree with what wakes. `s`: the terminal session, `u`: its bot,
 * `srv`: its server (aliases in the caller's query).
 */
export function terminalOwnerStateSql(s = 's', u = 'u', srv = 'srv'): string {
    return `(CASE WHEN ${s}.token_mixed THEN 'mixed'
             WHEN ${u}.bot_owner_id IS NULL THEN 'other_bot_owner'
             WHEN ${s}.started_by IS NOT NULL AND ${s}.started_by <> ${u}.bot_owner_id THEN 'started_by_other'
             ELSE COALESCE((SELECT CASE WHEN tt.purpose NOT IN ('personal', 'invite') THEN 'agent_token'
                                        WHEN tt.created_by IS NOT NULL AND tt.created_by <> ${u}.bot_owner_id THEN 'other_maker'
                                        -- 'Only you' (owner_only, #361): only a token the bot's owner made counts
                                        WHEN ${srv}.subscription_wakes = 'owner_only' AND tt.created_by IS NULL THEN 'owner_only_token'
                                        ELSE 'ok' END
                            FROM bot_tokens tt WHERE tt.id = ${s}.token_id AND tt.bot_id = ${s}.bot_id AND tt.revoked_at IS NULL), 'no_token')
             END)`;
}

/**
 * Owner bots (subscription_wakes 'owner_bots'): whose own automation a bot's post is, for the
 * plan-owner rule. Returns the bot's owner when all of these hold, otherwise null:
 * - the author is a bot with an owner (users.bot_owner_id);
 * - the post was made with a live token of that bot that no other person made (created_by is
 *   NULL, i.e. Agora made it or it predates migration 090, or is the bot's owner). Never a
 *   model agent's token: a model agent answers any member, so its posts are not the owner's;
 * - no live terminal session of the bot in this channel is shared by two tokens (mixed);
 * - for a personal or invite token (a terminal or script the owner runs): either it is the token
 *   that opened the bot's live terminal session in this channel and that session counts
 *   (terminalOwnerStateSql 'ok', what its chip shows), or the bot has no live hosted
 *   session on the server that another person started (a subtask's session carries its
 *   parent's starter);
 * - for an agent host's or a box's token (what hosted runs get, also if it opened a terminal):
 *   only when the bot's hosted runs can only have been caused by its owner. The bot has a live
 *   hosted session on the server, and every one of them was started by the owner on an
 *   owner-only profile whose plan is the owner's (subscription or siwc, or a machine-host
 *   profile). An API-key agent in a box can be woken by a director, so its runs never count.
 * The caller compares the result with the target's plan owner. Needs the service role (reads
 * agent_sessions, agent_profiles and bot_tokens).
 */
export async function ownerBotOf(db: any, input: { botId: string; tokenId: string | null | undefined; channelId: string }): Promise<string | null> {
    if (!input.tokenId) return null;
    const hosted = `SELECT 1 FROM agent_sessions s
                    WHERE s.bot_id = u.id AND s.kind = 'hosted' AND s.state = 'live' AND s.server_id = ch.server_id`;
    const row = (await db.query(
        `SELECT u.bot_owner_id
         FROM users u
         JOIN bot_tokens t ON t.id = $2 AND t.bot_id = u.id AND t.revoked_at IS NULL
         JOIN channels ch ON ch.id = $3
         WHERE u.id = $1 AND u.bot = true AND u.bot_owner_id IS NOT NULL
           AND (t.created_by IS NULL OR t.created_by = u.bot_owner_id)
           AND t.purpose <> 'model'
           AND NOT EXISTS (SELECT 1 FROM agent_sessions s
                           WHERE s.bot_id = u.id AND s.channel_id = $3 AND s.kind = 'terminal' AND s.state = 'live' AND s.token_mixed)
           AND CASE WHEN t.purpose IN ('personal', 'invite') THEN
                    -- The token that opened the bot's terminal here, whose chip says it counts
                    EXISTS (SELECT 1 FROM agent_sessions ts JOIN servers tsrv ON tsrv.id = ts.server_id
                            WHERE ts.bot_id = u.id AND ts.channel_id = $3 AND ts.kind = 'terminal' AND ts.state = 'live' AND ts.token_id = $2
                              AND ${terminalOwnerStateSql('ts', 'u', 'tsrv')} = 'ok')
                    OR NOT EXISTS (${hosted} AND s.started_by IS NOT NULL AND s.started_by <> u.bot_owner_id)
               ELSE
                    EXISTS (${hosted})
                    AND NOT EXISTS (SELECT 1 FROM agent_sessions s
                                    JOIN agent_profiles p ON p.id = s.profile_id
                                    JOIN servers srv ON srv.id = s.server_id
                                    WHERE s.bot_id = u.id AND s.kind = 'hosted' AND s.state = 'live' AND s.server_id = ch.server_id
                                      AND (s.started_by IS DISTINCT FROM u.bot_owner_id
                                           OR ${WAKE_AUTH_SQL} = 'api_key'
                                           OR ${PLAN_OWNER_SQL} IS DISTINCT FROM u.bot_owner_id))
               END`,
        [input.botId, input.tokenId, input.channelId]
    )).rows[0];
    return row?.bot_owner_id?.trim() ?? null;
}

/** The channel notice for a wake the plan-owner rule refused. */
export function planNotice(agent: string, authMode: string | null | undefined, connected = true): string {
    if (authMode !== 'siwc') return subscriptionNotice(agent);
    if (!connected) return `${agent} isn't connected to a ChatGPT plan yet; connect it in Settings → Agents (Continue with ChatGPT), or configure an API key profile.`;
    return `${agent} runs on its plan owner's ChatGPT plan; only they can wake it. Ask them, or configure an API key profile.`;
}

export const PLAN_OWNER_ONLY = 'plan_owner_only';
export const PLAN_OWNER_ONLY_MESSAGE =
    "This agent runs on its plan owner's ChatGPT plan, so only they can start or resume it. Ask them, or configure an API key profile.";

/** Why a host refused or failed a run on a 'siwc' profile (agora-host/src/siwc). */
export const SIWC_ERRORS: Record<string, string> = {
    plan_owner_only: "runs on its plan owner's ChatGPT plan; its host refused a wake from someone else.",
    siwc_not_connected: "isn't connected to a ChatGPT plan on its host. Its plan owner connects it in Settings → Agents, or runs `agora-host siwc login` on the host.",
    siwc_scope_missing: "is signed in to ChatGPT, but plan use wasn't allowed. Its plan owner can Continue with ChatGPT again and allow it, or use an API key profile.",
    siwc_not_eligible: "can't use this ChatGPT plan: OpenAI said plan use is unavailable for this account, workspace or region (subscription_sharing_user_not_eligible). It needs ChatGPT Plus or Pro, or an API key profile.",
    siwc_usage_limit: "reached its ChatGPT plan's usage limit for apps. Check https://chatgpt.com/settings/usage.",
    siwc_reauth_required: 'lost its ChatGPT sign-in (expired or disconnected). Its plan owner connects it again in Settings → Agents.',
    siwc_plan_owner_mismatch: 'is connected on its host for a different Agora user than the server records. Its plan owner connects it again in Settings → Agents.',
};

export const SUBSCRIPTION_OWNER_ONLY = 'subscription_owner_only';
export const SUBSCRIPTION_OWNER_ONLY_MESSAGE =
    'This agent runs on the owner\'s personal subscription, so only the server owner can start or resume it. Ask the owner, or configure an API key profile.';

/** How long a run approval card can be answered. */
export const RUN_APPROVAL_TTL_HOURS = 24;

export function runCardText(profile: string, status: string, who?: string, preview?: string): string {
    if (status === 'approved') return `${who ?? 'The owner'} approved this run of ${profile}.`;
    if (status === 'denied') return `${who ?? 'The owner'} denied this run of ${profile}; its pending messages were dropped.`;
    if (status === 'expired') return `This run request for ${profile} expired.`;
    return `${profile} wants to run${preview ? ` for: "${preview}"` : ''}. It needs the owner's approval for every run. Approve to start it.`;
}

/**
 * Post a run approval card for a session with work waiting. Runs in the claim's
 * transaction with the session locked. Returns false when a pending card already exists.
 */
export async function requestRunApproval(c: PoolClient, session: { id: string; server_id: string; channel_id: string; profile_name: string },
                                         preview: string | null, notices: Notice[]): Promise<boolean> {
    const id = generateUlid();
    const inserted = await c.query(
        `INSERT INTO agent_run_approvals (id, server_id, session_id) VALUES ($1, $2, $3)
         ON CONFLICT (session_id) WHERE status = 'pending' DO NOTHING RETURNING id`,
        [id, session.server_id, session.id]
    );
    if (inserted.rows.length === 0) return false;
    const channelId = session.channel_id.trim();
    const messageId = generateUlid();
    const short = preview ? preview.replace(/\s+/g, ' ').trim().slice(0, 120) : undefined;
    const content = runCardText(session.profile_name, 'pending', undefined, short);
    const data = { kind: 'agent_run_approval', approvalId: id, sessionId: session.id.trim(), profile: session.profile_name, status: 'pending' };
    await c.query(
        `INSERT INTO messages (id, channel_id, author_id, content, system_event, system_data)
         VALUES ($1, $2, NULL, $3, 'agent_run_approval', $4)`,
        [messageId, channelId, content, JSON.stringify(data)]
    );
    await c.query(`UPDATE agent_run_approvals SET message_id = $2 WHERE id = $1`, [id, messageId]);
    await notifyApproval(c, { kind: 'run', channelId });
    notices.push({
        channelId,
        event: { id: messageId, content, authorId: null, authorUsername: null, channelId, createdAt: new Date().toISOString(), systemEvent: 'agent_run_approval', systemData: data },
    });
    return true;
}

/**
 * The run approval gate for a claim: 'held' when this retry's batch already holds an
 * approval, 'approved' when an unused approval lets it start (the caller marks it used),
 * otherwise 'waiting' (a card is pending, or one was just posted).
 */
export async function runApprovalGate(c: PoolClient, session: { id: string; server_id: string; channel_id: string; profile_name: string },
                                      batchId: string, isRetry: boolean, preview: string | null, notices: Notice[]): Promise<'held' | 'approved' | 'waiting'> {
    if (isRetry) {
        const held = await c.query(`SELECT 1 FROM agent_run_approvals WHERE session_id = $1 AND consumed_by_batch = $2 LIMIT 1`, [session.id, batchId]);
        if (held.rows.length > 0) return 'held';
    }
    const approved = await c.query(
        `SELECT id FROM agent_run_approvals WHERE session_id = $1 AND status = 'approved' AND consumed_by_batch IS NULL
         ORDER BY decided_at LIMIT 1 FOR UPDATE`,
        [session.id]
    );
    if (approved.rows[0]) return 'approved';
    // An unanswered card past its time expires; a new one is posted for the waiting work
    const stale = await c.query(
        `UPDATE agent_run_approvals SET status = 'expired' WHERE session_id = $1 AND status = 'pending'
           AND created_at < NOW() - make_interval(hours => $2) RETURNING message_id`,
        [session.id, RUN_APPROVAL_TTL_HOURS]
    );
    for (const row of stale.rows) {
        if (!row.message_id) continue;
        const content = runCardText(session.profile_name, 'expired');
        const updated = await c.query(
            `UPDATE messages SET content = $2, system_data = system_data || '{"status":"expired"}'::jsonb, edited_at = NOW()
             WHERE id = $1 RETURNING system_data, edited_at`,
            [row.message_id, content]
        );
        if (updated.rows[0]) notices.push({ channelId: session.channel_id.trim(), eventName: 'MessageUpdate',
            event: { id: row.message_id.trim(), channelId: session.channel_id.trim(), content, editedAt: updated.rows[0].edited_at, systemData: updated.rows[0].system_data } });
    }
    await requestRunApproval(c, session, preview, notices);
    return 'waiting';
}

/** Mark the approval that let this batch start as used by it. */
export async function consumeRunApproval(c: PoolClient, sessionId: string, batchId: string): Promise<void> {
    await c.query(
        `UPDATE agent_run_approvals SET consumed_by_batch = $2
         WHERE id = (SELECT id FROM agent_run_approvals WHERE session_id = $1 AND status = 'approved' AND consumed_by_batch IS NULL
                     ORDER BY decided_at LIMIT 1)`,
        [sessionId, batchId]
    );
}

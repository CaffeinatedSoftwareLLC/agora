import type { PoolClient } from 'pg';
import { generateUlid } from '../utils/ulid';
import type { Notice } from './agent-runs';

/**
 * Provider-terms guardrails (docs/provider-terms.md).
 *
 * A hosted profile runs its CLI on the CLI's own account login ('subscription') or on an
 * API key ('api_key'). Consumer subscriptions are personal: Anthropic's terms forbid
 * routing requests through Free/Pro/Max credentials on behalf of other users, and OpenAI
 * and Google say the same of their accounts. So only the server owner may trigger a run
 * on a subscription profile:
 *
 * - a direct message (mention, sole agent, thread reply) from the owner;
 * - the owner's /start or /resume;
 * - agent-to-agent hand-offs (agora-collab START/ACK/TURN/DECIDE) where both sessions were
 *   started by the owner;
 * - lurk wakes for the owner's own messages only.
 *
 * Everyone else's attempt is refused with a channel notice. api_key profiles keep the
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
 * Plan-owned profiles (docs/codex-chatgpt-plan.md). A 'subscription' profile's plan belongs
 * to the server owner; a 'siwc' profile's to the person who connected their ChatGPT plan to
 * it (agent_profiles.plan_owner_id). Only the plan owner can wake either. api_key: nobody's.
 *
 * SQL for a profile's plan owner, given `p` (agent_profiles) and `srv` (servers) in scope.
 */
export const PLAN_OWNER_SQL = `(CASE p.auth_mode WHEN 'subscription' THEN srv.owner_id WHEN 'siwc' THEN p.plan_owner_id END)`;

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

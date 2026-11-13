import { randomBytes } from 'crypto';
import { generateUlid } from '../utils/ulid';
import { mentionTokens } from '../routes/shared';
import { asService } from './agent-sessions';
import { hashClaimToken, postSessionNotice, sessionUpdate, type Notice } from './agent-runs';
import { cannotDirect, isServerOwner } from './direct-agents';
import { planNotice, PLAN_OWNER_SQL, WAKE_AUTH_SQL } from './provider-terms';

/**
 * Agent commands (docs/agent-commands.md): `@claude /compact` runs the CLI's own command in
 * that agent's session instead of reaching the model as chat.
 *
 * A message is a command when it @mentions exactly one agent and the rest of its text is a
 * single known slash command with at most a short argument. Anything else is an ordinary
 * message. Only commands in CONTROLS ever run, per adapter (ADAPTER_CONTROLS, mirrored by
 * agora-host's SESSION_COMMAND_TABLE); nothing from the message reaches a shell.
 *
 * Hosted sessions: 'stop' cancels the running run right away; 'compact', 'context' and 'clear'
 * become an agent_session_commands row the session's host claims when no run is going (a
 * queued command also holds back new runs for that session, so it goes next, never during
 * one). Terminal sessions (a person's own CLI connected through agora-mcp) can't be driven:
 * Claude Code treats a channel message as text and has no way for an MCP server to run a
 * command, so the answer is a notice that says where to type it.
 */

export type ControlName = 'compact' | 'context' | 'clear' | 'stop' | 'model';
export type HostControl = 'compact' | 'context' | 'clear';

interface ControlDef {
    summary: string;
    /** Only the server owner may send it (it deletes the conversation). */
    ownerOnly: boolean;
    /** The agent host runs it (a queued row); otherwise the server does it itself. */
    viaHost: boolean;
    /** Said when the agent's CLI has none. */
    unsupported: string;
    /** Said for a terminal session. */
    terminal: string;
}

export const CONTROLS: Record<ControlName, ControlDef> = {
    compact: { summary: 'Compact the conversation', ownerOnly: false, viaHost: true,
        unsupported: 'has no compact command.', terminal: 'type /compact there.' },
    context: { summary: 'Show how full the context is', ownerOnly: false, viaHost: true,
        unsupported: 'has no context command Agora can run.', terminal: 'type /context there.' },
    clear: { summary: 'Start a fresh conversation', ownerOnly: true, viaHost: true,
        unsupported: 'has no clear command.', terminal: 'type /clear there.' },
    stop: { summary: 'Stop the current run', ownerOnly: false, viaHost: false,
        unsupported: 'cannot be stopped this way.', terminal: 'press Esc there.' },
    // Known so that `/model` gets an answer, not a model turn; no CLI can switch model for a conversation Agora resumes
    model: { summary: 'Switch model', ownerOnly: true, viaHost: false,
        unsupported: "can't switch model from a message: the CLI's /model lasts one process, and each wake is a new one. Set the model in Settings → Agents.",
        terminal: 'type /model there.' },
};

/** What each adapter's CLI can do for a hosted session. `stop` works for every adapter (it is the run's own cancel). */
export const ADAPTER_CONTROLS: Record<string, ControlName[]> = {
    claude: ['compact', 'context', 'clear', 'stop'],
    codex: ['compact', 'clear', 'stop'],
    gemini: ['clear', 'stop'],
    opencode: ['clear', 'stop'],
    omp: ['clear', 'stop'],
    devin: ['clear', 'stop'],
};

export function controlsOf(adapter: string | null | undefined): Array<{ name: ControlName; summary: string; ownerOnly: boolean }> {
    return (ADAPTER_CONTROLS[adapter ?? ''] ?? []).map(name => ({ name, summary: CONTROLS[name].summary, ownerOnly: CONTROLS[name].ownerOnly }));
}

/** A host that polled this recently has the command queue (the poll says `?v=1`). */
export const HOST_SEEN_SECONDS = 120;
/** A queued command nobody claimed for this long is given up on, so it can't hold the session. */
export const QUEUED_EXPIRY_SECONDS = 600;

/**
 * `@name /command arg` in any order of mention and command; null when the text isn't one. The argument is
 * one model-name-like word (never prose, never a path), so `@claude /compact and review it` stays chat.
 */
export function parseControl(content: string | null): { name: ControlName; arg: string | null; mention: string } | null {
    const text = content ?? '';
    const tokens = mentionTokens(text);
    if (tokens.length !== 1 || tokens[0] === 'everyone') return null;
    if ((text.match(/@[\w-]+/g) ?? []).length !== 1) return null;
    const rest = text.replace(/@[\w-]+/, ' ').trim();
    const m = /^\/([a-z]{2,16})(?:[ \t]+([A-Za-z0-9][A-Za-z0-9._:\/-]{0,63}))?$/.exec(rest);
    if (!m || !Object.prototype.hasOwnProperty.call(CONTROLS, m[1])) return null;
    return { name: m[1] as ControlName, arg: m[2]?.trim() || null, mention: tokens[0] };
}

/** The staleness test shared by every place that looks at a queued or claimed command. */
const STALE_SQL = (alias = '') => `((${alias}status = 'queued' AND ${alias}created_at < NOW() - make_interval(secs => ${QUEUED_EXPIRY_SECONDS}))
    OR (${alias}status = 'claimed' AND ${alias}lease_until < NOW()))`;
export const LIVE_COMMAND_SQL = (alias = '') => `(${alias}status IN ('queued', 'claimed') AND NOT ${STALE_SQL(alias)})`;

/**
 * Give up on commands nobody claimed for a while, or whose lease ran out (a session's, or all of a host's), so none
 * holds a session. Each gets its failure notice. Returns the notices to emit.
 */
export async function expireStale(db: any, scope: { sessionId?: string; hostId?: string }): Promise<Notice[]> {
    const expired = (await db.query(
        `UPDATE agent_session_commands SET status = 'failed', result = '{"error":"expired"}', finished_at = NOW()
         WHERE ${scope.sessionId ? 'session_id = $1' : 'host_id = $1'} AND ${STALE_SQL()} RETURNING *`,
        [scope.sessionId ?? scope.hostId])).rows;
    const notices: Notice[] = [];
    for (const c of expired) notices.push(...await finishCommand(db, c, false, { error: 'expired' }));
    return notices;
}

/** SQL for "a session command holds this session" (a live queued one, or one with a live lease), given the session id expression. */
export const SESSION_COMMAND_HOLDS_SQL = (sessionId: string) => `SELECT 1 FROM agent_session_commands WHERE session_id = ${sessionId} AND ${LIVE_COMMAND_SQL()}`;

export interface ControlInput {
    channelId: string;
    messageId: string;
    /** Thread parent for a reply, null for a top-level post. */
    threadId: string | null;
    authorId: string;
    authorIsBot: boolean;
    /** The author's authority stamp, taken in this transaction (stampAuthority). */
    couldDirect: boolean;
    content: string;
    mentionedUsers: Array<{ id: string; bot: boolean }>;
}

/** 182000 -> "182k", 1000000 -> "1m", 61300 -> "61.3k" */
export function compactNumber(n: number): string {
    if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}m`;
    if (n >= 1000) return `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
    return String(n);
}

/**
 * Handle a message that is a command. Returns null when it is an ordinary message (the caller
 * routes it as before); otherwise the notices to emit after commit.
 */
export async function handleControlMessage(db: any, input: ControlInput): Promise<Notice[] | null> {
    const parsed = parseControl(input.content);
    if (!parsed) return null;
    const bot = input.mentionedUsers.length === 1 ? input.mentionedUsers[0] : null;
    if (!bot?.bot) return null;
    const run = await runControl(db, { ...input, botId: bot.id.trim(), agentName: parsed.mention, name: parsed.name, arg: parsed.arg });
    return run.outcome === 'not_agent' ? null : run.notices;
}

export interface ControlRequest {
    channelId: string; messageId: string | null; threadId: string | null;
    authorId: string; authorIsBot: boolean; couldDirect: boolean;
    botId: string; agentName: string; name: ControlName; arg: string | null;
}
export type ControlOutcome = 'queued' | 'done' | 'refused' | 'not_agent';

/**
 * Check a command and carry it out: every refusal is a notice (and nothing is sent); 'stop'
 * is done here; the rest are queued for the session's host. Everything the person should hear
 * is a system notice in the message's thread or channel.
 */
export async function runControl(db: any, input: ControlRequest): Promise<{ outcome: ControlOutcome; notices: Notice[] }> {
    return asService(db, async () => {
        const botId = input.botId;
        const channelId = input.channelId.trim();
        const notices: Notice[] = [];
        // Does this bot work as an agent here? One that isn't gets an ordinary message
        const profiles = await db.query(
            `SELECT p.id FROM agent_profiles p JOIN channels c ON c.server_id = p.server_id WHERE p.bot_id = $1 AND c.id = $2 LIMIT 1`,
            [botId, channelId]);
        const terminal = await db.query(
            `SELECT 1 FROM agent_sessions WHERE channel_id = $1 AND bot_id = $2 AND state = 'live' AND kind = 'terminal' LIMIT 1`,
            [channelId, botId]);
        if (!profiles.rows.length && !terminal.rows.length) return { outcome: 'not_agent' as ControlOutcome, notices };

        let outcome: ControlOutcome = 'refused';
        const say = async (text: string) => { notices.push(...await postSessionNotice(db, channelId, input.threadId, text)); };
        const name = input.agentName;
        const def = CONTROLS[input.name];
        const who = (await db.query('SELECT username FROM users WHERE id = $1', [input.authorId])).rows[0]?.username ?? 'someone';
        const result = (o: ControlOutcome) => ({ outcome: o, notices });

        // The same authority as /start, /end and /resume
        if (!input.couldDirect) { await say((await cannotDirect(db, channelId, input.authorId)).message); return result(outcome); }

        if (terminal.rows.length) { await say(`${name} is connected from a terminal; ${def.terminal} Agora can't type into your terminal.`); return result(outcome); }

        // Its session: one scoped to this thread, else the channel's
        const target = (await db.query(
            `SELECT s.id, s.state, s.thread_id, s.profile_id, s.server_id, p.adapter, p.name AS profile_name, p.host_id, p.generation,
                    ${WAKE_AUTH_SQL} AS auth_mode, ${PLAN_OWNER_SQL} AS plan_owner_id,
                    h.revoked_at AS host_revoked, h.session_commands_seen_at > NOW() - make_interval(secs => $4) AS host_ready
             FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id JOIN servers srv ON srv.id = s.server_id
             JOIN agent_hosts h ON h.id = p.host_id
             WHERE s.channel_id = $1 AND s.bot_id = $2 AND s.state = 'live' AND s.kind = 'hosted'
               AND (s.thread_id IS NULL OR s.thread_id = $3)
             ORDER BY (s.thread_id IS NOT NULL) DESC, s.id DESC LIMIT 1 FOR UPDATE OF s`,
            [channelId, botId, input.threadId, HOST_SEEN_SECONDS])).rows[0];
        if (!target) { await say(`${name} has no live session here, so /${input.name} did nothing. Start one with /start ${name}.`); return result(outcome); }
        const sessionId = target.id.trim();
        const serverId = target.server_id.trim();

        if (!(ADAPTER_CONTROLS[target.adapter] ?? []).includes(input.name)) { await say(`${name} ${def.unsupported}`); return result(outcome); }

        // A command counts like a wake (docs/provider-terms.md): a subscription or plan-owned agent only answers its plan owner
        if (target.auth_mode !== 'api_key') {
            if (input.authorIsBot || !target.plan_owner_id || target.plan_owner_id.trim() !== input.authorId.trim()) {
                await say(planNotice(name, target.auth_mode, !!target.plan_owner_id)); return result(outcome);
            }
        }
        if (def.ownerOnly && (input.authorIsBot || !await isServerOwner(db, serverId, input.authorId))) {
            await say(`Only the server owner can send /${input.name} to ${name}.`); return result(outcome);
        }
        if (input.arg) { await say(`/${input.name} takes no arguments.`); return result(outcome); }

        if (input.name === 'stop') {
            const stopped = await db.query(
                `UPDATE agent_runs SET cancel_requested = true, cancel_reason = 'stopped' WHERE session_id = $1 AND status = 'claimed' AND NOT cancel_requested RETURNING id`,
                [sessionId]);
            if (!stopped.rows.length) { await say(`${name} isn't running anything.`); return result(outcome); }
            await say(`${who} asked ${name} to stop its current run.`);
            return result('done');
        }
        if (!def.viaHost) { await say(`${name} ${def.unsupported}`); return result(outcome); }

        if (target.host_revoked || !target.host_ready) {
            await say(`${name}'s agent host isn't answering commands (it is offline, or agora-host is older than the version that supports them), so /${input.name} was not sent.`);
            return result(outcome);
        }
        // A command nobody claimed for a while, or whose host went quiet, is given up on first
        notices.push(...await expireStale(db, { sessionId }));
        const pending = await db.query(`SELECT command FROM agent_session_commands WHERE session_id = $1 AND ${LIVE_COMMAND_SQL()}`, [sessionId]);
        if (pending.rows.length) { await say(`${name} already has /${pending.rows[0].command} waiting; send /${input.name} after it finishes.`); return result(outcome); }
        await db.query(
            `INSERT INTO agent_session_commands (id, session_id, host_id, profile_generation, requested_by, message_id, thread_id, command)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [generateUlid(), sessionId, target.host_id, target.generation, input.authorId, input.messageId, input.threadId, input.name]);
        // The session sheet shows it waiting; the result is the notice
        notices.push(await sessionUpdate(db, sessionId, false));
        return result('queued');
    });
}

export const COMMAND_RESULT_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['claimToken', 'success', 'result'],
    properties: {
        claimToken: { type: 'string', minLength: 10, maxLength: 200 },
        success: { type: 'boolean' },
        result: {
            type: 'object', additionalProperties: false,
            properties: {
                error: { type: 'string', maxLength: 120, pattern: '^[a-z][a-z0-9_]*$' },
                message: { type: 'string', maxLength: 300 },
                tokensBefore: { type: 'integer', minimum: 0, maximum: 1e10 }, tokensAfter: { type: 'integer', minimum: 0, maximum: 1e10 },
                contextTokens: { type: 'integer', minimum: 0, maximum: 1e10 }, contextWindow: { type: 'integer', minimum: 0, maximum: 1e10 },
                text: { type: 'string', maxLength: 1500 },
            },
        },
    },
} as const;

const FAILURES: Record<string, string> = {
    no_conversation: 'there is no conversation to work on yet',
    compact_failed: 'the CLI could not compact it',
    context_failed: 'the CLI did not report its context',
    not_a_command: 'the CLI did not recognise the command',
    unsupported: "this agent's CLI has no such command",
    session_busy: 'a run started first',
    timeout: 'it took too long',
    app_server_failed: "the CLI's app server refused",
    app_server_exited: "the CLI's app server stopped",
    launch_failed: 'the host could not start the CLI',
    spawn_failed: 'the host could not start the CLI',
    expired: 'no host picked it up',
};

/** The one notice a finished command posts, and (for clear) the session reset. */
export async function finishCommand(db: any, c: any, success: boolean, result: any): Promise<Notice[]> {
    const sessionId = c.session_id.trim();
    const row = (await db.query(
        `SELECT s.channel_id, COALESCE(u.username, p.name) AS agent, r.username AS requester FROM agent_sessions s
         JOIN agent_profiles p ON p.id = s.profile_id LEFT JOIN users u ON u.id = s.bot_id LEFT JOIN users r ON r.id = $2
         WHERE s.id = $1`, [sessionId, c.requested_by])).rows[0];
    if (!row) return [];
    const channelId = row.channel_id.trim(), agent = row.agent;
    const threadId = c.thread_id?.trim() ?? null;
    const notices: Notice[] = [];
    let text: string;
    if (!success) {
        const code = String(result.error ?? 'command_failed');
        const why = FAILURES[code] ?? 'the host reported an error';
        text = `${agent}: /${c.command} failed: ${why}${code === 'compact_failed' && result.message ? ` (${String(result.message).replace(/\s+/g, ' ').slice(0, 200)})` : ''}.`;
    } else if (c.command === 'compact') {
        text = typeof result.tokensBefore === 'number' && typeof result.tokensAfter === 'number'
            ? `${agent} compacted its conversation: ${compactNumber(result.tokensBefore)} to ${compactNumber(result.tokensAfter)} tokens.`
            : `${agent} compacted its conversation: done.`;
    } else if (c.command === 'context') {
        text = typeof result.contextTokens === 'number' && typeof result.contextWindow === 'number' && result.contextWindow > 0
            ? `${agent}'s context: ${compactNumber(result.contextTokens)} of ${compactNumber(result.contextWindow)} tokens (${Math.round(100 * result.contextTokens / result.contextWindow)}%).`
            : `${agent}'s context: ${String(result.text ?? 'no figures reported').split('\n').map((l: string) => l.trim()).find(Boolean)?.slice(0, 200) ?? 'no figures reported'}`;
    } else {
        // clear: the next wake starts a fresh CLI conversation; the channel history still catches it up
        await db.query(`UPDATE agent_sessions SET native_session_id = NULL, summary = $2 WHERE id = $1`,
            [sessionId, 'The conversation was cleared. Read channel history for context.']);
        text = `${agent} started a fresh conversation${row.requester ? ` (${row.requester}'s /clear)` : ''}. Earlier messages stay in the channel history.`;
    }
    notices.push(...await postSessionNotice(db, channelId, threadId, text));
    notices.push(await sessionUpdate(db, sessionId, false));
    return notices;
}

/** The oldest queued command for a host that no run or other command holds back; claimed in place. */
export async function claimCommand(db: any, host: { id: string; serverId: string }, emit: (n: Notice) => void): Promise<any | null> {
    await db.query('UPDATE agent_hosts SET session_commands_seen_at = NOW() WHERE id = $1', [host.id]);
    for (const n of await expireStale(db, { hostId: host.id })) emit(n);
    const candidates = (await db.query(
        `SELECT c.id, c.session_id, s.channel_id FROM agent_session_commands c JOIN agent_sessions s ON s.id = c.session_id
         WHERE c.host_id = $1 AND s.server_id = $2 AND c.status = 'queued' ORDER BY c.id LIMIT 20`, [host.id, host.serverId])).rows;
    for (const cand of candidates) {
        // Profile before session, as everywhere else
        const meta = await db.query('SELECT profile_id FROM agent_sessions WHERE id = $1', [cand.session_id]);
        if (!meta.rows[0]) continue;
        await db.query('SELECT 1 FROM agent_profiles WHERE id = $1 FOR SHARE', [meta.rows[0].profile_id]);
        const s = (await db.query(
            `SELECT s.*, p.name AS profile, p.adapter, p.host_id, p.generation, p.workdir_alias FROM agent_sessions s JOIN agent_profiles p ON p.id = s.profile_id
             WHERE s.id = $1 FOR UPDATE OF s`, [cand.session_id])).rows[0];
        const c = (await db.query(`SELECT * FROM agent_session_commands WHERE id = $1 AND status = 'queued' FOR UPDATE SKIP LOCKED`, [cand.id])).rows[0];
        if (!s || !c) continue;
        if (s.state !== 'live' || s.host_id.trim() !== host.id || s.generation !== c.profile_generation) {
            await db.query(`UPDATE agent_session_commands SET status = 'failed', result = '{"error":"binding_changed"}', finished_at = NOW() WHERE id = $1`, [c.id]);
            continue;
        }
        // Waits its turn: never while a run is going
        if ((await db.query(`SELECT 1 FROM agent_runs WHERE session_id = $1 AND status = 'claimed'`, [s.id])).rows.length) continue;
        const token = randomBytes(32).toString('hex');
        await db.query(`UPDATE agent_session_commands SET status = 'claimed', claim_token_hash = $2, lease_until = NOW() + INTERVAL '180 seconds' WHERE id = $1`, [c.id, hashClaimToken(token)]);
        return { id: c.id.trim(), claimToken: token, sessionId: s.id.trim(), profile: s.profile, adapter: s.adapter,
            workdirAlias: s.workdir_alias, nativeSessionId: s.native_session_id ?? null, command: c.command, arg: null };
    }
    return null;
}

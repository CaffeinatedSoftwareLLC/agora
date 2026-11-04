import { randomBytes } from 'node:crypto';
import { generateUlid } from '../../utils/ulid';
import { hashPassword } from '../../auth/passwords';
import { usernameTaken } from '../usernames';
import { encryptString } from '../encryption';
import { config } from '../../config';
import { defaultAllowlist } from './contract';

/**
 * Box rows from the owner API (docs/agent-boxes.md §8, §9). Everything here runs as the table
 * owner (asService in the routes): the box tables have no app_user grants.
 *
 * Creating a box writes rows only. boxd provisions the container and mints the box's host and
 * bot tokens at its first container creation (src/lib/boxes/tokens.ts, generation 0 → 1), so
 * the host starts with an unusable secret and the bot with no token.
 */

export class BoxError extends Error {
    constructor(public status: number, public code: string, public detail?: string) { super(code); }
}

export const BOX_ADAPTERS = ['claude', 'codex'] as const;
export type BoxAdapter = typeof BOX_ADAPTERS[number];
/** The variable the box's CLI reads its key from (agora-host src/adapters.ts: codex reads only CODEX_API_KEY). */
export const API_KEY_ENV: Record<BoxAdapter, string> = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY' };
/** A deleted box's home volume is kept this long (§9.6). */
export const DELETE_GRACE_DAYS = 7;
export const REPO_PATTERN = '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$';

export function parseRepo(full: string): { owner: string; repo: string } {
    const [owner, repo] = full.split('/');
    if (!new RegExp(REPO_PATTERN).test(full) || repo === '.' || repo === '..') throw new BoxError(400, 'invalid_repo', full);
    return { owner, repo };
}

function uniqueRepos(repos: string[] | undefined): { owner: string; repo: string }[] {
    const seen = new Map<string, { owner: string; repo: string }>();
    for (const r of repos ?? []) {
        const parsed = parseRepo(r);
        seen.set(`${parsed.owner}/${parsed.repo}`.toLowerCase(), parsed);
    }
    return [...seen.values()];
}

async function requireChannel(db: any, serverId: string, channelId: string): Promise<void> {
    const ch = await db.query(`SELECT 1 FROM channels WHERE id = $1 AND server_id = $2`, [channelId, serverId]);
    if (ch.rows.length === 0) throw new BoxError(400, 'unknown_channel');
}

async function grantChannel(db: any, botId: string, channelId: string, userId: string): Promise<void> {
    await db.query(
        `INSERT INTO bot_channel_access (bot_id, channel_id, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [botId, channelId, userId]
    );
}

export interface CreateBoxInput {
    serverId: string;
    userId: string;
    name: string;
    adapter: BoxAdapter;
    auth?: 'subscription' | 'api_key';
    apiKey?: string;
    homeChannelId: string;
    repos?: string[];
    model?: string | null;
    effort?: string | null;
}

/** The box's bot, host, profile, box row and repos, in the caller's transaction. Returns the box ID. */
export async function createBox(db: any, input: CreateBoxInput): Promise<string> {
    const auth = input.auth ?? 'subscription';
    if (auth === 'api_key' && !input.apiKey) throw new BoxError(400, 'api_key_required');
    if (auth !== 'api_key' && input.apiKey) throw new BoxError(400, 'api_key_needs_api_key_auth');
    await requireChannel(db, input.serverId, input.homeChannelId);
    const repos = uniqueRepos(input.repos);
    // Same checks as Settings → Agents (POST /servers/:id/agents): one name for the bot and its profile
    if (await usernameTaken(db, input.name)) throw new BoxError(409, 'name_taken');
    const profileName = await db.query(`SELECT 1 FROM agent_profiles WHERE server_id = $1 AND name = $2`, [input.serverId, input.name]);
    if (profileName.rows.length) throw new BoxError(409, 'name_taken');

    const boxId = generateUlid(), botId = generateUlid(), hostId = generateUlid(), profileId = generateUlid();
    // Nobody knows this secret: the host is unusable until boxd mints its real one
    const placeholder = await hashPassword(randomBytes(32).toString('hex'));
    const key = input.apiKey ? encryptString(input.apiKey, config.encryptionKey) : null;

    await db.query(
        `INSERT INTO users (id, username, bot, bot_owner_id, server_id) VALUES ($1, $2, true, $3, $4)`,
        [botId, input.name, input.userId, input.serverId]
    );
    await grantChannel(db, botId, input.homeChannelId, input.userId);
    await db.query(
        `INSERT INTO agent_hosts (id, server_id, name, secret_hash, created_by, kind, box_id)
         VALUES ($1, $2, $3, $4, $5, 'box', $6)`,
        [hostId, input.serverId, `box-${input.name}`, placeholder, input.userId, boxId]
    );
    await db.query(
        `INSERT INTO agent_profiles (id, server_id, name, bot_id, host_id, adapter, model, effort, workdir_alias, created_by,
                                     auth_mode, api_key_env, host_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'work', $9, $10, $11, false)`,
        [profileId, input.serverId, input.name, botId, hostId, input.adapter, input.model ?? null, input.effort ?? null, input.userId,
         auth, auth === 'api_key' ? API_KEY_ENV[input.adapter] : null]
    );
    await db.query(
        `INSERT INTO agent_boxes (id, server_id, profile_id, host_id, home_channel_id, allowed_domains,
                                  api_key_env, api_key_enc, api_key_iv, api_key_tag, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [boxId, input.serverId, profileId, hostId, input.homeChannelId, defaultAllowlist(input.adapter),
         key ? API_KEY_ENV[input.adapter] : null, key?.encrypted ?? null, key?.iv ?? null, key?.authTag ?? null, input.userId]
    );
    for (const r of repos) {
        await db.query(`INSERT INTO box_repos (box_id, owner, repo) VALUES ($1, $2, $3)`, [boxId, r.owner, r.repo]);
    }
    return boxId;
}

export interface PatchBoxInput {
    allowedDomains?: string[];
    repos?: string[];
    cpus?: number;
    memoryMb?: number;
    pids?: number;
    homeChannelId?: string;
}

export async function patchBox(db: any, box: { id: string; server_id: string; bot_id: string }, patch: PatchBoxInput, userId: string): Promise<void> {
    if (patch.homeChannelId) {
        await requireChannel(db, box.server_id, patch.homeChannelId);
        await grantChannel(db, box.bot_id, patch.homeChannelId, userId);
    }
    const domains = patch.allowedDomains ? [...new Set(patch.allowedDomains.map(d => d.toLowerCase()))] : null;
    await db.query(
        `UPDATE agent_boxes SET
            allowed_domains = COALESCE($2, allowed_domains),
            cpus = COALESCE($3, cpus), memory_mb = COALESCE($4, memory_mb), pids = COALESCE($5, pids),
            home_channel_id = COALESCE($6, home_channel_id), updated_at = NOW()
         WHERE id = $1`,
        [box.id, domains, patch.cpus ?? null, patch.memoryMb ?? null, patch.pids ?? null, patch.homeChannelId ?? null]
    );
    if (patch.repos) {
        // Keep rows that stay (their default branch is cached); boxd clones new ones on its next pass
        const repos = uniqueRepos(patch.repos);
        const keep = repos.map(r => `${r.owner}/${r.repo}`.toLowerCase());
        await db.query(`DELETE FROM box_repos WHERE box_id = $1 AND NOT (lower(owner || '/' || repo) = ANY($2))`, [box.id, keep]);
        for (const r of repos) {
            await db.query(
                `INSERT INTO box_repos (box_id, owner, repo) SELECT $1, $2::varchar, $3::varchar
                 WHERE NOT EXISTS (SELECT 1 FROM box_repos WHERE box_id = $1 AND lower(owner) = lower($2::varchar) AND lower(repo) = lower($3::varchar))`,
                [box.id, r.owner, r.repo]
            );
        }
    }
}

/**
 * Delete (§9.6): the box's host and every token of its bot stop working in this transaction;
 * boxd removes the container and network, and the home volume after the grace period.
 */
export async function deleteBox(db: any, box: { id: string; host_id: string; bot_id: string }): Promise<void> {
    await db.query(
        `UPDATE agent_boxes SET desired_state = 'deleted', deleted_at = NOW(), pending_action = NULL, action_requested_at = NULL,
                volume_purge_after = NOW() + make_interval(days => $2), login_state = 'none', updated_at = NOW()
         WHERE id = $1`,
        [box.id, DELETE_GRACE_DAYS]
    );
    await db.query(`UPDATE agent_hosts SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [box.host_id]);
    // Every token of the box's bot, not only the box-bound ones: a box bot holds no other
    await db.query(`UPDATE bot_tokens SET revoked_at = NOW() WHERE bot_id = $1 AND revoked_at IS NULL`, [box.bot_id]);
    await db.query(
        `UPDATE box_login_requests SET status = 'cancelled', verification_url = NULL, user_code = NULL,
                pasted_code_enc = NULL, pasted_code_iv = NULL, pasted_code_tag = NULL, updated_at = NOW()
         WHERE box_id = $1 AND status IN ('requested', 'claimed', 'awaiting_user', 'awaiting_code', 'code_sent')`,
        [box.id]
    );
    // Approvals made for this box don't outlive it
    await db.query(
        `UPDATE box_edge_requests SET status = 'expired', updated_at = NOW() WHERE box_id = $1 AND status IN ('pending', 'allowed')`,
        [box.id]
    );
}

/** Restore within the grace period: boxd rebuilds it at a new generation with fresh tokens. */
export async function restoreBox(db: any, boxId: string): Promise<void> {
    const r = await db.query(
        `UPDATE agent_boxes SET desired_state = 'running', deleted_at = NULL, volume_purge_after = NULL,
                pending_action = 'rebuild', action_requested_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND desired_state = 'deleted' AND volume_purge_after > NOW() RETURNING id`,
        [boxId]
    );
    if (r.rows.length === 0) throw new BoxError(409, 'not_restorable');
}

/** Delete now: boxd removes the home volume on its next pass (the row stays as the record). */
export async function purgeBox(db: any, boxId: string): Promise<void> {
    const r = await db.query(
        `UPDATE agent_boxes SET volume_purge_after = NOW(), updated_at = NOW() WHERE id = $1 AND desired_state = 'deleted' RETURNING id`,
        [boxId]
    );
    if (r.rows.length === 0) throw new BoxError(409, 'not_deleted');
}

export type BoxAction = 'start' | 'stop' | 'restart' | 'rebuild' | 'reset';

/**
 * Owner actions. start/stop set desired_state; restart, rebuild and reset are pending_action for
 * boxd, always with action_requested_at (boxd clears the action only if both still match).
 * A failed box is left alone by boxd until an action is set, so start on it also restarts it.
 */
export async function boxAction(db: any, box: { id: string; name: string; state: string; desired_state: string }, action: BoxAction, confirm?: string): Promise<void> {
    if (box.desired_state === 'deleted') throw new BoxError(409, 'box_deleted');
    if (action === 'reset' && confirm !== box.name) throw new BoxError(400, 'confirm_required', 'Type the box name to reset it');
    if (action === 'start') {
        await db.query(
            `UPDATE agent_boxes SET desired_state = 'running',
                    pending_action = CASE WHEN state = 'failed' AND pending_action IS NULL THEN 'restart' ELSE pending_action END,
                    action_requested_at = CASE WHEN state = 'failed' AND pending_action IS NULL THEN NOW() ELSE action_requested_at END,
                    updated_at = NOW()
             WHERE id = $1`,
            [box.id]
        );
        return;
    }
    if (action === 'stop') {
        await db.query(`UPDATE agent_boxes SET desired_state = 'stopped', updated_at = NOW() WHERE id = $1`, [box.id]);
        return;
    }
    // A stronger action replaces a weaker pending one (reset > rebuild > restart), never the reverse
    await db.query(
        `UPDATE agent_boxes SET pending_action = $2, action_requested_at = NOW(), updated_at = NOW(),
                login_state = CASE WHEN $2 = 'reset' THEN 'none' ELSE login_state END
         WHERE id = $1 AND (pending_action IS NULL
               OR array_position(ARRAY['restart', 'rebuild', 'reset'], pending_action::text) <= array_position(ARRAY['restart', 'rebuild', 'reset'], $2::text))`,
        [box.id, action]
    );
}

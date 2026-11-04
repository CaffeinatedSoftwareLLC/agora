import type { Pool } from 'pg';
import { decryptString } from '../../lib/encryption';
import type { BridgedEvent } from '../../lib/event-bridge';
import { rotateBoxTokens, type BoxTokens } from '../../lib/boxes/tokens';
import { postBoxNotice, type BoxNoticeKind } from './notices';

/**
 * What boxd reads and writes in the database. boxd connects as the table owner (like the
 * runner) and touches only box rows, their hosts' and bots' tokens, and notices.
 * reconcile.ts works against this interface; its unit test passes a fake.
 */

export type DesiredState = 'running' | 'stopped' | 'deleted';
export type BoxState = 'creating' | 'running' | 'stopped' | 'failed' | 'deleted';
export type PendingAction = 'restart' | 'rebuild' | 'reset';

export interface BoxRow {
    id: string;
    name: string;
    adapter: 'claude' | 'codex';
    auth: 'subscription' | 'api_key';
    profileId: string;
    hostId: string;
    homeChannelId: string | null;
    generation: number;
    desiredState: DesiredState;
    state: BoxState;
    pendingAction: PendingAction | null;
    actionRequestedAt: Date | null;
    imageVersion: number | null;
    containerId: string | null;
    subnet: string | null;
    cpus: number;
    memoryMb: number;
    pids: number;
    failures: number;
    lastError: string | null;
    volumePurgeAfter: Date | null;
}

export interface BoxRecord {
    state?: BoxState;
    containerId?: string | null;
    imageVersion?: number | null;
    subnet?: string | null;
    lastError?: string | null;
    failures?: number;
    seen?: boolean;
}

export interface BoxStore {
    listBoxes(): Promise<BoxRow[]>;
    /** Claim a subnet for the box; false when another box holds it (unique index). */
    setSubnet(boxId: string, subnet: string): Promise<boolean>;
    record(boxId: string, fields: BoxRecord): Promise<void>;
    /** Clear the owner action boxd just did, unless a newer one was requested meanwhile. */
    clearAction(boxId: string, action: PendingAction, requestedAt: Date | null): Promise<void>;
    mintTokens(boxId: string): Promise<BoxTokens>;
    /** The attached repos (`owner/repo`, oldest first) and the decrypted API key, if any. */
    boxInputs(box: BoxRow): Promise<{ repos: string[]; apiKeyEnv: string | null; apiKey: string | null }>;
    hasActiveRun(box: BoxRow): Promise<boolean>;
    notice(box: BoxRow, kind: BoxNoticeKind, content: string): Promise<void>;
}

const trim = (v: string | null | undefined) => (v ? v.trim() : null);

export class DbBoxStore implements BoxStore {
    constructor(
        private db: Pool,
        private encryptionKey: Buffer,
        private publish: (events: BridgedEvent[]) => Promise<void>,
    ) {}

    async listBoxes(): Promise<BoxRow[]> {
        const r = await this.db.query(
            `SELECT b.*, p.name, p.adapter, p.auth_mode
             FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id
             ORDER BY b.created_at, b.id`
        );
        return r.rows.map((row: any) => ({
            id: row.id.trim(),
            name: row.name,
            adapter: row.adapter,
            auth: row.auth_mode === 'api_key' ? 'api_key' : 'subscription',
            profileId: row.profile_id.trim(),
            hostId: row.host_id.trim(),
            homeChannelId: trim(row.home_channel_id),
            generation: row.generation,
            desiredState: row.desired_state,
            state: row.state,
            pendingAction: row.pending_action,
            actionRequestedAt: row.action_requested_at,
            imageVersion: row.image_version,
            containerId: row.container_id,
            subnet: row.subnet,
            cpus: Number(row.cpus),
            memoryMb: row.memory_mb,
            pids: row.pids,
            failures: row.failures,
            lastError: row.last_error,
            volumePurgeAfter: row.volume_purge_after,
        }));
    }

    async setSubnet(boxId: string, subnet: string): Promise<boolean> {
        try {
            await this.db.query(`UPDATE agent_boxes SET subnet = $2, updated_at = NOW() WHERE id = $1`, [boxId, subnet]);
            return true;
        } catch (err: any) {
            if (err.code === '23505') return false;
            throw err;
        }
    }

    async record(boxId: string, f: BoxRecord): Promise<void> {
        const sets: string[] = [];
        const vals: unknown[] = [boxId];
        const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
        if (f.state !== undefined) set('state', f.state);
        if (f.containerId !== undefined) set('container_id', f.containerId);
        if (f.imageVersion !== undefined) set('image_version', f.imageVersion);
        if (f.subnet !== undefined) set('subnet', f.subnet);
        if (f.lastError !== undefined) {
            set('last_error', f.lastError === null ? null : f.lastError.slice(0, 500));
            sets.push(f.lastError === null ? 'last_error_at = NULL' : 'last_error_at = NOW()');
        }
        if (f.failures !== undefined) set('failures', f.failures);
        if (f.seen) sets.push('last_seen_at = NOW()');
        if (sets.length === 0) return;
        await this.db.query(`UPDATE agent_boxes SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, vals);
    }

    // Postgres keeps microseconds, a JS Date only milliseconds: compare at the Date's precision,
    // or the action is never cleared and boxd redoes it every pass (found on a real stack)
    async clearAction(boxId: string, action: PendingAction, requestedAt: Date | null): Promise<void> {
        await this.db.query(
            `UPDATE agent_boxes SET pending_action = NULL, action_requested_at = NULL, updated_at = NOW()
             WHERE id = $1 AND pending_action = $2
               AND date_trunc('milliseconds', action_requested_at) IS NOT DISTINCT FROM date_trunc('milliseconds', $3::timestamptz)`,
            [boxId, action, requestedAt]
        );
    }

    mintTokens(boxId: string) { return rotateBoxTokens(this.db, boxId); }

    async boxInputs(box: BoxRow) {
        const repos = await this.db.query(
            `SELECT owner, repo FROM box_repos WHERE box_id = $1 ORDER BY created_at, owner, repo`, [box.id]
        );
        const key = (await this.db.query(
            `SELECT api_key_env, api_key_enc, api_key_iv, api_key_tag FROM agent_boxes WHERE id = $1`, [box.id]
        )).rows[0];
        let apiKey: string | null = null;
        if (box.auth === 'api_key' && key?.api_key_enc && key.api_key_iv && key.api_key_tag) {
            apiKey = decryptString(key.api_key_enc, this.encryptionKey, key.api_key_iv, key.api_key_tag);
        }
        return { repos: repos.rows.map((r: any) => `${r.owner}/${r.repo}`), apiKeyEnv: key?.api_key_env ?? null, apiKey };
    }

    async hasActiveRun(box: BoxRow): Promise<boolean> {
        const r = await this.db.query(
            `SELECT 1 FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id
             WHERE s.profile_id = $1 AND r.status = 'claimed' AND r.lease_until > NOW() LIMIT 1`,
            [box.profileId]
        );
        return r.rows.length > 0;
    }

    async notice(box: BoxRow, kind: BoxNoticeKind, content: string): Promise<void> {
        await postBoxNotice(this.db, this.publish, box, kind, content);
    }
}

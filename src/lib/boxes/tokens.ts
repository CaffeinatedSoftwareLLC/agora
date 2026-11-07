import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { generateBotToken } from '../../auth/bot-tokens';
import { hashPassword } from '../../auth/passwords';
import { refreshCard } from './edge-requests';

/**
 * Box credentials (docs/agent-boxes.md §3.2, §4.1). boxd calls `rotateBoxTokens` once per
 * container creation (create, rebuild, upgrade, reset, restore): in one transaction it bumps
 * the box's generation, gives the box host a new secret bound to that generation, revokes every
 * token the box's bot had, and mints one bot token bound to the box and generation.
 *
 * The plaintext tokens are returned for the container's environment only. Nothing here logs them.
 */

export interface BoxTokens {
    generation: number;
    hostId: string;
    /** ah_<hostId>.<secret> */
    hostToken: string;
    botId: string;
    /** bot_<tokenId>.<secret> */
    botToken: string;
}

/** The box was deleted (or is gone) before its tokens could be minted. */
export class BoxGoneError extends Error {
    constructor(boxId: string) { super(`Box ${boxId} is deleted`); }
}

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection lost */ });
        throw err;
    } finally {
        client.release();
    }
}

export async function rotateBoxTokens(pool: Pool, boxId: string): Promise<BoxTokens> {
    // Hash outside the transaction: Argon2 is slow and the row lock should be short
    const hostSecret = randomBytes(32).toString('hex');
    const hostHash = await hashPassword(hostSecret);
    const bot = await generateBotToken();

    return inTransaction(pool, async (db) => {
        const box = (await db.query(
            `SELECT b.id, b.host_id, b.desired_state, p.bot_id
             FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id
             WHERE b.id = $1 FOR UPDATE OF b`,
            [boxId]
        )).rows[0];
        if (!box || box.desired_state === 'deleted') throw new BoxGoneError(boxId);
        const hostId = box.host_id.trim();
        const botId = box.bot_id.trim();

        const gen = (await db.query(
            `UPDATE agent_boxes SET generation = generation + 1, updated_at = NOW() WHERE id = $1 RETURNING generation`,
            [boxId]
        )).rows[0].generation as number;
        // The host is live again whatever revoked it before (a delete that was then restored)
        await db.query(
            `UPDATE agent_hosts SET secret_hash = $2, box_generation = $3, revoked_at = NULL
             WHERE id = $1 AND kind = 'box' AND box_id = $4`,
            [hostId, hostHash, gen, boxId]
        ).then(r => { if (r.rowCount !== 1) throw new Error(`Box ${boxId} has no box host`); });
        // Every token the bot had: a box bot never holds an unbound one
        await db.query(`UPDATE bot_tokens SET revoked_at = NOW() WHERE bot_id = $1 AND revoked_at IS NULL`, [botId]);
        await db.query(
            `INSERT INTO bot_tokens (id, bot_id, secret_hash, name, box_id, box_generation, purpose) VALUES ($1, $2, $3, 'box', $4, $5, 'box')`,
            [bot.tokenId, botId, bot.secretHash, boxId, gen]
        );
        return { generation: gen, hostId, hostToken: `ah_${hostId}.${hostSecret}`, botId, botToken: bot.raw };
    });
}

/**
 * Restore (§9.4), before anything starts: every box gets a new generation, every box host
 * secret and box bot token is dead, and no approval made before the backup carries over.
 * boxd mints fresh tokens when it rebuilds the boxes.
 */
export async function prepareBoxRestore(pool: Pool): Promise<{ boxes: number; hosts: number; tokens: number; requests: number; logins: number }> {
    // One unknown secret for every host: nobody can present it
    const deadHash = await hashPassword(randomBytes(32).toString('hex'));
    return inTransaction(pool, async (db) => {
        const boxes = await db.query(
            `UPDATE agent_boxes SET generation = generation + 1, updated_at = NOW() RETURNING id`
        );
        const hosts = await db.query(
            `UPDATE agent_hosts SET secret_hash = $1, box_generation = NULL WHERE kind = 'box' OR box_id IS NOT NULL`,
            [deadHash]
        );
        const tokens = await db.query(
            `UPDATE bot_tokens SET revoked_at = NOW()
             WHERE revoked_at IS NULL
               AND (box_id IS NOT NULL
                    OR bot_id IN (SELECT p.bot_id FROM agent_boxes b JOIN agent_profiles p ON p.id = b.profile_id))`
        );
        const requests = await db.query(
            `UPDATE box_edge_requests SET status = 'expired', updated_at = NOW()
             WHERE status IN ('pending', 'allowed', 'in_flight') RETURNING id`
        );
        // The cards say so too; nothing is running to receive events, so they're dropped
        for (const r of requests.rows) await refreshCard(db, r.id);
        const logins = await db.query(
            `UPDATE box_login_requests SET status = 'expired', verification_url = NULL, user_code = NULL,
                    pasted_code_enc = NULL, pasted_code_iv = NULL, pasted_code_tag = NULL, updated_at = NOW()
             WHERE status IN ('requested', 'claimed', 'awaiting_user', 'awaiting_code', 'code_sent')`
        );
        return {
            boxes: boxes.rowCount ?? 0, hosts: hosts.rowCount ?? 0, tokens: tokens.rowCount ?? 0,
            requests: requests.rowCount ?? 0, logins: logins.rowCount ?? 0,
        };
    });
}

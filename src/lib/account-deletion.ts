import { config } from '../config';
import { asService } from './agent-sessions';
import { removeArtifactVersion } from './artifacts';
import { decryptString } from './encryption';
import { generateUlid } from '../utils/ulid';

/**
 * Self-service account deletion (docs/account-deletion.md).
 *
 * The user row is deleted, not kept as a tombstone. Every foreign key to users already
 * says what happens then (CASCADE for what belonged to the person, SET NULL for "who did
 * this"), so messages keep their place with author_id NULL. A non-system message with no
 * author is what clients show as "Deleted user"; deleted bots already looked like that.
 */

export type DeletedAccountMessages = 'anonymize' | 'remove';

export const DELETED_ACCOUNT_MESSAGES_KEY = 'accounts.deleted_account_messages';

/** The instance's setting; anything unreadable means the default, anonymize. */
export async function deletedAccountMessages(db: any): Promise<DeletedAccountMessages> {
    const row = await db.query('SELECT value FROM instance_settings WHERE key = $1', [DELETED_ACCOUNT_MESSAGES_KEY]);
    return row.rows[0]?.value === 'remove' ? 'remove' : 'anonymize';
}

export interface DeletionBlockers {
    /** Servers the person owns. Ownership can't pass to nobody, so these come first. */
    ownedServers: { id: string; name: string }[];
    /** The person is the instance's only active admin. */
    lastAdmin: boolean;
}

/**
 * What stops this account from being deleted now. With `lock`, the admin rows are locked
 * until the transaction ends, so two admins deleting themselves at once can't both pass.
 */
export async function deletionBlockers(db: any, userId: string, lock = false): Promise<DeletionBlockers> {
    const servers = await db.query('SELECT id, name FROM servers WHERE owner_id = $1 ORDER BY name, id', [userId]);
    const admins = await db.query(
        `SELECT id FROM users WHERE is_instance_admin AND NOT bot AND account_status = 'active'
         ORDER BY id ${lock ? 'FOR UPDATE' : ''}`
    );
    const adminIds = admins.rows.map((r: any) => r.id.trim());
    return {
        ownedServers: servers.rows.map((r: any) => ({ id: r.id.trim(), name: r.name })),
        lastAdmin: adminIds.includes(userId) && adminIds.length === 1,
    };
}

export interface DeletionResult {
    messages: DeletedAccountMessages;
    messagesRemoved: number;
    filesRemoved: number;
    botsPaused: number;
    /** Socket events to emit after COMMIT. */
    events: Array<{ event: string; room: string; data: any }>;
    /** Storage keys of the soft-deleted files; their blobs go after COMMIT. */
    blobKeys: string[];
    /** Push relay handles of the deleted devices; the relays are told to forget them after COMMIT. */
    relayHandles: Array<{ relay: string; handle: string }>;
    /** Devices whose handle no longer decrypts; the relay prunes those after a year unused. */
    relayHandlesUnreadable: number;
}

/** More than this many removed messages are not announced one by one; clients see them on reload. */
const MAX_DELETE_EVENTS = 1000;

const PAUSE_REASON = 'Owner deleted their account';

/**
 * Delete the account in the caller's transaction. The caller has re-authenticated the
 * person and checked deletionBlockers (with lock) in the same transaction.
 *
 * Runs as the service role: the work spans tables whose RLS lets a person see only their
 * own rows (bot tokens, agent invites, other people's thread parents). Every statement is
 * scoped to `userId` or to the bots it owns.
 */
export async function deleteAccount(db: any, userId: string, messages: DeletedAccountMessages): Promise<DeletionResult> {
    return asService(db, async () => {
        const result: DeletionResult = { messages, messagesRemoved: 0, filesRemoved: 0, botsPaused: 0, events: [], blobKeys: [], relayHandles: [], relayHandlesUnreadable: 0 };

        // Bots the person owns are paused, not deleted or handed to someone: their history
        // stays attributed, and nobody inherits an agent (or its credentials) they didn't set
        // up. Their tokens, invites and pending runs go as on suspension (admin ban handler).
        // With the owner gone, bot auth fails closed (bot_owner_inactive); a server admin can
        // delete them.
        const ownedBots = 'SELECT id FROM users WHERE bot AND bot_owner_id = $1';
        const paused = await db.query(
            `UPDATE users SET bot_paused_at = COALESCE(bot_paused_at, NOW()), bot_paused_reason = $2
             WHERE bot AND bot_owner_id = $1 RETURNING id, server_id`,
            [userId, PAUSE_REASON]
        );
        result.botsPaused = paused.rows.length;
        for (const bot of paused.rows) {
            await db.query(
                `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, reason)
                 VALUES ($1, $2, NULL, 'bot_pause', 'bot', $3, $4)`,
                [generateUlid(), bot.server_id, bot.id, PAUSE_REASON]
            );
        }
        await db.query(
            `UPDATE agent_invites SET expires_at = clock_timestamp()
             WHERE redeemed_at IS NULL AND expires_at > clock_timestamp() AND (bot_id IN (${ownedBots}) OR created_by = $1)`,
            [userId]
        );
        await db.query(`UPDATE bot_tokens SET revoked_at = NOW() WHERE revoked_at IS NULL AND bot_id IN (${ownedBots})`, [userId]);
        const submitters = `SELECT $1::CHAR(26) UNION ALL ${ownedBots}`;
        await db.query(
            `UPDATE exec_run_tokens SET revoked_at = NOW()
             WHERE revoked_at IS NULL AND run_id IN (SELECT id FROM exec_runs WHERE submitted_by IN (${submitters}))`,
            [userId]
        );
        await db.query(
            `UPDATE exec_runs SET status = 'denied', error = 'The submitter or its owner deleted their account', finished_at = NOW()
             WHERE status IN ('submitted', 'gated', 'awaiting_approval', 'queued') AND submitted_by IN (${submitters})`,
            [userId]
        );

        // Agent hosts the person paired run on a machine that is no longer a member's
        await db.query('UPDATE agent_hosts SET revoked_at = NOW() WHERE created_by = $1 AND revoked_at IS NULL', [userId]);

        // Columns that reference users with no ON DELETE action. Trust falls back to the
        // screening verdict; group-DM ownership is a leftover of the chat app.
        await db.query('UPDATE files SET trusted_by = NULL, trusted_at = NULL WHERE trusted_by = $1', [userId]);
        await db.query('UPDATE channels SET owner_id = NULL WHERE owner_id = $1', [userId]);

        if (messages === 'remove') {
            await removeMessages(db, userId, result);
        } else {
            // author_id goes NULL with the row, which already ends any authority; clearing the
            // stamp as well means a message can never regain it.
            await db.query('UPDATE messages SET author_could_direct = false WHERE author_id = $1 AND author_could_direct', [userId]);
        }

        // Push devices would CASCADE with the user row; deleting them here yields the handles,
        // so the relays can forget them as DELETE /me/push-devices/:id does.
        const devices = await db.query(
            'DELETE FROM push_devices WHERE user_id = $1 RETURNING relay, handle_enc, handle_iv, handle_tag',
            [userId]
        );
        for (const d of devices.rows) {
            try {
                result.relayHandles.push({ relay: d.relay, handle: decryptString(d.handle_enc, config.encryptionKey, d.handle_iv, d.handle_tag) });
            } catch {
                result.relayHandlesUnreadable++;
            }
        }

        await db.query(
            `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, changes)
             VALUES ($1, NULL, 'account_delete', 'user', $2, $3)`,
            [generateUlid(), userId, JSON.stringify({
                messages, messagesRemoved: result.messagesRemoved, filesRemoved: result.filesRemoved, botsPaused: result.botsPaused,
            })]
        );

        // Same revocation as POST /auth/logout-all, then the row itself. Passkeys,
        // preferences, memberships, unreads and sessions go with it (ON DELETE CASCADE).
        await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId]);
        await db.query('DELETE FROM users WHERE id = $1 AND NOT bot', [userId]);
        return result;
    });
}

/** The `remove` policy: soft-delete the person's messages and files, as their own delete would. */
async function removeMessages(db: any, userId: string, result: DeletionResult): Promise<void> {
    const removed = await db.query(
        `UPDATE messages SET content = NULL, deleted_at = NOW(), protocol = NULL, author_could_direct = false
         WHERE author_id = $1 AND deleted_at IS NULL
         RETURNING id, channel_id, thread_id, deleted_at`,
        [userId]
    );
    result.messagesRemoved = removed.rows.length;
    const ids = removed.rows.map((r: any) => r.id.trim());
    if (ids.length) {
        await db.query('DELETE FROM message_mentions WHERE message_id = ANY($1)', [ids]);
        const withArtifacts = await db.query('SELECT DISTINCT message_id FROM artifact_versions WHERE message_id = ANY($1)', [ids]);
        for (const row of withArtifacts.rows) await removeArtifactVersion(db, row.message_id.trim());
    }

    // Thread parents the person started stay as deleted placeholders, so other people's
    // replies keep their thread. Replies the person left elsewhere come off the counts.
    const perThread = new Map<string, number>();
    for (const r of removed.rows) {
        if (r.thread_id) perThread.set(r.thread_id.trim(), (perThread.get(r.thread_id.trim()) ?? 0) + 1);
    }
    const threadEvents: DeletionResult['events'] = [];
    for (const [threadId, count] of perThread) {
        const parent = await db.query(
            `UPDATE messages SET
                reply_count = GREATEST(reply_count - $2, 0),
                last_reply_at = (SELECT r.created_at FROM messages r WHERE r.thread_id = $1 AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1)
             WHERE id = $1
             RETURNING channel_id, reply_count, last_reply_at, thread_closed_at`,
            [threadId, count]
        );
        const p = parent.rows[0];
        if (!p) continue;
        threadEvents.push({
            room: `channel:${p.channel_id.trim()}`,
            event: 'ThreadMetadataUpdate',
            data: {
                channelId: p.channel_id.trim(), messageId: threadId, replyCount: p.reply_count,
                lastReplyAt: p.last_reply_at, threadClosedAt: p.thread_closed_at ?? null,
            },
        });
    }

    for (const r of removed.rows.slice(0, MAX_DELETE_EVENTS)) {
        result.events.push({
            room: `channel:${r.channel_id.trim()}`,
            event: 'MessageDelete',
            data: {
                id: r.id.trim(), channelId: r.channel_id.trim(), deletedAt: r.deleted_at,
                ...(r.thread_id ? { threadId: r.thread_id.trim() } : {}),
            },
        });
    }
    result.events.push(...threadEvents);

    // Files the person uploaded: soft-deleted like DELETE /files/:fileId; the caller removes
    // the blobs once the transaction has committed, and the cleanup worker drops the rows.
    const files = await db.query(
        'UPDATE files SET deleted_at = NOW() WHERE uploader_id = $1 AND deleted_at IS NULL RETURNING storage_key',
        [userId]
    );
    result.filesRemoved = files.rows.length;
    result.blobKeys = files.rows.filter((f: any) => f.storage_key).map((f: any) => f.storage_key.trim());
}

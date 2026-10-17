/**
 * Durable duplicate protection for posts (docs/planning/agent-sessions-wbs.md, "Duplicate
 * posts after a retry"). An author may send `client_key` with a message; a repeat with the
 * same key returns the first message instead of inserting a second one.
 *
 * A repeat counts only if it goes to the same channel and thread parent with the same
 * content; anything else with a used key is a conflict. The routes run their own access
 * and parent checks before calling this, so a replay never bypasses them.
 */

export interface ClientKeyTarget {
    channelId: string;
    /** Thread parent for a reply, null for a top-level message. */
    threadId: string | null;
    content: string | null;
}

export type ClientKeyLookup =
    | { kind: 'none' }
    | { kind: 'replay'; message: any }
    | { kind: 'conflict' };

const UNIQUE_INDEX = 'idx_messages_client_key';

/** Look for an earlier message from this author with this key. */
export async function findClientKey(db: any, authorId: string, key: string, target: ClientKeyTarget): Promise<ClientKeyLookup> {
    const row = await db.query(
        `SELECT m.id, m.channel_id, m.thread_id, m.content, m.created_at, m.protocol, m.author_could_direct,
                m.mentions_everyone, u.username, u.bot, u.avatar_url
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.author_id = $1 AND m.client_key = $2`,
        [authorId, key]
    );
    const existing = row.rows[0];
    if (!existing) return { kind: 'none' };

    const sameChannel = existing.channel_id.trim() === target.channelId.trim();
    const sameParent = (existing.thread_id?.trim() ?? null) === (target.threadId?.trim() ?? null);
    const sameContent = (existing.content ?? null) === (target.content ?? null);
    if (!sameChannel || !sameParent || !sameContent) return { kind: 'conflict' };

    return {
        kind: 'replay',
        message: {
            id: existing.id.trim(),
            content: existing.content,
            authorId: authorId.trim(),
            authorUsername: existing.username,
            authorBot: existing.bot || false,
            authorAvatarUrl: existing.avatar_url || null,
            channelId: existing.channel_id.trim(),
            createdAt: new Date(existing.created_at).toISOString(),
            ...(existing.thread_id ? { threadId: existing.thread_id.trim() } : {}),
            mentionsEveryone: existing.mentions_everyone,
            ...(existing.protocol ? { protocol: existing.protocol } : {}),
            replayed: true,
        },
    };
}

/**
 * Run the message INSERT under a savepoint. If a concurrent request with the same key
 * committed first, the unique index fires: roll back to the savepoint and report it, so
 * the caller can look the winner up instead of failing the whole request.
 */
export async function insertWithClientKey(db: any, insert: () => Promise<unknown>): Promise<'inserted' | 'duplicate'> {
    await db.query('SAVEPOINT client_key_insert');
    try {
        await insert();
        await db.query('RELEASE SAVEPOINT client_key_insert');
        return 'inserted';
    } catch (err: any) {
        await db.query('ROLLBACK TO SAVEPOINT client_key_insert');
        await db.query('RELEASE SAVEPOINT client_key_insert');
        if (err?.code === '23505' && err?.constraint === UNIQUE_INDEX) return 'duplicate';
        throw err;
    }
}

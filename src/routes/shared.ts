/**
 * Shared route utilities used across multiple route modules.
 */

/**
 * Parse @mentions from message content, resolve to user IDs, insert into
 * message_mentions, increment channel_unreads for human mentions, and
 * handle @everyone. Returns the resolved mention data for event payloads.
 */
export async function resolveMentions(
    db: any,
    messageId: string,
    channelId: string,
    serverId: string | null,
    userId: string,
    content: string | null,
): Promise<{ mentionedUsers: { id: string; bot: boolean }[]; mentionsEveryone: boolean }> {
    const mentionContent = content || '';
    const mentionMatches: string[] = mentionContent.match(/@(\w+)/g) || [];
    const mentionedUsernames = [...new Set(mentionMatches.map((m: string) => m.slice(1)))];
    const mentionsEveryone = mentionedUsernames.includes('everyone');

    const nonEveryoneUsernames = mentionedUsernames.filter((u: string) => u !== 'everyone');
    let mentionedUsers: { id: string; bot: boolean }[] = [];

    if (nonEveryoneUsernames.length > 0) {
        let validMentions;
        if (serverId) {
            validMentions = await db.query(
                `SELECT u.id, u.bot FROM users u
                 INNER JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = $2
                 WHERE u.username = ANY($1)
                 UNION
                 SELECT u.id, u.bot FROM users u
                 INNER JOIN bot_channel_access bca ON bca.bot_id = u.id
                 WHERE bca.channel_id = $3 AND u.username = ANY($1)`,
                [nonEveryoneUsernames, serverId, channelId]
            );
        } else {
            validMentions = await db.query(
                `SELECT u.id, u.bot FROM users u
                 INNER JOIN channel_members cm ON cm.user_id = u.id AND cm.channel_id = $2
                 WHERE u.username = ANY($1)`,
                [nonEveryoneUsernames, channelId]
            );
        }

        mentionedUsers = validMentions.rows.map((r: any) => ({
            id: r.id.trim(),
            bot: r.bot,
        }));

        const mentionedUserIds = mentionedUsers.map(u => u.id);

        if (mentionedUserIds.length > 0) {
            const mentionValues = mentionedUserIds
                .map((_: string, i: number) => `($1, $${i + 2})`)
                .join(', ');
            await db.query(
                `INSERT INTO message_mentions (message_id, user_id) VALUES ${mentionValues}
                 ON CONFLICT DO NOTHING`,
                [messageId, ...mentionedUserIds]
            );

            const humanMentionIds = mentionedUsers
                .filter(u => !u.bot)
                .map(u => u.id);

            if (humanMentionIds.length > 0) {
                await db.query(
                    `INSERT INTO channel_unreads (channel_id, user_id, mention_count)
                     SELECT $1, unnest($2::char(26)[]), 1
                     ON CONFLICT (channel_id, user_id) DO UPDATE
                        SET mention_count = channel_unreads.mention_count + 1`,
                    [channelId, humanMentionIds]
                );
            }
        }
    }

    if (mentionsEveryone) {
        if (serverId) {
            await db.query(
                `INSERT INTO channel_unreads (channel_id, user_id, mention_count)
                 SELECT $1, sm.user_id, 1
                 FROM server_members sm
                 WHERE sm.server_id = $2 AND sm.user_id != $3
                 ON CONFLICT (channel_id, user_id) DO UPDATE
                    SET mention_count = channel_unreads.mention_count + 1`,
                [channelId, serverId, userId]
            );
        } else {
            await db.query(
                `INSERT INTO channel_unreads (channel_id, user_id, mention_count)
                 SELECT $1, cm.user_id, 1
                 FROM channel_members cm
                 WHERE cm.channel_id = $1 AND cm.user_id != $2
                 ON CONFLICT (channel_id, user_id) DO UPDATE
                    SET mention_count = channel_unreads.mention_count + 1`,
                [channelId, userId]
            );
        }
    }

    return { mentionedUsers, mentionsEveryone };
}

/**
 * Check if a user has access to a channel:
 * - Bots: check bot_channel_access (explicit allowlist)
 * - Server channels: user must be a server member
 * - DM channels: user must be a channel member
 */
export async function checkChannelMembership(db: any, channelId: string, userId: string, isBot?: boolean): Promise<boolean> {
    if (isBot) {
        const result = await db.query(
            'SELECT 1 FROM bot_channel_access WHERE bot_id = $1 AND channel_id = $2',
            [userId, channelId]
        );
        return result.rows.length > 0;
    }

    const channel = await db.query(
        'SELECT id, channel_type, server_id FROM channels WHERE id = $1',
        [channelId]
    );
    if (channel.rows.length === 0) return false;

    const ch = channel.rows[0];

    if (ch.server_id) {
        const member = await db.query(
            'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
            [ch.server_id, userId]
        );
        return member.rows.length > 0;
    } else {
        const member = await db.query(
            'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
            [channelId, userId]
        );
        return member.rows.length > 0;
    }
}

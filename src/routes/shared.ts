/**
 * Shared route utilities used across multiple route modules.
 */

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

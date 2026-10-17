import { Permissions } from '../permissions';
import { checkChannelPermissions } from './channel-access';

/**
 * Who may give agents instructions in a channel.
 *
 * - The server owner, while their account is active.
 * - An active member who can see the channel and whose roles or channel overrides
 *   grant DirectAgents. Only the owner can grant it (routes/roles.ts); Administrator
 *   does not imply it.
 * - A bot whose access to the channel has can_direct set, while the bot is not paused
 *   and both it and its owner are active. Only the server owner sets it; removing and
 *   re-adding the bot's access resets it.
 *
 * Agents see the result as a tag on each message ([OWNER], [DIRECTOR]) and through
 * `GET /channels/:id/directors`. A message carries authority only if its author could
 * direct when it was posted or last edited (messages.author_could_direct) AND can
 * still direct now. Any lookup failure means no authority.
 */
export type Authority = 'owner' | 'director' | null;

export async function canDirect(db: any, channelId: string, userId: string, isBot: boolean): Promise<boolean> {
    try {
        if (isBot) {
            const row = await db.query(
                `SELECT bca.can_direct FROM bot_channel_access bca
                 JOIN users u ON u.id = bca.bot_id
                 JOIN users o ON o.id = u.bot_owner_id
                 WHERE bca.channel_id = $1 AND bca.bot_id = $2
                   AND u.bot_paused_at IS NULL AND u.account_status = 'active' AND o.account_status = 'active'`,
                [channelId, userId]
            );
            return row.rows[0]?.can_direct === true;
        }
        // An active account that can see the channel and holds DirectAgents there
        const user = await db.query('SELECT account_status FROM users WHERE id = $1 AND bot = false', [userId]);
        if (user.rows[0]?.account_status !== 'active') return false;
        return (await checkChannelPermissions(db, channelId, userId, Permissions.DirectAgents | Permissions.ViewChannel)).allowed;
    } catch {
        return false;
    }
}

async function channelOwner(db: any, channelId: string): Promise<string | null> {
    const row = await db.query(
        'SELECT s.owner_id FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.id = $1',
        [channelId]
    );
    return row.rows[0]?.owner_id?.trim() ?? null;
}

/**
 * The authority each message's author holds now, for messages that were stamped
 * when posted. `rows` need author_id, author_bot and author_could_direct.
 * Returns message id → authority.
 */
export async function messageAuthorities(
    db: any,
    channelId: string,
    rows: Array<{ id: string; author_id: string | null; author_bot?: boolean; author_could_direct?: boolean }>
): Promise<Map<string, Authority>> {
    const result = new Map<string, Authority>();
    const stamped = rows.filter(r => r.author_could_direct && r.author_id);
    if (stamped.length === 0) return result;

    try {
        const owner = await channelOwner(db, channelId);
        const now = new Map<string, boolean>();
        for (const row of stamped) {
            const authorId = row.author_id!.trim();
            if (!now.has(authorId)) now.set(authorId, await canDirect(db, channelId, authorId, !!row.author_bot));
            if (now.get(authorId)) result.set(row.id.trim(), authorId === owner ? 'owner' : 'director');
        }
    } catch {
        return new Map();
    }
    return result;
}

export interface Director {
    userId: string;
    username: string;
    bot: boolean;
    authority: 'owner' | 'director';
}

/** Everyone who may direct agents in a channel right now. */
export async function listDirectors(db: any, channelId: string): Promise<Director[]> {
    const channel = await db.query('SELECT server_id FROM channels WHERE id = $1', [channelId]);
    const serverId = channel.rows[0]?.server_id?.trim();
    if (!serverId) return [];
    const owner = await channelOwner(db, channelId);

    const directors: Director[] = [];
    const members = await db.query(
        `SELECT u.id, u.username FROM server_members sm JOIN users u ON u.id = sm.user_id
         WHERE sm.server_id = $1 AND u.bot = false AND u.account_status = 'active'
         ORDER BY u.username`,
        [serverId]
    );
    for (const m of members.rows) {
        const id = m.id.trim();
        if (await canDirect(db, channelId, id, false)) {
            directors.push({ userId: id, username: m.username, bot: false, authority: id === owner ? 'owner' : 'director' });
        }
    }

    const bots = await db.query(
        `SELECT u.id, u.username FROM bot_channel_access bca
         JOIN users u ON u.id = bca.bot_id
         JOIN users o ON o.id = u.bot_owner_id
         WHERE bca.channel_id = $1 AND bca.can_direct = true
           AND u.bot_paused_at IS NULL AND u.account_status = 'active' AND o.account_status = 'active'
         ORDER BY u.username`,
        [channelId]
    );
    for (const b of bots.rows) {
        directors.push({ userId: b.id.trim(), username: b.username, bot: true, authority: 'director' });
    }

    // Owner first
    return directors.sort((a, b) => (a.authority === 'owner' ? -1 : b.authority === 'owner' ? 1 : 0));
}

/**
 * True when a role carries DirectAgents in any way: in its own permissions, or in a channel
 * override that allows or denies it. Assigning, unassigning or deleting such a role changes
 * who directs, so it is the owner's alone.
 */
export async function roleTouchesDirectAgents(db: any, roleId: string): Promise<boolean> {
    const bit = Permissions.DirectAgents.toString();
    const row = await db.query(
        `SELECT (r.permissions & $2::bigint) <> 0
                OR EXISTS (SELECT 1 FROM channel_role_overrides o
                           WHERE o.role_id = r.id AND ((o.allow | o.deny) & $2::bigint) <> 0) AS touches
         FROM roles r WHERE r.id = $1`,
        [roleId, bit]
    );
    return row.rows[0]?.touches === true;
}

/**
 * True when a change from `before` to `after` adds or removes DirectAgents.
 * Such a change is the server owner's alone.
 */
export function touchesDirectAgents(before: bigint, after: bigint): boolean {
    return ((before ^ after) & Permissions.DirectAgents) !== 0n;
}

export async function isServerOwner(db: any, serverId: string, userId: string): Promise<boolean> {
    const row = await db.query('SELECT owner_id FROM servers WHERE id = $1', [serverId]);
    return row.rows[0]?.owner_id?.trim() === userId.trim();
}

export const OWNER_ONLY_ERROR = 'Only the server owner can grant or remove DirectAgents';

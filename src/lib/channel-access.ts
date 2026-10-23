import { computePermissions, KNOWN_PERMS_MASK, Permissions } from '../permissions';
import { checkChannelMembership } from '../routes/shared';

/**
 * Whether a user holds the given permissions in a channel: server membership, then
 * the layered permission computation (roles, channel overrides). For a channel with
 * no server, channel membership. Explicitly assigned bots can opt into the same
 * role/override calculation with isBot, using their channel access as membership.
 */
export async function checkChannelPermissions(
    db: any,
    channelId: string,
    userId: string,
    requiredPerms: bigint,
    options: { isBot?: boolean } = {},
): Promise<{ allowed: boolean; error?: string; status?: number }> {
    const result = await loadChannelPermissions(db, channelId, userId, options);
    if ('error' in result) return { allowed: false, error: result.error, status: result.status };
    if ((result.perms & requiredPerms) !== requiredPerms) {
        return { allowed: false, error: 'Missing required permissions', status: 403 };
    }
    return { allowed: true };
}

/**
 * A user's (or explicitly assigned bot's) permissions in a channel, by the rules of
 * checkChannelPermissions. A channel with no server grants its members every bit.
 */
export async function loadChannelPermissions(
    db: any,
    channelId: string,
    userId: string,
    options: { isBot?: boolean } = {},
): Promise<{ perms: bigint } | { error: string; status: number }> {
    // Explicit bot assignment replaces human membership, not channel permissions.
    if (options.isBot && !await checkChannelMembership(db, channelId, userId, true)) {
        return { error: 'This bot has no access to the channel', status: 403 };
    }
    const channelRow = await db.query('SELECT id, server_id FROM channels WHERE id = $1', [channelId]);
    if (channelRow.rows.length === 0) return { error: 'Channel not found', status: 404 };
    const channel = channelRow.rows[0];

    if (channel.server_id) {
        const serverId = channel.server_id.trim();
        const serverRow = await db.query('SELECT owner_id, everyone_role_id FROM servers WHERE id = $1', [serverId]);
        if (serverRow.rows.length === 0) return { error: 'Server not found', status: 404 };

        if (!options.isBot) {
            const memberCheck = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [channel.server_id, userId]);
            if (memberCheck.rows.length === 0) return { error: 'Not a server member', status: 403 };
        }

        const userRolesRes = await db.query('SELECT role_id FROM member_roles WHERE server_id = $1 AND user_id = $2', [channel.server_id, userId]);
        const roleIds = userRolesRes.rows.map((r: any) => r.role_id.trim());

        const allRoleIds = [...roleIds, serverRow.rows[0].everyone_role_id.trim()];
        const rolesRes = await db.query('SELECT id, permissions FROM roles WHERE id = ANY($1)', [allRoleIds]);
        const roles = new Map<string, { permissions: bigint }>(rolesRes.rows.map((r: any) => [r.id.trim(), { permissions: BigInt(r.permissions) }]));

        const roleOverridesRes = await db.query('SELECT role_id, allow, deny FROM channel_role_overrides WHERE channel_id = $1', [channelId]);
        const channelRoleOverrides = new Map<string, { allow: bigint; deny: bigint }>(roleOverridesRes.rows.map((r: any) => [r.role_id.trim(), { allow: BigInt(r.allow), deny: BigInt(r.deny) }]));

        const memberOverrideRes = await db.query('SELECT allow, deny FROM channel_member_overrides WHERE channel_id = $1 AND user_id = $2', [channelId, userId]);
        const channelMemberOverride = memberOverrideRes.rows[0]
            ? { allow: BigInt(memberOverrideRes.rows[0].allow), deny: BigInt(memberOverrideRes.rows[0].deny) }
            : undefined;

        return {
            perms: computePermissions({
                userId: userId.trim(),
                roleIds,
                server: { ownerId: serverRow.rows[0].owner_id.trim(), everyoneRoleId: serverRow.rows[0].everyone_role_id.trim() },
                roles,
                channelRoleOverrides,
                channelMemberOverride,
            }),
        };
    } else {
        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) return { error: 'Not a channel member', status: 403 };
        return { perms: KNOWN_PERMS_MASK };
    }
}

/**
 * Whether a user or bot may see what is in a channel. Bots are not server members:
 * their access is the explicit per-channel allowlist.
 */
export async function canViewChannel(db: any, channelId: string, userId: string, isBot: boolean): Promise<{ allowed: boolean; error?: string; status?: number }> {
    if (isBot) {
        const allowed = await checkChannelMembership(db, channelId, userId, true);
        return allowed ? { allowed: true } : { allowed: false, error: 'This bot has no access to the channel', status: 403 };
    }
    return checkChannelPermissions(db, channelId, userId, Permissions.ViewChannel);
}

/**
 * The channel bits an upload needs (POST /files/upload). People need UploadFiles and
 * SendMessages. A bot's gate is its explicit channel access, as for posting (see
 * canPostInChannel), plus UploadFiles; SendMessages and ViewChannel don't apply to it.
 */
export function uploadPermissions(isBot: boolean): bigint {
    return isBot ? Permissions.UploadFiles : Permissions.UploadFiles | Permissions.SendMessages;
}

/**
 * Whether a user or bot may post in a channel, and whether their @everyone notifies anyone.
 * People need ViewChannel and SendMessages. A bot's gate is its explicit channel access
 * (bot_channel_access), together with the pause and account checks it already passes; it
 * is not gated by SendMessages, so "agents post, people watch" channels can deny SendMessages
 * to @everyone without muting the agents. To silence a bot, remove its channel access.
 * MentionEveryone applies to everyone, bots included.
 */
export async function canPostInChannel(db: any, channelId: string, userId: string, isBot: boolean): Promise<
    { allowed: true; mentionEveryone: boolean } | { allowed: false; error: string }
> {
    const result = await loadChannelPermissions(db, channelId, userId, { isBot });
    if ('error' in result) return { allowed: false, error: 'Channel access denied' };
    if (!isBot) {
        if (!(result.perms & Permissions.ViewChannel)) return { allowed: false, error: 'Channel access denied' };
        if (!(result.perms & Permissions.SendMessages)) return { allowed: false, error: 'Missing SendMessages permission' };
    }
    return { allowed: true, mentionEveryone: (result.perms & Permissions.MentionEveryone) !== 0n };
}

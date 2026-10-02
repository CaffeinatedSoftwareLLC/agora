import { computePermissions, Permissions } from '../permissions';
import { checkChannelMembership } from '../routes/shared';

/**
 * Whether a user holds the given permissions in a channel: server membership, then
 * the layered permission computation (roles, channel overrides). For a channel with
 * no server, channel membership.
 */
export async function checkChannelPermissions(
    db: any,
    channelId: string,
    userId: string,
    requiredPerms: bigint
): Promise<{ allowed: boolean; error?: string; status?: number }> {
    const channelRow = await db.query('SELECT id, server_id FROM channels WHERE id = $1', [channelId]);
    if (channelRow.rows.length === 0) return { allowed: false, error: 'Channel not found', status: 404 };
    const channel = channelRow.rows[0];

    if (channel.server_id) {
        const serverId = channel.server_id.trim();
        const serverRow = await db.query('SELECT owner_id, everyone_role_id FROM servers WHERE id = $1', [serverId]);
        if (serverRow.rows.length === 0) return { allowed: false, error: 'Server not found', status: 404 };

        const memberCheck = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [channel.server_id, userId]);
        if (memberCheck.rows.length === 0) return { allowed: false, error: 'Not a server member', status: 403 };

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

        const perms = computePermissions({
            userId: userId.trim(),
            roleIds,
            server: { ownerId: serverRow.rows[0].owner_id.trim(), everyoneRoleId: serverRow.rows[0].everyone_role_id.trim() },
            roles,
            channelRoleOverrides,
            channelMemberOverride,
        });

        if ((perms & requiredPerms) !== requiredPerms) {
            return { allowed: false, error: 'Missing required permissions', status: 403 };
        }

        return { allowed: true };
    } else {
        const isMember = await checkChannelMembership(db, channelId, userId);
        if (!isMember) return { allowed: false, error: 'Not a channel member', status: 403 };
        return { allowed: true };
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

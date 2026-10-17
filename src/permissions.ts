// Every permission Administrator implies. DirectAgents is deliberately outside it.
export const ALL_PERMS_MASK = (1n << 29n) - 1n;

export const Permissions = {
    Administrator:      1n << 0n,
    ManageServer:       1n << 1n,
    ManageChannels:     1n << 2n,
    ManageRoles:        1n << 3n,
    ManageEmoji:        1n << 4n,
    KickMembers:        1n << 5n,
    BanMembers:         1n << 6n,
    CreateInvites:      1n << 7n,
    ChangeNickname:     1n << 8n,
    ManageNicknames:    1n << 9n,
    ViewChannel:        1n << 10n,
    SendMessages:       1n << 11n,
    ManageMessages:     1n << 12n,
    EmbedLinks:         1n << 13n,
    UploadFiles:        1n << 14n,
    MentionEveryone:    1n << 16n,
    ReadMessageHistory: 1n << 17n,
    UseExternalEmoji:   1n << 18n,
    ManageBots:         1n << 27n,
    UseBots:            1n << 28n,
    // May give agents instructions in a channel. Only the server owner holds it
    // implicitly or can grant it; Administrator does not imply it.
    DirectAgents:       1n << 29n,
} as const;

/** Every bit a role or override may carry. */
export const KNOWN_PERMS_MASK = ALL_PERMS_MASK | Permissions.DirectAgents;

export const DEFAULT_EVERYONE_PERMS =
    Permissions.ViewChannel |
    Permissions.SendMessages |
    Permissions.ReadMessageHistory |
    Permissions.EmbedLinks |
    Permissions.UploadFiles |
    Permissions.UseExternalEmoji |
    Permissions.CreateInvites |
    Permissions.ChangeNickname;

export function computePermissions(params: {
    userId: string;
    roleIds: string[];
    server: {
        ownerId: string;
        everyoneRoleId: string;
    };
    roles: Map<string, { permissions: bigint }>;
    channelRoleOverrides: Map<string, { allow: bigint; deny: bigint }>;
    channelMemberOverride?: { allow: bigint; deny: bigint };
}): bigint {
    const { userId, roleIds, server, roles, channelRoleOverrides, channelMemberOverride } = params;

    // Owner gets everything, including DirectAgents
    if (userId === server.ownerId) {
        return KNOWN_PERMS_MASK;
    }

    // Start with @everyone role permissions
    const everyoneRole = roles.get(server.everyoneRoleId);
    let permissions = everyoneRole?.permissions ?? 0n;

    // OR all assigned role permissions
    for (const roleId of roleIds) {
        const role = roles.get(roleId);
        if (role) permissions |= role.permissions;
    }

    const isAdmin = (permissions & Permissions.Administrator) !== 0n;

    // Apply @everyone channel override
    const everyoneOverride = channelRoleOverrides.get(server.everyoneRoleId);
    if (everyoneOverride) {
        permissions = (permissions & ~everyoneOverride.deny) | everyoneOverride.allow;
    }

    // Aggregate all role overrides, then apply once
    let roleAllow = 0n;
    let roleDeny = 0n;
    for (const roleId of roleIds) {
        const override = channelRoleOverrides.get(roleId);
        if (override) {
            roleAllow |= override.allow;
            roleDeny |= override.deny;
        }
    }
    permissions = (permissions & ~roleDeny) | roleAllow;

    // Member override — final word
    if (channelMemberOverride) {
        permissions = (permissions & ~channelMemberOverride.deny) | channelMemberOverride.allow;
    }

    // Administrator gets every ordinary permission regardless of overrides, but
    // DirectAgents only as roles and overrides grant it
    if (isAdmin) {
        return ALL_PERMS_MASK | (permissions & Permissions.DirectAgents);
    }

    return permissions;
}

export const ALL_PERMS_MASK = (1n << 27n) - 1n;

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
    AddReactions:       1n << 15n,
    MentionEveryone:    1n << 16n,
    ReadMessageHistory: 1n << 17n,
    UseExternalEmoji:   1n << 18n,
    VoiceConnect:       1n << 20n,
    VoiceSpeak:         1n << 21n,
    VoiceVideo:         1n << 22n,
    VoiceMuteMembers:   1n << 23n,
    VoiceDeafenMembers: 1n << 24n,
    VoiceMoveMembers:   1n << 25n,
    VoicePriority:      1n << 26n,
} as const;

export const DEFAULT_EVERYONE_PERMS =
    Permissions.ViewChannel |
    Permissions.SendMessages |
    Permissions.ReadMessageHistory |
    Permissions.EmbedLinks |
    Permissions.UploadFiles |
    Permissions.AddReactions |
    Permissions.UseExternalEmoji |
    Permissions.CreateInvites |
    Permissions.ChangeNickname |
    Permissions.VoiceConnect |
    Permissions.VoiceSpeak |
    Permissions.VoiceVideo;

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

    // Owner gets everything
    if (userId === server.ownerId) {
        return ALL_PERMS_MASK;
    }

    // Start with @everyone role permissions
    const everyoneRole = roles.get(server.everyoneRoleId);
    let permissions = everyoneRole?.permissions ?? 0n;

    // OR all assigned role permissions
    for (const roleId of roleIds) {
        const role = roles.get(roleId);
        if (role) permissions |= role.permissions;
    }

    // Admin shortcut
    if (permissions & Permissions.Administrator) {
        return ALL_PERMS_MASK;
    }

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

    return permissions;
}

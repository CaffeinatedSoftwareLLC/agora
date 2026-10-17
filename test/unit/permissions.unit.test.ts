import { computePermissions, Permissions, ALL_PERMS_MASK, KNOWN_PERMS_MASK } from '../../src/permissions';

function baseScenario(opts: {
    isOwner?: boolean;
    everyonePerms?: bigint;
    rolePerms?: bigint;
    hasRole?: boolean;
}): bigint {
    const everyoneRoleId = 'role_everyone';
    const roles = new Map<string, { permissions: bigint }>();
    roles.set(everyoneRoleId, { permissions: opts.everyonePerms ?? 0n });

    const userRoleIds: string[] = [];
    if (opts.hasRole && opts.rolePerms !== undefined) {
        roles.set('extra_role', { permissions: opts.rolePerms });
        userRoleIds.push('extra_role');
    }

    return computePermissions({
        userId: opts.isOwner ? 'owner_id' : 'regular_user',
        roleIds: userRoleIds,
        server: { ownerId: 'owner_id', everyoneRoleId },
        roles,
        channelRoleOverrides: new Map(),
        channelMemberOverride: undefined,
    });
}

describe('Permissions — Sprint Minimum', () => {
    test('server owner always gets every permission, DirectAgents included', () => {
        expect(baseScenario({ isOwner: true, everyonePerms: 0n })).toBe(KNOWN_PERMS_MASK);
        expect(baseScenario({ isOwner: true, everyonePerms: 0n }) & Permissions.DirectAgents).toBe(Permissions.DirectAgents);
    });

    test('Administrator does not imply DirectAgents', () => {
        const result = baseScenario({ everyonePerms: 0n, rolePerms: Permissions.Administrator, hasRole: true });
        expect(result & Permissions.DirectAgents).toBe(0n);
    });

    test('Administrator keeps DirectAgents only when a role grants it', () => {
        const result = baseScenario({ everyonePerms: 0n, rolePerms: Permissions.Administrator | Permissions.DirectAgents, hasRole: true });
        expect(result).toBe(ALL_PERMS_MASK | Permissions.DirectAgents);
    });

    test('Administrator from any role yields ALL_PERMS_MASK', () => {
        const result = baseScenario({
            everyonePerms: 0n,
            rolePerms: Permissions.Administrator,
            hasRole: true,
        });
        expect(result).toBe(ALL_PERMS_MASK);
    });

    test('@everyone base OR role permissions (no overlap with ungranted)', () => {
        const result = baseScenario({
            everyonePerms: Permissions.ViewChannel,
            rolePerms: Permissions.SendMessages,
            hasRole: true,
        });
        expect(result & Permissions.ViewChannel).toBeTruthy();
        expect(result & Permissions.SendMessages).toBeTruthy();
        expect(result & Permissions.ManageMessages).toBeFalsy();
    });
});

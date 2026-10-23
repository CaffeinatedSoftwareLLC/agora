import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { Permissions, DEFAULT_EVERYONE_PERMS } from '../../src/permissions';
import { OWNER_ONLY_ERROR } from '../../src/lib/direct-agents';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await cleanDatabase(ctx.db); });

type User = Awaited<ReturnType<typeof authedUser>>;

async function createRole(auth: User['auth'], serverId: string, name: string, perms: bigint): Promise<string> {
    const res = await ctx.request.post(`/servers/${serverId}/roles`).set(auth).send({ name, permissions: perms.toString() });
    expect(res.status).toBe(201);
    return res.body.id;
}

async function assign(auth: User['auth'], serverId: string, userId: string, roleId: string) {
    expect((await ctx.request.put(`/servers/${serverId}/members/${userId}/roles/${roleId}`).set(auth)).status).toBe(200);
}

async function rolePerms(roleId: string): Promise<string> {
    return (await ctx.db.query('SELECT permissions FROM roles WHERE id = $1', [roleId])).rows[0].permissions.toString();
}

/** A server with an owner and members holding ManageRoles only, Administrator, and nothing extra. */
async function roleWorld(tag: string) {
    const owner = await authedUser(ctx.request, `${tag}owner`);
    const manager = await authedUser(ctx.request, `${tag}mgr`);
    const admin = await authedUser(ctx.request, `${tag}admin`);
    const member = await authedUser(ctx.request, `${tag}member`);
    const server = await createServer(ctx.request, owner.auth, `${tag} server`);
    for (const u of [manager, admin, member]) await joinViaInvite(ctx.request, owner.auth, u.auth, server.serverId);
    const managerRole = await createRole(owner.auth, server.serverId, 'Managers', Permissions.ManageRoles);
    const adminRole = await createRole(owner.auth, server.serverId, 'Admins', Permissions.Administrator);
    const kickRole = await createRole(owner.auth, server.serverId, 'Kickers', Permissions.KickMembers);
    await assign(owner.auth, server.serverId, manager.userId, managerRole);
    await assign(owner.auth, server.serverId, admin.userId, adminRole);
    return { owner, manager, admin, member, ...server, managerRole, adminRole, kickRole };
}

describe('Role hierarchy', () => {
    it('a ManageRoles-only member cannot edit, delete or unassign an Administrator role', async () => {
        const w = await roleWorld('rh1');
        const base = `/servers/${w.serverId}`;

        const zero = await ctx.request.patch(`${base}/roles/${w.adminRole}`).set(w.manager.auth).send({ permissions: '0' });
        expect(zero.status).toBe(403);
        expect(zero.body.error).toContain('permissions you do not have');
        expect((await ctx.request.patch(`${base}/roles/${w.adminRole}`).set(w.manager.auth).send({ name: 'Renamed' })).status).toBe(403);
        expect((await ctx.request.delete(`${base}/roles/${w.adminRole}`).set(w.manager.auth)).status).toBe(403);
        expect((await ctx.request.delete(`${base}/members/${w.admin.userId}/roles/${w.adminRole}`).set(w.manager.auth)).status).toBe(403);
        expect((await ctx.request.put(`${base}/members/${w.member.userId}/roles/${w.adminRole}`).set(w.manager.auth)).status).toBe(403);

        expect(await rolePerms(w.adminRole)).toBe(Permissions.Administrator.toString());
        const held = await ctx.db.query('SELECT 1 FROM member_roles WHERE user_id = $1 AND role_id = $2', [w.admin.userId, w.adminRole]);
        expect(held.rows.length).toBe(1);
    });

    it('a ManageRoles-only member cannot touch a role carrying a bit they lack', async () => {
        const w = await roleWorld('rh2');
        const base = `/servers/${w.serverId}`;
        await assign(w.owner.auth, w.serverId, w.member.userId, w.kickRole);

        expect((await ctx.request.patch(`${base}/roles/${w.kickRole}`).set(w.manager.auth).send({ permissions: '0' })).status).toBe(403);
        expect((await ctx.request.delete(`${base}/roles/${w.kickRole}`).set(w.manager.auth)).status).toBe(403);
        expect((await ctx.request.delete(`${base}/members/${w.member.userId}/roles/${w.kickRole}`).set(w.manager.auth)).status).toBe(403);
        expect((await ctx.request.put(`/channels/${w.generalChannelId}/overrides/roles/${w.kickRole}`).set(w.manager.auth)
            .send({ allow: '0', deny: Permissions.ViewChannel.toString() })).status).toBe(403);
        expect(await rolePerms(w.kickRole)).toBe(Permissions.KickMembers.toString());
    });

    it('a ManageRoles-only member can manage roles within their own permissions', async () => {
        const w = await roleWorld('rh3');
        const base = `/servers/${w.serverId}`;
        const within = await createRole(w.manager.auth, w.serverId, 'Helpers', Permissions.ManageRoles | Permissions.ViewChannel);

        const patched = await ctx.request.patch(`${base}/roles/${within}`).set(w.manager.auth).send({ name: 'Helpers2', permissions: Permissions.ViewChannel.toString() });
        expect(patched.status).toBe(200);
        expect(patched.body.permissions).toBe(Permissions.ViewChannel.toString());
        expect((await ctx.request.put(`${base}/members/${w.member.userId}/roles/${within}`).set(w.manager.auth)).status).toBe(200);
        expect((await ctx.request.put(`/channels/${w.generalChannelId}/overrides/roles/${within}`).set(w.manager.auth)
            .send({ allow: '0', deny: Permissions.SendMessages.toString() })).status).toBe(200);
        expect((await ctx.request.delete(`/channels/${w.generalChannelId}/overrides/roles/${within}`).set(w.manager.auth)).status).toBe(200);
        expect((await ctx.request.delete(`${base}/members/${w.member.userId}/roles/${within}`).set(w.manager.auth)).status).toBe(200);
        expect((await ctx.request.delete(`${base}/roles/${within}`).set(w.manager.auth)).status).toBe(200);
    });

    // @everyone reaches every member at once: stripping it (or denying it per channel) would lock
    // everyone out, so only the owner and Administrators change it
    it('a ManageRoles-only member cannot change @everyone or its channel overrides; an Administrator can', async () => {
        const w = await roleWorld('rh4');
        const path = `/servers/${w.serverId}/roles/${w.everyoneRoleId}`;
        const override = `/channels/${w.generalChannelId}/overrides/roles/${w.everyoneRoleId}`;
        const lockout = { allow: '0', deny: (Permissions.ViewChannel | Permissions.SendMessages).toString() };

        for (const permissions of ['0', (DEFAULT_EVERYONE_PERMS & ~Permissions.SendMessages).toString(),
            (DEFAULT_EVERYONE_PERMS | Permissions.KickMembers).toString(), Permissions.Administrator.toString()]) {
            const res = await ctx.request.patch(path).set(w.manager.auth).send({ permissions });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('Only the owner and Administrators can change @everyone permissions');
        }
        expect(await rolePerms(w.everyoneRoleId)).toBe(DEFAULT_EVERYONE_PERMS.toString());
        // Leaving the permissions as they are is not a change
        expect((await ctx.request.patch(path).set(w.manager.auth).send({ permissions: DEFAULT_EVERYONE_PERMS.toString() })).status).toBe(200);

        expect((await ctx.request.put(override).set(w.manager.auth).send(lockout)).status).toBe(403);
        const overrides = () => ctx.db.query('SELECT 1 FROM channel_role_overrides WHERE role_id = $1', [w.everyoneRoleId]);
        expect((await overrides()).rows.length).toBe(0);

        // An Administrator can, and a manager can't undo it either
        expect((await ctx.request.put(override).set(w.admin.auth).send(lockout)).status).toBe(200);
        expect((await ctx.request.delete(override).set(w.manager.auth)).status).toBe(403);
        expect((await overrides()).rows.length).toBe(1);
        expect((await ctx.request.delete(override).set(w.admin.auth)).status).toBe(200);
        const trimmed = (DEFAULT_EVERYONE_PERMS & ~Permissions.CreateInvites).toString();
        expect((await ctx.request.patch(path).set(w.admin.auth).send({ permissions: trimmed })).status).toBe(200);
        expect(await rolePerms(w.everyoneRoleId)).toBe(trimmed);
    });

    it('an Administrator can manage every role except DirectAgents roles, which stay with the owner', async () => {
        const w = await roleWorld('rh5');
        const base = `/servers/${w.serverId}`;
        const other = await authedUser(ctx.request, 'rh5other');
        await joinViaInvite(ctx.request, w.owner.auth, other.auth, w.serverId);
        await assign(w.owner.auth, w.serverId, other.userId, w.adminRole);

        expect((await ctx.request.patch(`${base}/roles/${w.kickRole}`).set(w.admin.auth).send({ permissions: '0' })).status).toBe(200);
        expect((await ctx.request.delete(`${base}/members/${other.userId}/roles/${w.adminRole}`).set(w.admin.auth)).status).toBe(200);
        const secondAdmin = await createRole(w.owner.auth, w.serverId, 'Admins2', Permissions.Administrator);
        expect((await ctx.request.delete(`${base}/roles/${secondAdmin}`).set(w.admin.auth)).status).toBe(200);
        expect((await ctx.request.patch(`${base}/roles/${w.everyoneRoleId}`).set(w.admin.auth).send({ permissions: '0' })).status).toBe(200);

        const directors = await createRole(w.owner.auth, w.serverId, 'Directors', Permissions.DirectAgents);
        const refused = await ctx.request.delete(`${base}/roles/${directors}`).set(w.admin.auth);
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe(OWNER_ONLY_ERROR);
    });

    it('the owner can manage Administrator roles', async () => {
        const w = await roleWorld('rh6');
        const base = `/servers/${w.serverId}`;
        expect((await ctx.request.delete(`${base}/members/${w.admin.userId}/roles/${w.adminRole}`).set(w.owner.auth)).status).toBe(200);
        expect((await ctx.request.patch(`${base}/roles/${w.adminRole}`).set(w.owner.auth).send({ permissions: '0' })).status).toBe(200);
        expect((await ctx.request.delete(`${base}/roles/${w.adminRole}`).set(w.owner.auth)).status).toBe(200);
    });
});

describe('SendMessages', () => {
    async function chat(tag: string) {
        const owner = await authedUser(ctx.request, `${tag}owner`);
        const member = await authedUser(ctx.request, `${tag}member`);
        const server = await createServer(ctx.request, owner.auth, `${tag} server`);
        await joinViaInvite(ctx.request, owner.auth, member.auth, server.serverId);
        const parent = await ctx.request.post(`/channels/${server.generalChannelId}/messages`).set(member.auth).send({ content: 'before' });
        expect(parent.status).toBe(201);
        return { owner, member, ...server, parentId: parent.body.id as string };
    }

    it('members post by default; a channel deny blocks posts, replies and edits but not reading', async () => {
        const c = await chat('sm1');
        const ch = `/channels/${c.generalChannelId}`;
        expect((await ctx.request.put(`${ch}/overrides/roles/${c.everyoneRoleId}`).set(c.owner.auth)
            .send({ allow: '0', deny: Permissions.SendMessages.toString() })).status).toBe(200);

        const post = await ctx.request.post(`${ch}/messages`).set(c.member.auth).send({ content: 'muted' });
        expect(post.status).toBe(403);
        expect(post.body.error).toBe('Missing SendMessages permission');
        expect((await ctx.request.post(`${ch}/messages/${c.parentId}/replies`).set(c.member.auth).send({ content: 'muted' })).status).toBe(403);
        expect((await ctx.request.patch(`${ch}/messages/${c.parentId}`).set(c.member.auth).send({ content: 'rewritten' })).status).toBe(403);
        expect((await ctx.request.get(`${ch}/messages`).set(c.member.auth)).status).toBe(200);
        expect((await ctx.request.post(`${ch}/messages`).set(c.owner.auth).send({ content: 'owner still posts' })).status).toBe(201);

        // A member override grants it back
        expect((await ctx.request.put(`${ch}/overrides/members/${c.member.userId}`).set(c.owner.auth)
            .send({ allow: Permissions.SendMessages.toString(), deny: '0' })).status).toBe(200);
        expect((await ctx.request.post(`${ch}/messages`).set(c.member.auth).send({ content: 'unmuted' })).status).toBe(201);
    });

    it('without SendMessages on @everyone, only members whose role grants it post', async () => {
        const c = await chat('sm2');
        const ch = `/channels/${c.generalChannelId}`;
        expect((await ctx.request.patch(`/servers/${c.serverId}/roles/${c.everyoneRoleId}`).set(c.owner.auth)
            .send({ permissions: (DEFAULT_EVERYONE_PERMS & ~Permissions.SendMessages).toString() })).status).toBe(200);
        expect((await ctx.request.post(`${ch}/messages`).set(c.member.auth).send({ content: 'no' })).status).toBe(403);

        const speakers = await createRole(c.owner.auth, c.serverId, 'Speakers', Permissions.SendMessages);
        await assign(c.owner.auth, c.serverId, c.member.userId, speakers);
        expect((await ctx.request.post(`${ch}/messages`).set(c.member.auth).send({ content: 'yes' })).status).toBe(201);
        expect((await ctx.request.post(`${ch}/messages/${c.parentId}/replies`).set(c.member.auth).send({ content: 'yes' })).status).toBe(201);
    });

    it('a bot posts wherever it has channel access, whatever SendMessages says; removing the access stops it', async () => {
        const c = await chat('sm3');
        const ch = `/channels/${c.generalChannelId}`;
        const bot = await ctx.request.post(`/servers/${c.serverId}/bots`).set(c.owner.auth).send({ username: 'sm3bot' });
        expect(bot.status).toBe(201);
        const token = await ctx.request.post(`/servers/${c.serverId}/bots/${bot.body.id}/tokens`).set(c.owner.auth).send({});
        const botAuth = { Authorization: `Bot ${token.body.token}` };
        expect((await ctx.request.post(`${ch}/bots/${bot.body.id}`).set(c.owner.auth)).status).toBe(201);

        expect((await ctx.request.post(`${ch}/messages`).set(botAuth).send({ content: 'bot hello' })).status).toBe(201);
        expect((await ctx.request.post(`${ch}/messages/${c.parentId}/replies`).set(botAuth).send({ content: 'bot reply' })).status).toBe(201);

        // Hidden from @everyone: the bot's explicit access still lets it post
        expect((await ctx.request.put(`${ch}/overrides/roles/${c.everyoneRoleId}`).set(c.owner.auth)
            .send({ allow: '0', deny: Permissions.ViewChannel.toString() })).status).toBe(200);
        expect((await ctx.request.post(`${ch}/messages`).set(botAuth).send({ content: 'bot in private' })).status).toBe(201);

        // "Agents post, people watch": SendMessages denied to @everyone in the channel and on the server
        expect((await ctx.request.put(`${ch}/overrides/roles/${c.everyoneRoleId}`).set(c.owner.auth)
            .send({ allow: '0', deny: (Permissions.ViewChannel | Permissions.SendMessages).toString() })).status).toBe(200);
        expect((await ctx.request.patch(`/servers/${c.serverId}/roles/${c.everyoneRoleId}`).set(c.owner.auth)
            .send({ permissions: (DEFAULT_EVERYONE_PERMS & ~Permissions.SendMessages).toString() })).status).toBe(200);
        expect((await ctx.request.post(`${ch}/messages`).set(botAuth).send({ content: 'bot still posts' })).status).toBe(201);
        expect((await ctx.request.post(`${ch}/messages/${c.parentId}/replies`).set(botAuth).send({ content: 'and replies' })).status).toBe(201);
        expect((await ctx.request.post(`${ch}/messages`).set(c.member.auth).send({ content: 'member' })).status).toBe(403);

        // Muting a bot means removing its channel access
        expect((await ctx.request.delete(`${ch}/bots/${bot.body.id}`).set(c.owner.auth)).status).toBe(200);
        expect((await ctx.request.post(`${ch}/messages`).set(botAuth).send({ content: 'gone' })).status).toBe(403);
    });
});

describe('MentionEveryone', () => {
    async function mentionCount(channelId: string, userId: string): Promise<number> {
        const row = await ctx.db.query('SELECT mention_count FROM channel_unreads WHERE channel_id = $1 AND user_id = $2', [channelId, userId]);
        return row.rows[0]?.mention_count ?? 0;
    }

    it('@everyone from a member without MentionEveryone posts as text and notifies no one', async () => {
        const owner = await authedUser(ctx.request, 'me1owner');
        const member = await authedUser(ctx.request, 'me1member');
        const { serverId, generalChannelId } = await createServer(ctx.request, owner.auth, 'me1');
        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
        const ch = `/channels/${generalChannelId}`;

        const post = await ctx.request.post(`${ch}/messages`).set(member.auth).send({ content: '@everyone look' });
        expect(post.status).toBe(201);
        expect(post.body.content).toBe('@everyone look');
        expect(post.body.mentionsEveryone).toBe(false);
        expect((await ctx.db.query('SELECT mentions_everyone FROM messages WHERE id = $1', [post.body.id])).rows[0].mentions_everyone).toBe(false);
        const reply = await ctx.request.post(`${ch}/messages/${post.body.id}/replies`).set(member.auth).send({ content: '@everyone again' });
        expect(reply.status).toBe(201);
        expect(reply.body.mentionsEveryone).toBe(false);
        expect(await mentionCount(generalChannelId, owner.userId)).toBe(0);

        // With the bit, it reaches everyone
        const shouters = await createRole(owner.auth, serverId, 'Shouters', Permissions.MentionEveryone);
        await assign(owner.auth, serverId, member.userId, shouters);
        const loud = await ctx.request.post(`${ch}/messages`).set(member.auth).send({ content: '@everyone now' });
        expect(loud.body.mentionsEveryone).toBe(true);
        expect(await mentionCount(generalChannelId, owner.userId)).toBe(1);

        // The owner always holds it
        const fromOwner = await ctx.request.post(`${ch}/messages`).set(owner.auth).send({ content: '@everyone owner' });
        expect(fromOwner.body.mentionsEveryone).toBe(true);
        expect(await mentionCount(generalChannelId, member.userId)).toBe(1);
    });
});

describe('Channel overrides', () => {
    /** roleWorld plus a channel hidden from @everyone and a member holding KickMembers. */
    async function overrideWorld(tag: string) {
        const w = await roleWorld(tag);
        const hidden = await ctx.request.post(`/servers/${w.serverId}/channels`).set(w.owner.auth).send({ name: 'hidden', channelType: 3 });
        expect(hidden.status).toBe(201);
        expect((await ctx.request.put(`/channels/${hidden.body.id}/overrides/roles/${w.everyoneRoleId}`).set(w.owner.auth)
            .send({ allow: '0', deny: Permissions.ViewChannel.toString() })).status).toBe(200);
        await assign(w.owner.auth, w.serverId, w.member.userId, w.kickRole);
        return { ...w, hiddenId: hidden.body.id as string };
    }
    const deny = (bits: bigint) => ({ allow: '0', deny: bits.toString() });
    const allow = (bits: bigint) => ({ allow: bits.toString(), deny: '0' });

    it('a ManageRoles-only member cannot set or remove member overrides on the owner, an Administrator or a more powerful member', async () => {
        const w = await overrideWorld('co1');
        const ch = `/channels/${w.generalChannelId}/overrides/members`;
        const lockout = deny(Permissions.ViewChannel | Permissions.SendMessages);
        for (const target of [w.owner, w.admin, w.member]) {
            const res = await ctx.request.put(`${ch}/${target.userId}`).set(w.manager.auth).send(lockout);
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('Cannot change overrides for a member with permissions you do not have');
        }

        // The owner's allow override for a powerful member stays put
        expect((await ctx.request.put(`/channels/${w.hiddenId}/overrides/members/${w.member.userId}`).set(w.owner.auth)
            .send(allow(Permissions.ViewChannel))).status).toBe(200);
        expect((await ctx.request.put(`/channels/${w.hiddenId}/overrides/members/${w.manager.userId}`).set(w.owner.auth)
            .send(allow(Permissions.ViewChannel))).status).toBe(200);
        expect((await ctx.request.delete(`/channels/${w.hiddenId}/overrides/members/${w.member.userId}`).set(w.manager.auth)).status).toBe(403);
        const kept = await ctx.db.query('SELECT 1 FROM channel_member_overrides WHERE channel_id = $1 AND user_id = $2', [w.hiddenId, w.member.userId]);
        expect(kept.rows.length).toBe(1);

        // A member with nothing the manager lacks is in reach; an Administrator reaches everyone
        const plain = await authedUser(ctx.request, 'co1plain');
        await joinViaInvite(ctx.request, w.owner.auth, plain.auth, w.serverId);
        expect((await ctx.request.put(`${ch}/${plain.userId}`).set(w.manager.auth).send(deny(Permissions.SendMessages))).status).toBe(200);
        expect((await ctx.request.delete(`${ch}/${plain.userId}`).set(w.manager.auth)).status).toBe(200);
        expect((await ctx.request.put(`${ch}/${w.member.userId}`).set(w.admin.auth).send(lockout)).status).toBe(200);
        expect((await ctx.request.delete(`/channels/${w.hiddenId}/overrides/members/${w.member.userId}`).set(w.admin.auth)).status).toBe(200);
    });

    it('a ManageRoles-only member cannot open a hidden channel to themselves, by member or role override', async () => {
        const w = await overrideWorld('co2');
        const ch = `/channels/${w.hiddenId}/overrides`;
        for (const res of [
            await ctx.request.put(`${ch}/members/${w.manager.userId}`).set(w.manager.auth).send(allow(Permissions.ViewChannel)),
            await ctx.request.put(`${ch}/roles/${w.managerRole}`).set(w.manager.auth).send(allow(Permissions.ViewChannel)),
            await ctx.request.get(ch).set(w.manager.auth),
        ]) {
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('Channel access denied');
        }
        expect((await ctx.db.query('SELECT 1 FROM channel_member_overrides WHERE channel_id = $1', [w.hiddenId])).rows.length).toBe(0);
        expect((await ctx.request.get(`/channels/${w.hiddenId}/messages`).set(w.manager.auth)).status).toBe(403);
    });

    it('in a channel they see, a ManageRoles-only member grants only bits they hold there and cannot lift a deny on themselves', async () => {
        const w = await overrideWorld('co3');
        const ch = `/channels/${w.generalChannelId}/overrides`;
        // The owner denies SendMessages to the manager's role in #general
        expect((await ctx.request.put(`${ch}/roles/${w.managerRole}`).set(w.owner.auth).send(deny(Permissions.SendMessages))).status).toBe(200);

        const grantErr = 'Cannot grant permissions you do not have in this channel';
        for (const res of [
            await ctx.request.put(`${ch}/members/${w.manager.userId}`).set(w.manager.auth).send(allow(Permissions.SendMessages)),
            await ctx.request.put(`${ch}/roles/${w.managerRole}`).set(w.manager.auth).send({ allow: '0', deny: '0' }),
            await ctx.request.delete(`${ch}/roles/${w.managerRole}`).set(w.manager.auth),
        ]) {
            expect(res.status).toBe(403);
            expect(res.body.error).toBe(grantErr);
        }
        expect((await ctx.request.post(`/channels/${w.generalChannelId}/messages`).set(w.manager.auth).send({ content: 'x' })).status).toBe(403);

        // Bits they hold in the channel are theirs to grant, and the list is theirs to read
        const helpers = await createRole(w.manager.auth, w.serverId, 'Helpers', 0n);
        expect((await ctx.request.put(`${ch}/roles/${helpers}`).set(w.manager.auth).send(allow(Permissions.EmbedLinks))).status).toBe(200);
        expect((await ctx.request.put(`${ch}/roles/${helpers}`).set(w.manager.auth).send(allow(Permissions.SendMessages))).status).toBe(403);
        const list = await ctx.request.get(ch).set(w.manager.auth);
        expect(list.status).toBe(200);
        expect(list.body.roles.map((r: any) => r.roleId)).toContain(helpers);
    });

    it('a role granting more through channel overrides is out of a ManageRoles-only member\'s reach', async () => {
        const w = await overrideWorld('co4');
        // "Staff" holds nothing server-wide but opens the hidden channel
        const staff = await createRole(w.owner.auth, w.serverId, 'Staff', 0n);
        expect((await ctx.request.put(`/channels/${w.hiddenId}/overrides/roles/${staff}`).set(w.owner.auth)
            .send(allow(Permissions.ViewChannel))).status).toBe(200);
        const plain = await authedUser(ctx.request, 'co4plain');
        await joinViaInvite(ctx.request, w.owner.auth, plain.auth, w.serverId);
        await assign(w.owner.auth, w.serverId, plain.userId, staff);
        const base = `/servers/${w.serverId}`;

        const hierarchyErr = 'Cannot manage a role with permissions you do not have';
        for (const res of [
            await ctx.request.put(`${base}/members/${w.manager.userId}/roles/${staff}`).set(w.manager.auth),
            await ctx.request.patch(`${base}/roles/${staff}`).set(w.manager.auth).send({ name: 'Mine' }),
            await ctx.request.delete(`${base}/members/${plain.userId}/roles/${staff}`).set(w.manager.auth),
            await ctx.request.delete(`${base}/roles/${staff}`).set(w.manager.auth),
        ]) {
            expect(res.status).toBe(403);
            expect(res.body.error).toBe(hierarchyErr);
        }
        expect((await ctx.request.get(`/channels/${w.hiddenId}/messages`).set(w.manager.auth)).status).toBe(403);

        // Once the manager sees the channel too, Staff grants nothing they lack
        expect((await ctx.request.put(`/channels/${w.hiddenId}/overrides/members/${w.manager.userId}`).set(w.owner.auth)
            .send(allow(Permissions.ViewChannel))).status).toBe(200);
        expect((await ctx.request.put(`${base}/members/${w.member.userId}/roles/${staff}`).set(w.manager.auth)).status).toBe(200);
        // An Administrator reaches it regardless
        expect((await ctx.request.delete(`${base}/roles/${staff}`).set(w.admin.auth)).status).toBe(200);
    });
});

describe('ManageChannels', () => {
    async function channelWorld(tag: string) {
        const owner = await authedUser(ctx.request, `${tag}owner`);
        const member = await authedUser(ctx.request, `${tag}member`);
        const admin = await authedUser(ctx.request, `${tag}admin`);
        const server = await createServer(ctx.request, owner.auth, `${tag} server`);
        await joinViaInvite(ctx.request, owner.auth, member.auth, server.serverId);
        await joinViaInvite(ctx.request, owner.auth, admin.auth, server.serverId);
        const adminRole = await createRole(owner.auth, server.serverId, 'Admins', Permissions.Administrator);
        await assign(owner.auth, server.serverId, admin.userId, adminRole);
        const create = (auth: Record<string, string>, name: string) =>
            ctx.request.post(`/servers/${server.serverId}/channels`).set(auth).send({ name, channelType: 3 });
        return { owner, member, admin, adminRole, create, ...server };
    }

    it('@everyone holds ManageChannels by default, so members create channels', async () => {
        expect(DEFAULT_EVERYONE_PERMS & Permissions.ManageChannels).toBe(Permissions.ManageChannels);
        const w = await channelWorld('mc1');
        expect(BigInt(await rolePerms(w.everyoneRoleId)) & Permissions.ManageChannels).toBe(Permissions.ManageChannels);
        expect((await w.create(w.member.auth, 'by-member')).status).toBe(201);

        const outsider = await authedUser(ctx.request, 'mc1outsider');
        expect((await w.create(outsider.auth, 'outside')).status).toBe(403);
    });

    it('stripped from @everyone, only holders, the owner and Administrators create channels', async () => {
        const w = await channelWorld('mc2');
        expect((await ctx.request.patch(`/servers/${w.serverId}/roles/${w.everyoneRoleId}`).set(w.owner.auth)
            .send({ permissions: (DEFAULT_EVERYONE_PERMS & ~Permissions.ManageChannels).toString() })).status).toBe(200);

        const denied = await w.create(w.member.auth, 'nope');
        expect(denied.status).toBe(403);
        expect(denied.body.error).toBe('Missing ManageChannels permission');
        expect((await w.create(w.owner.auth, 'by-owner')).status).toBe(201);
        expect((await w.create(w.admin.auth, 'by-admin')).status).toBe(201);

        await assign(w.owner.auth, w.serverId, w.member.userId, await createRole(w.owner.auth, w.serverId, 'Builders', Permissions.ManageChannels));
        expect((await w.create(w.member.auth, 'by-builder')).status).toBe(201);
    });

    it('a bot cannot create channels, even holding roles that grant ManageChannels or Administrator', async () => {
        const w = await channelWorld('mc3');
        const bot = await ctx.request.post(`/servers/${w.serverId}/bots`).set(w.owner.auth).send({ username: 'mc3bot' });
        expect(bot.status).toBe(201);
        const token = await ctx.request.post(`/servers/${w.serverId}/bots/${bot.body.id}/tokens`).set(w.owner.auth).send({});
        const botAuth = { Authorization: `Bot ${token.body.token}` };
        expect((await ctx.request.post(`/channels/${w.generalChannelId}/bots/${bot.body.id}`).set(w.owner.auth)).status).toBe(201);

        const count = async () => (await ctx.db.query('SELECT count(*)::int AS n FROM channels WHERE server_id = $1', [w.serverId])).rows[0].n;
        const before = await count();
        // Bots inherit @everyone, which holds ManageChannels by default
        expect((await w.create(botAuth, 'by-bot')).status).toBe(403);

        // Bots are not members and the API gives them no roles; give them membership and roles directly
        await ctx.db.query('INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)', [w.serverId, bot.body.id]);
        const builders = await createRole(w.owner.auth, w.serverId, 'Builders', Permissions.ManageChannels);
        for (const roleId of [builders, w.adminRole]) {
            await ctx.db.query('INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)', [w.serverId, bot.body.id, roleId]);
        }
        expect((await w.create(botAuth, 'by-bot')).status).toBe(403);
        expect(await count()).toBe(before);
    });
});

describe('Migration 066: ManageChannels for existing @everyone roles', () => {
    const migration = readFileSync(resolve(__dirname, '../../src/db/migrations/066_everyone_manage_channels.sql'), 'utf8');
    const legacyDefault = DEFAULT_EVERYONE_PERMS & ~Permissions.ManageChannels;

    it('ORs the bit into every @everyone role only, keeps other bits and deny overrides, and is idempotent', async () => {
        const owner = await authedUser(ctx.request, 'm66owner');
        const a = await createServer(ctx.request, owner.auth, 'm66 a');
        const b = await createServer(ctx.request, owner.auth, 'm66 b');
        const kickers = await createRole(owner.auth, a.serverId, 'Kickers', Permissions.KickMembers);
        // Servers from before the change: @everyone without ManageChannels, one with an extra bit
        await ctx.db.query('UPDATE roles SET permissions = $1 WHERE id = $2', [legacyDefault.toString(), a.everyoneRoleId]);
        await ctx.db.query('UPDATE roles SET permissions = $1 WHERE id = $2', [(legacyDefault | Permissions.MentionEveryone).toString(), b.everyoneRoleId]);
        expect((await ctx.request.put(`/channels/${a.generalChannelId}/overrides/roles/${a.everyoneRoleId}`).set(owner.auth)
            .send({ allow: '0', deny: Permissions.ManageChannels.toString() })).status).toBe(200);

        await ctx.db.query(migration);
        await ctx.db.query(migration);

        expect(await rolePerms(a.everyoneRoleId)).toBe((legacyDefault | Permissions.ManageChannels).toString());
        expect(await rolePerms(b.everyoneRoleId)).toBe((legacyDefault | Permissions.MentionEveryone | Permissions.ManageChannels).toString());
        expect(await rolePerms(kickers)).toBe(Permissions.KickMembers.toString());
        const override = await ctx.db.query(
            'SELECT deny FROM channel_role_overrides WHERE channel_id = $1 AND role_id = $2',
            [a.generalChannelId, a.everyoneRoleId],
        );
        expect(override.rows[0].deny.toString()).toBe(Permissions.ManageChannels.toString());
    });
});

describe('CreateInvites', () => {
    it('members invite by default; without the bit only holders, the owner and Administrators may', async () => {
        const owner = await authedUser(ctx.request, 'ci1owner');
        const member = await authedUser(ctx.request, 'ci1member');
        const admin = await authedUser(ctx.request, 'ci1admin');
        const { serverId, everyoneRoleId } = await createServer(ctx.request, owner.auth, 'ci1');
        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
        await joinViaInvite(ctx.request, owner.auth, admin.auth, serverId);
        await assign(owner.auth, serverId, admin.userId, await createRole(owner.auth, serverId, 'Admins', Permissions.Administrator));
        const invite = (auth: User['auth']) => ctx.request.post(`/servers/${serverId}/invites`).set(auth);

        expect((await invite(member.auth)).status).toBe(201);

        expect((await ctx.request.patch(`/servers/${serverId}/roles/${everyoneRoleId}`).set(owner.auth)
            .send({ permissions: (DEFAULT_EVERYONE_PERMS & ~Permissions.CreateInvites).toString() })).status).toBe(200);
        const denied = await invite(member.auth);
        expect(denied.status).toBe(403);
        expect(denied.body.error).toBe('Missing CreateInvites permission');
        expect((await invite(owner.auth)).status).toBe(201);
        expect((await invite(admin.auth)).status).toBe(201);

        await assign(owner.auth, serverId, member.userId, await createRole(owner.auth, serverId, 'Inviters', Permissions.CreateInvites));
        expect((await invite(member.auth)).status).toBe(201);
    });
});

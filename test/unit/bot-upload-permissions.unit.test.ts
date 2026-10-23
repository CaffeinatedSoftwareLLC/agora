import { describe, expect, it, vi } from 'vitest';
import { checkChannelPermissions, uploadPermissions } from '../../src/lib/channel-access';
import { DEFAULT_EVERYONE_PERMS, Permissions } from '../../src/permissions';

const required = uploadPermissions(true);
function client(opts: { access?: boolean; member?: boolean; permissions?: bigint; deny?: bigint; allow?: bigint } = {}) {
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM bot_channel_access')) return { rows: opts.access === false ? [] : [{}] };
        if (sql.includes('FROM channels')) return { rows: [{ id: 'channel', server_id: 'server' }] };
        if (sql.includes('FROM servers')) return { rows: [{ owner_id: 'owner', everyone_role_id: 'everyone' }] };
        if (sql.includes('FROM server_members')) return { rows: opts.member ? [{}] : [] };
        if (sql.includes('FROM member_roles')) return { rows: [] };
        if (sql.includes('FROM roles')) return { rows: [{ id: 'everyone', permissions: String(opts.permissions ?? DEFAULT_EVERYONE_PERMS) }] };
        if (sql.includes('FROM channel_role_overrides')) return { rows: [{ role_id: 'everyone', deny: String(opts.deny ?? 0n), allow: '0' }] };
        if (sql.includes('FROM channel_member_overrides')) return { rows: [{ allow: String(opts.allow ?? 0n), deny: '0' }] };
        throw new Error(`Unexpected query: ${sql}`);
    });
    return { query };
}

describe('bot upload channel permissions', () => {
    it('requires explicit bot access and still rejects a human without server membership', async () => {
        const denied = client({ access: false, member: true });
        expect(await checkChannelPermissions(denied, 'channel', 'bot', required, { isBot: true })).toMatchObject({ allowed: false, status: 403 });
        expect(denied.query).toHaveBeenCalledTimes(1);
        expect(await checkChannelPermissions(client(), 'channel', 'human', required)).toMatchObject({ allowed: false, status: 403 });
    });
    it('lets an assigned bot use @everyone permissions without pretending it is a server member', async () => {
        const db = client();
        expect(await checkChannelPermissions(db, 'channel', 'bot', required, { isBot: true })).toEqual({ allowed: true });
        expect(db.query.mock.calls.some(([sql]) => sql.includes('FROM server_members'))).toBe(false);
    });
    it('enforces UploadFiles and channel overrides', async () => {
        const permission = Permissions.UploadFiles;
        expect(await checkChannelPermissions(client({ permissions: DEFAULT_EVERYONE_PERMS & ~permission }), 'channel', 'bot', required, { isBot: true })).toMatchObject({ allowed: false, status: 403 });
        expect(await checkChannelPermissions(client({ deny: permission }), 'channel', 'bot', required, { isBot: true })).toMatchObject({ allowed: false, status: 403 });
        expect(await checkChannelPermissions(client({ deny: permission, allow: permission }), 'channel', 'bot', required, { isBot: true })).toEqual({ allowed: true });
    });
    it('gates bots by channel access, not SendMessages or ViewChannel; people still need SendMessages', async () => {
        const denied = Permissions.SendMessages | Permissions.ViewChannel;
        expect(await checkChannelPermissions(client({ deny: denied }), 'channel', 'bot', required, { isBot: true })).toEqual({ allowed: true });
        expect(uploadPermissions(false)).toBe(Permissions.UploadFiles | Permissions.SendMessages);
    });
});

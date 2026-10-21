/**
 * Extra actors for the roles, directors and cross-server specs, seeded through the HTTP API
 * only (never SQL). Called from a spec's test.beforeAll, not from global-setup.
 *
 * - `director-e2e`: holds the `e2e-director` role, which carries DirectAgents only.
 * - `admin-e2e`: holds the `e2e-admin` role, which carries Administrator (not DirectAgents) and
 *   is not the server owner.
 * - `outsider-e2e`: owns a run-tagged second server (`e2e-other-<tag>`), for "another server's
 *   member" checks. Registration joins every user to the instance server, so the outsider is
 *   a member there too; the cross-server checks use the second server's files.
 *
 * The users are instance-lifetime, like owner-e2e and member-e2e: registration is limited to
 * 5 per hour per address, so they are registered once and logged in on every later run. Their
 * passwords are derived from E2E_OWNER_PASSWORD (HMAC), so nothing new is stored; they stay in
 * memory and are never printed. The two roles are made idempotent (created if missing, their
 * bitmask reset if someone changed it) so reruns never collide. No instance setting changes.
 */
import crypto from 'node:crypto';
import { Api } from './api';
import { e2eEnv } from './env';
import type { Seed } from './seed-types';

/** Bits from src/permissions.ts used by the specs (strings on the wire). */
export const Permissions = {
    Administrator: 1n << 0n,
    ManageNicknames: 1n << 9n,
    ViewChannel: 1n << 10n,
    ManageMessages: 1n << 12n,
    MentionEveryone: 1n << 16n,
    DirectAgents: 1n << 29n,
} as const;

export interface ExtraUser { id: string; username: string; password: string; token: string; api: Api }

export interface RoleSeed {
    director: ExtraUser;
    admin: ExtraUser;
    outsider: ExtraUser;
    directorRoleId: string;
    adminRoleId: string;
    /** Second server owned by outsider-e2e (owner-e2e and member-e2e are not in it). */
    other: { serverId: string; generalId: string };
}

function derivedPassword(username: string): string {
    const base = e2eEnv().raw.E2E_OWNER_PASSWORD;
    if (!base) throw new Error('.env.e2e lacks E2E_OWNER_PASSWORD');
    return 'e2e-' + crypto.createHmac('sha256', base).update(`agora-e2e-user:${username}`).digest('base64url').slice(0, 28);
}

async function login(api: Api, username: string, password: string): Promise<string | null> {
    const r = await api.req('POST', '/auth/login', { login: username, password });
    return r.status === 200 && r.data?.accessToken ? r.data.accessToken : null;
}

/** Log a fixed e2e user in, registering it first if this instance has never seen it. */
export async function ensureUser(username: string): Promise<ExtraUser> {
    const anon = new Api(e2eEnv().apiURL);
    const password = derivedPassword(username);
    let token = await login(anon, username, password);
    if (!token) {
        const r = await anon.req('POST', '/auth/register', { username, email: `${username}@example.test`, password });
        if (r.status === 429) throw new Error(`registering ${username}: rate limited (5 registrations per hour per address); rerun later`);
        if (r.status !== 201) throw new Error(`registering ${username} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
        token = await login(anon, username, password);
        if (!token) throw new Error(`${username} login failed after register`);
    }
    const api = anon.with(`Bearer ${token}`);
    const session = (await api.ok('GET', '/auth/session')) as any;
    return { id: session.user.id.trim(), username, password, token, api };
}

async function ensureRole(owner: Api, serverId: string, name: string, perms: bigint): Promise<string> {
    const roles = (await owner.ok('GET', `/servers/${serverId}/roles`)) as any[];
    const found = roles.find(r => r.name === name);
    if (!found) {
        return ((await owner.ok('POST', `/servers/${serverId}/roles`, { name, permissions: perms.toString() }, [201])) as any).id.trim();
    }
    if (found.permissions !== perms.toString()) {
        await owner.ok('PATCH', `/servers/${serverId}/roles/${found.id}`, { permissions: perms.toString() });
    }
    return found.id.trim();
}

export async function seedRoles(seed: Seed): Promise<RoleSeed> {
    const owner = new Api(e2eEnv().apiURL).with(`Bearer ${seed.secrets.ownerToken}`);
    const [director, admin, outsider] = [await ensureUser('director-e2e'), await ensureUser('admin-e2e'), await ensureUser('outsider-e2e')];

    const directorRoleId = await ensureRole(owner, seed.serverId, 'e2e-director', Permissions.DirectAgents);
    const adminRoleId = await ensureRole(owner, seed.serverId, 'e2e-admin', Permissions.Administrator);
    await owner.ok('PUT', `/servers/${seed.serverId}/members/${director.id}/roles/${directorRoleId}`);
    await owner.ok('PUT', `/servers/${seed.serverId}/members/${admin.id}/roles/${adminRoleId}`);

    const other = (await outsider.api.ok('POST', '/servers', { name: `e2e-other-${seed.runTag}` }, [201])) as any;
    const otherId = other.id.trim();
    const chans = (await outsider.api.ok('GET', `/servers/${otherId}/channels`)) as any[];
    const generalId = chans.find(c => c.name === 'general')?.id?.trim();
    if (!generalId) throw new Error('second server has no #general');

    return { director, admin, outsider, directorRoleId, adminRoleId, other: { serverId: otherId, generalId } };
}

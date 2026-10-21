import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

/**
 * OP-06.private-base-url (S0046 GET /admin/settings/ai, S0047 PATCH /admin/settings/ai).
 * Provider base URLs on private networks are refused until an instance admin allows them.
 * Provider create: POST /servers/:serverId/ai/providers (src/routes/ai-providers.ts:78).
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;

const PRIVATE_URLS = ['http://127.0.0.1:11434/v1', 'http://10.20.30.40:8000/v1'];

const providerRows = async () => (await ctx.db.query(
    'SELECT label, base_url FROM ai_providers WHERE server_id = $1 ORDER BY label', [serverId])).rows;
const settingRows = async () => (await ctx.db.query(
    "SELECT value FROM instance_settings WHERE key = 'ai.allow_private_base_urls'")).rows;
const auditRows = async () => (await ctx.db.query(
    "SELECT actor_id, target_type, changes FROM audit_log WHERE action = 'ai_settings_update' ORDER BY created_at")).rows;
const createProvider = (label: string, baseUrl: string) =>
    ctx.request.post(`/servers/${serverId}/ai/providers`).set(admin.auth).send({ adapter: 'openai', label, baseUrl });

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });

beforeEach(async () => {
    await cleanDatabase(ctx.db);
    admin = await authedUser(ctx.request, 'aiadmin');
    member = await authedUser(ctx.request, 'aimember');
    ({ serverId } = await createServer(ctx.request, admin.auth, 'Private URLs'));
    await joinViaInvite(ctx.request, admin.auth, member.auth, serverId);
    await ctx.db.query('UPDATE users SET is_instance_admin = true WHERE id = $1', [admin.userId]);
});

describe('allowPrivateBaseUrls', () => {
    it('[OP-06.private-base-url] off by default: 127.0.0.1 and 10.x base URLs give 400 and no provider row', async () => {
        const get = await ctx.request.get('/admin/settings/ai').set(admin.auth);
        expect(get.status).toBe(200);
        expect(get.body).toEqual({ allowPrivateBaseUrls: false });

        for (const [i, url] of PRIVATE_URLS.entries()) {
            const res = await createProvider(`Local ${i}`, url);
            expect(res.status, url).toBe(400);
            expect(res.body.error, url).toContain('private or local network address');
        }
        expect(await providerRows()).toEqual([]);
        expect(await auditRows()).toEqual([]);
    });

    it('[OP-06.private-base-url] an admin turns it on: 1 audit row, then the same requests give 201', async () => {
        for (const [i, url] of PRIVATE_URLS.entries()) expect((await createProvider(`Local ${i}`, url)).status).toBe(400);

        const on = await ctx.request.patch('/admin/settings/ai').set(admin.auth).send({ allowPrivateBaseUrls: true });
        expect(on.status).toBe(200);
        expect(on.body).toEqual({ allowPrivateBaseUrls: true });
        expect(await settingRows()).toEqual([{ value: true }]);
        const audit = await auditRows();
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ target_type: 'instance_settings', changes: { allowPrivateBaseUrls: true } });
        expect(audit[0].actor_id.trim()).toBe(admin.userId);
        expect((await ctx.request.get('/admin/settings/ai').set(admin.auth)).body).toEqual({ allowPrivateBaseUrls: true });

        for (const [i, url] of PRIVATE_URLS.entries()) {
            const res = await createProvider(`Local ${i}`, url);
            expect(res.status, url).toBe(201);
            expect(res.body).toMatchObject({ adapter: 'openai', label: `Local ${i}`, baseUrl: url, hasApiKey: false });
        }
        expect(await providerRows()).toEqual([
            { label: 'Local 0', base_url: PRIVATE_URLS[0] },
            { label: 'Local 1', base_url: PRIVATE_URLS[1] },
        ]);
    });

    it('[OP-06.private-base-url] turning it off again refuses new private providers', async () => {
        await ctx.request.patch('/admin/settings/ai').set(admin.auth).send({ allowPrivateBaseUrls: true });
        expect((await createProvider('Local 0', PRIVATE_URLS[0])).status).toBe(201);
        const off = await ctx.request.patch('/admin/settings/ai').set(admin.auth).send({ allowPrivateBaseUrls: false });
        expect(off.status).toBe(200);
        expect(await settingRows()).toEqual([{ value: false }]);
        expect(await auditRows()).toHaveLength(2);

        const res = await createProvider('Local 1', PRIVATE_URLS[1]);
        expect(res.status).toBe(400);
        expect((await providerRows()).map(r => r.label)).toEqual(['Local 0']);
    });

    it('[OP-06.private-base-url] a non-admin PATCH gives 403 and the setting is unchanged', async () => {
        // Neither a plain member nor a server owner who is not an instance admin
        const owner = await authedUser(ctx.request, 'aiserverowner');
        await createServer(ctx.request, owner.auth, 'Own server');
        for (const who of [member, owner]) {
            const patch = await ctx.request.patch('/admin/settings/ai').set(who.auth).send({ allowPrivateBaseUrls: true });
            expect(patch.status).toBe(403);
            expect(patch.body).toEqual({ error: 'insufficient_permissions' });
            expect((await ctx.request.get('/admin/settings/ai').set(who.auth)).status).toBe(403);
        }
        expect(await settingRows()).toEqual([]);
        expect(await auditRows()).toEqual([]);
        expect((await ctx.request.get('/admin/settings/ai').set(admin.auth)).body).toEqual({ allowPrivateBaseUrls: false });
        expect((await createProvider('Local 0', PRIVATE_URLS[0])).status).toBe(400);
        expect(await providerRows()).toEqual([]);

        // With the setting on, a non-admin still cannot turn it off
        await ctx.request.patch('/admin/settings/ai').set(admin.auth).send({ allowPrivateBaseUrls: true });
        expect((await ctx.request.patch('/admin/settings/ai').set(member.auth).send({ allowPrivateBaseUrls: false })).status).toBe(403);
        expect(await settingRows()).toEqual([{ value: true }]);
        expect(await auditRows()).toHaveLength(1);
    });

    it('[OP-06.private-base-url] the body is validated: a non-boolean gives 400 and changes nothing', async () => {
        for (const body of [{}, { allowPrivateBaseUrls: 'yes' }]) {
            const res = await ctx.request.patch('/admin/settings/ai').set(admin.auth).send(body);
            expect(res.status, JSON.stringify(body)).toBe(400);
        }
        expect(await settingRows()).toEqual([]);
        expect(await auditRows()).toEqual([]);
    });
});

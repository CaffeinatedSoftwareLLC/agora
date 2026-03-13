import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
});

afterAll(async () => {
    await ctx.close();
});

beforeEach(async () => {
    await cleanDatabase(ctx.db);
});

describe('AI Config REST API', () => {
    it('GET returns configured:false when no config exists', async () => {
        const owner = await authedUser(ctx.request, 'owner1');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer');

        const res = await ctx.request
            .get(`/servers/${serverId}/ai-config`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(res.body.configured).toBe(false);
    });

    it('PUT creates bot automatically and config row', async () => {
        const owner = await authedUser(ctx.request, 'owner2');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer');

        const res = await ctx.request
            .put(`/servers/${serverId}/ai-config`)
            .set(owner.auth)
            .send({
                provider: 'claude',
                model: 'claude-sonnet-4-20250514',
                apiKey: 'sk-test-key-12345',
            });

        expect(res.status).toBe(200);
        expect(res.body.configured).toBe(true);
        expect(res.body.provider).toBe('claude');
        expect(res.body.model).toBe('claude-sonnet-4-20250514');
        expect(res.body.botId).toBeTruthy();
        expect(res.body.enabled).toBe(true);

        // Verify bot user was created
        const botRow = await ctx.db.query(
            'SELECT id, username, bot, server_id FROM users WHERE id = $1',
            [res.body.botId]
        );
        expect(botRow.rows.length).toBe(1);
        expect(botRow.rows[0].bot).toBe(true);
        expect(botRow.rows[0].username).toBe('AI Assistant');
    });

    it('PUT is idempotent — second PUT updates, does not create new bot', async () => {
        const owner = await authedUser(ctx.request, 'owner3');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer');

        const first = await ctx.request
            .put(`/servers/${serverId}/ai-config`)
            .set(owner.auth)
            .send({ provider: 'claude', model: 'claude-sonnet-4-20250514', apiKey: 'sk-key-1' });

        const second = await ctx.request
            .put(`/servers/${serverId}/ai-config`)
            .set(owner.auth)
            .send({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-key-2' });

        expect(second.status).toBe(200);
        expect(second.body.botId).toBe(first.body.botId);
        expect(second.body.provider).toBe('openai');
        expect(second.body.model).toBe('gpt-4o');
    });

    it('GET returns config without API key', async () => {
        const owner = await authedUser(ctx.request, 'owner4');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer');

        await ctx.request
            .put(`/servers/${serverId}/ai-config`)
            .set(owner.auth)
            .send({ provider: 'claude', model: 'claude-sonnet-4-20250514', apiKey: 'sk-secret-key' });

        const res = await ctx.request
            .get(`/servers/${serverId}/ai-config`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(res.body.configured).toBe(true);
        expect(res.body.provider).toBe('claude');
        // API key should NOT be returned
        expect(res.body.apiKey).toBeUndefined();
        expect(res.body.api_key_enc).toBeUndefined();
    });

    it('PATCH toggles enabled', async () => {
        const owner = await authedUser(ctx.request, 'owner5');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer');

        await ctx.request
            .put(`/servers/${serverId}/ai-config`)
            .set(owner.auth)
            .send({ provider: 'claude', model: 'claude-sonnet-4-20250514', apiKey: 'sk-key' });

        // Disable
        const disable = await ctx.request
            .patch(`/servers/${serverId}/ai-config`)
            .set(owner.auth)
            .send({ enabled: false });

        expect(disable.status).toBe(200);
        expect(disable.body.enabled).toBe(false);

        // Re-enable
        const enable = await ctx.request
            .patch(`/servers/${serverId}/ai-config`)
            .set(owner.auth)
            .send({ enabled: true });

        expect(enable.status).toBe(200);
        expect(enable.body.enabled).toBe(true);
    });

    it('GET usage returns aggregated stats', async () => {
        const owner = await authedUser(ctx.request, 'owner6');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer');

        const res = await ctx.request
            .get(`/servers/${serverId}/ai-config/usage`)
            .set(owner.auth);

        expect(res.status).toBe(200);
        expect(res.body.total_requests).toBe(0);
        expect(res.body.total_input_tokens).toBe(0);
        expect(res.body.total_output_tokens).toBe(0);
    });

    it('returns 403 for non-admin user', async () => {
        const owner = await authedUser(ctx.request, 'owner7');
        const member = await authedUser(ctx.request, 'member7');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer');

        // Join member to server via invite
        const invite = await ctx.request
            .post(`/servers/${serverId}/invites`)
            .set(owner.auth)
            .send({});
        await ctx.request
            .post(`/invites/${invite.body.code}`)
            .set(member.auth);

        const res = await ctx.request
            .get(`/servers/${serverId}/ai-config`)
            .set(member.auth);

        expect(res.status).toBe(403);
    });

    it('dispatch idempotency — second INSERT returns 0 rows', async () => {
        const messageId = '01HTEST00000000000000MSGID';
        const botId = '01HTEST00000000000000BOTID';

        const first = await ctx.db.query(
            'INSERT INTO ai_dispatch_log (message_id, bot_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [messageId, botId]
        );
        expect(first.rowCount).toBe(1);

        const second = await ctx.db.query(
            'INSERT INTO ai_dispatch_log (message_id, bot_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [messageId, botId]
        );
        expect(second.rowCount).toBe(0);
    });

    it('auto-created bot has no channel access by default', async () => {
        const owner = await authedUser(ctx.request, 'owner9');
        const { serverId } = await createServer(ctx.request, owner.auth, 'TestServer');

        const res = await ctx.request
            .put(`/servers/${serverId}/ai-config`)
            .set(owner.auth)
            .send({ provider: 'claude', model: 'claude-sonnet-4-20250514', apiKey: 'sk-key' });

        const access = await ctx.db.query(
            'SELECT * FROM bot_channel_access WHERE bot_id = $1',
            [res.body.botId]
        );
        expect(access.rows.length).toBe(0);
    });
});

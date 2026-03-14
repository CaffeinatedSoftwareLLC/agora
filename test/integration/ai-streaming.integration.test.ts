import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { internalBus } from '../../src/ai/internal-bus';

// Mock the providers module to avoid real API calls
vi.mock('../../src/ai/providers', () => ({
    streamCompletion: vi.fn(),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
}));

import { streamCompletion } from '../../src/ai/providers';

const mockedStream = vi.mocked(streamCompletion);

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
});

afterAll(async () => {
    await ctx.close();
});

beforeEach(async () => {
    await cleanDatabase(ctx.db);
    mockedStream.mockReset();
});

/** Helper: configure AI assistant for a server and grant channel access */
async function setupAssistant(serverId: string, channelId: string, auth: object) {
    const configRes = await ctx.request
        .put(`/servers/${serverId}/ai-config`)
        .set(auth)
        .send({
            provider: 'claude',
            model: 'claude-sonnet-4-20250514',
            apiKey: 'sk-test-key-for-integration',
        });

    const botId = configRes.body.botId;

    // Grant channel access
    await ctx.request
        .post(`/channels/${channelId}/bots/${botId}`)
        .set(auth);

    return { botId };
}

/** Helper: wait for a DB condition with timeout */
async function waitFor(
    check: () => Promise<boolean>,
    timeoutMs = 5000,
    intervalMs = 100,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error('waitFor timed out');
}

describe('AI Assistant streaming handler', () => {
    it('happy path: mention triggers placeholder → final message → usage logged', async () => {
        const owner = await authedUser(ctx.request, 'aiowner1');
        const { serverId, generalChannelId } = await createServer(ctx.request, owner.auth, 'AIServer');
        const { botId } = await setupAssistant(serverId, generalChannelId, owner.auth);

        // Mock streamCompletion to call onToken + onDone synchronously
        mockedStream.mockImplementation(async (_config, _messages, callbacks) => {
            callbacks.onToken('Hello ');
            callbacks.onToken('world!');
            await callbacks.onDone({ inputTokens: 10, outputTokens: 5 });
        });

        // Send a message that mentions the bot
        const msgRes = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: `Hey <@${botId}> help me` });

        const messageId = msgRes.body.id;

        // Fire the mention event (simulating what app.ts onResponse does)
        internalBus.emit('assistantMention', {
            channelId: generalChannelId,
            messageId,
            content: `Hey <@${botId}> help me`,
            author: { id: owner.userId, username: 'aiowner1' },
            botId,
            timestamp: new Date().toISOString(),
        });

        // Wait for bot response message to appear
        await waitFor(async () => {
            const rows = await ctx.db.query(
                "SELECT content FROM messages WHERE channel_id = $1 AND author_id = $2 AND content != '...'",
                [generalChannelId, botId]
            );
            return rows.rows.length > 0;
        });

        // Verify final message content
        const botMsg = await ctx.db.query(
            "SELECT content FROM messages WHERE channel_id = $1 AND author_id = $2 AND content != '...'",
            [generalChannelId, botId]
        );
        expect(botMsg.rows[0].content).toBe('Hello world!');

        // Verify usage was logged
        const usage = await ctx.db.query(
            'SELECT * FROM ai_usage_events WHERE server_id = $1',
            [serverId]
        );
        expect(usage.rows.length).toBe(1);
        expect(usage.rows[0].input_tokens).toBe(10);
        expect(usage.rows[0].output_tokens).toBe(5);
        expect(usage.rows[0].error).toBeNull();
    });

    it('disabled config: mention is ignored', async () => {
        const owner = await authedUser(ctx.request, 'aiowner2');
        const { serverId, generalChannelId } = await createServer(ctx.request, owner.auth, 'AIServer');
        const { botId } = await setupAssistant(serverId, generalChannelId, owner.auth);

        // Disable the assistant
        await ctx.request
            .patch(`/servers/${serverId}/ai-config`)
            .set(owner.auth)
            .send({ enabled: false });

        const msgRes = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: `Hey <@${botId}>` });

        internalBus.emit('assistantMention', {
            channelId: generalChannelId,
            messageId: msgRes.body.id,
            content: `Hey <@${botId}>`,
            author: { id: owner.userId, username: 'aiowner2' },
            botId,
            timestamp: new Date().toISOString(),
        });

        // Give it time to process (should be a no-op)
        await new Promise(r => setTimeout(r, 500));

        // streamCompletion should NOT have been called
        expect(mockedStream).not.toHaveBeenCalled();
    });

    it('missing channel access: mention is ignored', async () => {
        const owner = await authedUser(ctx.request, 'aiowner3');
        const { serverId, generalChannelId } = await createServer(ctx.request, owner.auth, 'AIServer');

        // Set up AI config but DON'T grant channel access
        const configRes = await ctx.request
            .put(`/servers/${serverId}/ai-config`)
            .set(owner.auth)
            .send({
                provider: 'claude',
                model: 'claude-sonnet-4-20250514',
                apiKey: 'sk-test-key',
            });
        const botId = configRes.body.botId;

        const msgRes = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: `Hey <@${botId}>` });

        internalBus.emit('assistantMention', {
            channelId: generalChannelId,
            messageId: msgRes.body.id,
            content: `Hey <@${botId}>`,
            author: { id: owner.userId, username: 'aiowner3' },
            botId,
            timestamp: new Date().toISOString(),
        });

        await new Promise(r => setTimeout(r, 500));
        expect(mockedStream).not.toHaveBeenCalled();
    });

    it('idempotency: same messageId dispatched twice produces only one response', async () => {
        const owner = await authedUser(ctx.request, 'aiowner4');
        const { serverId, generalChannelId } = await createServer(ctx.request, owner.auth, 'AIServer');
        const { botId } = await setupAssistant(serverId, generalChannelId, owner.auth);

        mockedStream.mockImplementation(async (_config, _messages, callbacks) => {
            callbacks.onToken('Response');
            await callbacks.onDone({ inputTokens: 5, outputTokens: 3 });
        });

        const msgRes = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: `<@${botId}> hello` });

        const event = {
            channelId: generalChannelId,
            messageId: msgRes.body.id,
            content: `<@${botId}> hello`,
            author: { id: owner.userId, username: 'aiowner4' },
            botId,
            timestamp: new Date().toISOString(),
        };

        // Dispatch same event twice
        internalBus.emit('assistantMention', event);
        internalBus.emit('assistantMention', event);

        await waitFor(async () => {
            const rows = await ctx.db.query(
                "SELECT 1 FROM messages WHERE channel_id = $1 AND author_id = $2 AND content != '...'",
                [generalChannelId, botId]
            );
            return rows.rows.length > 0;
        });

        // Small delay for second dispatch to settle
        await new Promise(r => setTimeout(r, 300));

        // Should only have ONE bot response message
        const botMessages = await ctx.db.query(
            'SELECT * FROM messages WHERE channel_id = $1 AND author_id = $2',
            [generalChannelId, botId]
        );
        expect(botMessages.rows.length).toBe(1);

        // streamCompletion should have been called exactly once
        expect(mockedStream).toHaveBeenCalledTimes(1);
    });

    it('context window: correct number of recent messages passed to provider', async () => {
        const owner = await authedUser(ctx.request, 'aiowner5');
        const { serverId, generalChannelId } = await createServer(ctx.request, owner.auth, 'AIServer');
        const { botId } = await setupAssistant(serverId, generalChannelId, owner.auth);

        // Send several messages for context
        for (let i = 0; i < 5; i++) {
            await ctx.request
                .post(`/channels/${generalChannelId}/messages`)
                .set(owner.auth)
                .send({ content: `Message ${i}` });
        }

        // The trigger message
        const msgRes = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: `<@${botId}> help` });

        mockedStream.mockImplementation(async (_config, _messages, callbacks) => {
            callbacks.onToken('OK');
            await callbacks.onDone({ inputTokens: 10, outputTokens: 2 });
        });

        internalBus.emit('assistantMention', {
            channelId: generalChannelId,
            messageId: msgRes.body.id,
            content: `<@${botId}> help`,
            author: { id: owner.userId, username: 'aiowner5' },
            botId,
            timestamp: new Date().toISOString(),
        });

        await waitFor(async () => mockedStream.mock.calls.length > 0);

        // Verify messages were passed to the provider
        const [, passedMessages] = mockedStream.mock.calls[0];
        expect(passedMessages.length).toBeGreaterThan(0);
        expect(passedMessages.length).toBeLessThanOrEqual(20); // default max_context
        // All should have user role (since bot hasn't sent anything yet)
        for (const m of passedMessages) {
            expect(m.role).toBe('user');
            expect(m.content).toBeTruthy();
        }
    });

    it('provider error: error message saved to placeholder, usage logged with error', async () => {
        const owner = await authedUser(ctx.request, 'aiowner6');
        const { serverId, generalChannelId } = await createServer(ctx.request, owner.auth, 'AIServer');
        const { botId } = await setupAssistant(serverId, generalChannelId, owner.auth);

        // Mock streamCompletion to call onError
        mockedStream.mockImplementation(async (_config, _messages, callbacks) => {
            await callbacks.onError(new Error('API rate limit exceeded'));
        });

        const msgRes = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: `<@${botId}> do something` });

        internalBus.emit('assistantMention', {
            channelId: generalChannelId,
            messageId: msgRes.body.id,
            content: `<@${botId}> do something`,
            author: { id: owner.userId, username: 'aiowner6' },
            botId,
            timestamp: new Date().toISOString(),
        });

        // Wait for error message to be saved
        await waitFor(async () => {
            const rows = await ctx.db.query(
                "SELECT content FROM messages WHERE channel_id = $1 AND author_id = $2 AND content LIKE 'Error:%'",
                [generalChannelId, botId]
            );
            return rows.rows.length > 0;
        });

        const botMsg = await ctx.db.query(
            'SELECT content FROM messages WHERE channel_id = $1 AND author_id = $2',
            [generalChannelId, botId]
        );
        expect(botMsg.rows[0].content).toContain('API rate limit exceeded');

        // Verify error usage was logged
        const usage = await ctx.db.query(
            'SELECT * FROM ai_usage_events WHERE server_id = $1',
            [serverId]
        );
        expect(usage.rows.length).toBe(1);
        expect(usage.rows[0].error).toContain('API rate limit exceeded');
        expect(usage.rows[0].input_tokens).toBe(0);
        expect(usage.rows[0].output_tokens).toBe(0);
    });
});

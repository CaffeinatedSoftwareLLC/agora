import type { Pool } from 'pg';
import type { Server } from 'socket.io';
import type { FastifyBaseLogger } from 'fastify';
import { internalBus, AssistantMentionEvent } from './internal-bus';
import { streamCompletion, ConversationMessage } from './providers';
import { decryptString } from '../lib/encryption';
import { config } from '../config';
import { generateUlid } from '../utils/ulid';

/** Fallback logger when Fastify logger is not available (e.g. tests with logger: false) */
const noopLogger: FastifyBaseLogger = {
    info: () => {},
    error: (...args: any[]) => console.error('[AI Assistant]', ...args),
    warn: (...args: any[]) => console.warn('[AI Assistant]', ...args),
    debug: () => {},
    fatal: (...args: any[]) => console.error('[AI Assistant FATAL]', ...args),
    trace: () => {},
    child: () => noopLogger,
    silent: () => {},
    level: 'error',
} as any;

let log: FastifyBaseLogger = noopLogger;

export function startAssistantHandler(db: Pool, io: Server, logger?: FastifyBaseLogger): void {
    log = logger?.child({ module: 'ai-assistant' }) ?? noopLogger;

    // Guard against stacked listeners on repeated buildApp() calls (e.g. tests)
    internalBus.removeAllListeners('assistantMention');
    internalBus.on('assistantMention', (event: AssistantMentionEvent) => {
        handleMention(db, io, event).catch((err) => {
            log.error({ err, botId: event.botId, channelId: event.channelId, messageId: event.messageId },
                'Unhandled error in mention handler');
        });
    });
}

async function handleMention(db: Pool, io: Server, event: AssistantMentionEvent): Promise<void> {
    const { channelId, messageId, author, botId } = event;

    // 1. Look up bot's server_id
    const botRow = await db.query(
        'SELECT server_id FROM users WHERE id = $1 AND bot = true',
        [botId]
    );
    if (!botRow.rows[0] || !botRow.rows[0].server_id) return;
    const serverId = botRow.rows[0].server_id.trim();

    // 2. Check ai_provider_config
    const configRow = await db.query(
        'SELECT * FROM ai_provider_config WHERE server_id = $1 AND bot_id = $2 AND enabled = true',
        [serverId, botId]
    );
    if (configRow.rows.length === 0) return; // Not a built-in assistant or disabled

    // 3. Verify bot_channel_access (before idempotency so failed access doesn't consume the row)
    const accessRow = await db.query(
        'SELECT 1 FROM bot_channel_access WHERE bot_id = $1 AND channel_id = $2',
        [botId, channelId]
    );
    if (accessRow.rows.length === 0) return;

    // 4. Idempotency check
    const dispatchResult = await db.query(
        'INSERT INTO ai_dispatch_log (message_id, bot_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [messageId, botId]
    );
    if (dispatchResult.rowCount === 0) return; // Already handled

    const aiConfig = configRow.rows[0];

    // 5. Decrypt API key
    let apiKey: string;
    try {
        apiKey = decryptString(aiConfig.api_key_enc, config.encryptionKey, aiConfig.api_key_iv, aiConfig.api_key_tag);
    } catch {
        log.error({ serverId, botId, channelId, messageId }, 'Failed to decrypt API key');
        return;
    }

    // 6. Fetch context messages
    const maxContext = aiConfig.max_context || 20;
    const contextRows = await db.query(
        `SELECT m.content, m.author_id, u.username, u.bot
         FROM messages m
         JOIN users u ON u.id = m.author_id
         WHERE m.channel_id = $1 AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC
         LIMIT $2`,
        [channelId, maxContext]
    );

    // Build conversation (reverse to chronological order)
    const messages: ConversationMessage[] = [];
    for (const row of contextRows.rows.reverse()) {
        const role = row.author_id.trim() === botId.trim() ? 'assistant' : 'user';
        const prefix = role === 'user' ? `${row.username}: ` : '';
        messages.push({ role, content: `${prefix}${row.content}` });
    }

    // 7. Create placeholder message
    const botMessageId = generateUlid();
    const botUserRow = await db.query(
        'SELECT username, avatar_url FROM users WHERE id = $1',
        [botId]
    );
    const botUsername = botUserRow.rows[0]?.username || 'AI-Assistant';
    const botAvatarUrl = botUserRow.rows[0]?.avatar_url || null;

    await db.query(
        `INSERT INTO messages (id, channel_id, author_id, content, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [botMessageId, channelId, botId, '...']
    );

    // Emit placeholder to channel
    io.to(`channel:${channelId}`).emit('Message', {
        id: botMessageId.trim(),
        content: '...',
        authorId: botId.trim(),
        authorUsername: botUsername,
        authorBot: true,
        authorAvatarUrl: botAvatarUrl,
        channelId: channelId.trim(),
        createdAt: new Date().toISOString(),
    });

    // 8. Stream completion
    let accumulated = '';
    const startTime = Date.now();

    await streamCompletion(
        {
            provider: aiConfig.provider,
            model: aiConfig.model,
            apiKey,
            systemPrompt: aiConfig.system_prompt || undefined,
        },
        messages,
        {
            onToken(token: string) {
                accumulated += token;
                io.to(`channel:${channelId}`).emit('BotMessageStream', {
                    messageId: botMessageId.trim(),
                    channelId: channelId.trim(),
                    content: accumulated,
                    streaming: true,
                });
            },
            async onDone(usage: { inputTokens: number; outputTokens: number }) {
                const latencyMs = Date.now() - startTime;
                const finalContent = accumulated || '(no response)';

                // Update message in DB
                await db.query(
                    'UPDATE messages SET content = $1 WHERE id = $2',
                    [finalContent, botMessageId]
                );

                // Final stream event
                io.to(`channel:${channelId}`).emit('BotMessageStream', {
                    messageId: botMessageId.trim(),
                    channelId: channelId.trim(),
                    content: finalContent,
                    streaming: false,
                });

                // Log usage
                const usageId = generateUlid();
                await db.query(
                    `INSERT INTO ai_usage_events (id, server_id, channel_id, user_id, message_id, provider, model, input_tokens, output_tokens, latency_ms)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [usageId, serverId, channelId, author.id, botMessageId, aiConfig.provider, aiConfig.model, usage.inputTokens, usage.outputTokens, latencyMs]
                );
            },
            async onError(err: Error) {
                const latencyMs = Date.now() - startTime;
                const errorContent = `Error: ${err.message}`;

                // Never leave "..." orphaned
                await db.query(
                    'UPDATE messages SET content = $1 WHERE id = $2',
                    [errorContent, botMessageId]
                );

                io.to(`channel:${channelId}`).emit('BotMessageStream', {
                    messageId: botMessageId.trim(),
                    channelId: channelId.trim(),
                    content: errorContent,
                    streaming: false,
                });

                // Log error usage
                const usageId = generateUlid();
                await db.query(
                    `INSERT INTO ai_usage_events (id, server_id, channel_id, user_id, message_id, provider, model, input_tokens, output_tokens, latency_ms, error)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, $9)`,
                    [usageId, serverId, channelId, author.id, botMessageId, aiConfig.provider, aiConfig.model, latencyMs, err.message]
                );
            },
        }
    );
}

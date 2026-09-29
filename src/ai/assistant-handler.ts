import type { Pool } from 'pg';
import type { Server } from 'socket.io';
import type { FastifyBaseLogger } from 'fastify';
import { internalBus, AssistantMentionEvent } from './internal-bus';
import { streamCompletion, ConversationMessage } from './providers';
import { resolveRoute, checkBudget, recordUsage } from './routing';
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
    const { channelId, messageId, author, botId, threadId } = event;

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

    // 3b. Thread mentions: parent must be an open top-level message in this channel
    if (threadId) {
        const parentRow = await db.query(
            'SELECT thread_closed_at FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL',
            [threadId, channelId]
        );
        if (parentRow.rows.length === 0 || parentRow.rows[0].thread_closed_at !== null) return;
    }

    // 4. Idempotency check
    const dispatchResult = await db.query(
        'INSERT INTO ai_dispatch_log (message_id, bot_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [messageId, botId]
    );
    if (dispatchResult.rowCount === 0) return; // Already handled

    const aiConfig = configRow.rows[0];

    // 5. Resolve the server's chat route (provider, model, credentials) and check its budget
    const resolved = await resolveRoute(db, serverId, 'chat');
    if (!resolved.ok) {
        log.warn({ serverId, botId, channelId, messageId, reason: resolved.error }, 'Assistant has no usable chat route');
        return;
    }
    const chat = resolved.value;
    const budget = await checkBudget(db, chat.route);

    // 6. Fetch context messages — the thread (parent + latest replies) for thread
    // mentions, otherwise top-level channel messages only
    const maxContext = aiConfig.max_context || 20;
    let contextRows: any[];
    if (threadId) {
        const parent = await db.query(
            `SELECT m.content, m.author_id, u.username, u.bot
             FROM messages m
             JOIN users u ON u.id = m.author_id
             WHERE m.id = $1 AND m.deleted_at IS NULL`,
            [threadId]
        );
        const replies = await db.query(
            `SELECT m.content, m.author_id, u.username, u.bot
             FROM messages m
             JOIN users u ON u.id = m.author_id
             WHERE m.thread_id = $1 AND m.deleted_at IS NULL
             ORDER BY m.id DESC
             LIMIT $2`,
            [threadId, Math.max(maxContext - parent.rows.length, 1)]
        );
        contextRows = [...parent.rows, ...replies.rows.reverse()];
    } else {
        const result = await db.query(
            `SELECT m.content, m.author_id, u.username, u.bot
             FROM messages m
             JOIN users u ON u.id = m.author_id
             WHERE m.channel_id = $1 AND m.thread_id IS NULL AND m.deleted_at IS NULL
             ORDER BY m.created_at DESC
             LIMIT $2`,
            [channelId, maxContext]
        );
        contextRows = result.rows.reverse();
    }

    // Build conversation (chronological order)
    const messages: ConversationMessage[] = [];
    for (const row of contextRows) {
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
        `INSERT INTO messages (id, channel_id, author_id, content, created_at, thread_id)
         VALUES ($1, $2, $3, $4, NOW(), $5)`,
        [botMessageId, channelId, botId, '...', threadId ?? null]
    );

    // Thread reply: keep the parent's metadata in sync
    let parentUpdate: { reply_count: number; last_reply_at: string } | undefined;
    if (threadId) {
        const updated = await db.query(
            `UPDATE messages SET reply_count = reply_count + 1, last_reply_at = NOW()
             WHERE id = $1
             RETURNING reply_count, last_reply_at`,
            [threadId]
        );
        parentUpdate = updated.rows[0];
    }

    // Spread into every emitted event so clients route thread replies to the thread view
    const threadField = threadId ? { threadId: threadId.trim() } : {};

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
        ...threadField,
    });

    if (threadId && parentUpdate) {
        io.to(`channel:${channelId}`).emit('ThreadMetadataUpdate', {
            channelId: channelId.trim(),
            messageId: threadId.trim(),
            replyCount: parentUpdate.reply_count,
            lastReplyAt: parentUpdate.last_reply_at,
            threadClosedAt: null,
        });
    }

    // Over budget: replace the placeholder with a notice, don't call the provider
    if (!budget.ok) {
        const notice = `⚠️ ${budget.error}. An admin can raise it in AI settings.`;
        await db.query('UPDATE messages SET content = $1 WHERE id = $2', [notice, botMessageId]);
        io.to(`channel:${channelId}`).emit('BotMessageStream', {
            messageId: botMessageId.trim(),
            channelId: channelId.trim(),
            content: notice,
            streaming: false,
            ...threadField,
        });
        return;
    }

    // 8. Stream completion
    let accumulated = '';
    const startTime = Date.now();
    const usageBase = {
        serverId,
        capability: 'chat' as const,
        providerId: chat.providerId,
        adapter: chat.adapter.id,
        model: chat.model,
        route: chat.route,
        channelId,
        userId: author.id,
        messageId: botMessageId,
    };

    await streamCompletion(
        {
            provider: chat.adapter.id,
            model: chat.model,
            apiKey: chat.credentials.apiKey,
            baseUrl: chat.credentials.baseUrl,
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
                    ...threadField,
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
                    ...threadField,
                });

                await recordUsage(db, { ...usageBase, usage, latencyMs });
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
                    ...threadField,
                });

                await recordUsage(db, {
                    ...usageBase,
                    usage: { inputTokens: 0, outputTokens: 0 },
                    latencyMs,
                    error: err.message,
                });
            },
        }
    );
}

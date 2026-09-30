import type { Pool } from 'pg';
import type { Server } from 'socket.io';
import type { FastifyBaseLogger } from 'fastify';
import { internalBus, AssistantMentionEvent } from './internal-bus';
import { streamCompletion, ConversationMessage } from './providers';
import { resolveRoute, checkBudget, recordUsage } from './routing';
import { generateUlid } from '../utils/ulid';
import { storeFile, type StoredFile } from '../lib/file-store';
import { createAudioOverview, isAudioOverviewRequest, overviewMessage, OVERVIEW_MAX_MESSAGES, type TranscriptRow } from './audio-overview';

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

    // 4b. "@assistant make an audio overview of this thread" (WBS 5.1)
    if (isAudioOverviewRequest(event.content)) {
        await handleAudioOverview(db, io, { serverId, channelId, threadId, botId, author, content: event.content });
        return;
    }

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
    const placeholder = await createPlaceholder(db, io, { channelId, botId, threadId }, '...');
    const botMessageId = placeholder.id;
    const threadField = placeholder.threadField;

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

interface Placeholder {
    id: string;
    /** Spread into every emitted event so clients route thread replies to the thread view. */
    threadField: { threadId?: string };
    /** Emit a stream update for the placeholder (content, and files on the final update). */
    stream(content: string, streaming: boolean, attachments?: object[]): void;
}

/** Insert the bot's "..." reply (keeping thread metadata in sync) and announce it. */
async function createPlaceholder(
    db: Pool, io: Server, ctx: { channelId: string; botId: string; threadId?: string }, content: string,
): Promise<Placeholder> {
    const { channelId, botId, threadId } = ctx;
    const id = generateUlid();
    const botUserRow = await db.query('SELECT username, avatar_url FROM users WHERE id = $1', [botId]);
    const botUsername = botUserRow.rows[0]?.username || 'AI-Assistant';
    const botAvatarUrl = botUserRow.rows[0]?.avatar_url || null;
    await db.query(
        `INSERT INTO messages (id, channel_id, author_id, content, created_at, thread_id)
         VALUES ($1, $2, $3, $4, NOW(), $5)`,
        [id, channelId, botId, content, threadId ?? null]
    );

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

    const threadField = threadId ? { threadId: threadId.trim() } : {};
    const room = `channel:${channelId}`;
    io.to(room).emit('Message', {
        id: id.trim(),
        content,
        authorId: botId.trim(),
        authorUsername: botUsername,
        authorBot: true,
        authorAvatarUrl: botAvatarUrl,
        channelId: channelId.trim(),
        createdAt: new Date().toISOString(),
        ...threadField,
    });
    if (threadId && parentUpdate) {
        io.to(room).emit('ThreadMetadataUpdate', {
            channelId: channelId.trim(),
            messageId: threadId.trim(),
            replyCount: parentUpdate.reply_count,
            lastReplyAt: parentUpdate.last_reply_at,
            threadClosedAt: null,
        });
    }

    return {
        id,
        threadField,
        stream(text, streaming, attachments) {
            io.to(room).emit('BotMessageStream', {
                messageId: id.trim(),
                channelId: channelId.trim(),
                content: text,
                streaming,
                ...threadField,
                ...(attachments ? { attachments } : {}),
            });
        },
    };
}

/** The conversation an overview covers: the whole thread, or the channel's recent top-level messages. */
async function overviewRows(db: Pool, channelId: string, threadId: string | undefined, exclude: string): Promise<TranscriptRow[]> {
    if (threadId) {
        const res = await db.query(
            `SELECT username, content FROM (
                 SELECT m.id, u.username, m.content FROM messages m JOIN users u ON u.id = m.author_id
                 WHERE (m.id = $1 OR m.thread_id = $1) AND m.deleted_at IS NULL AND m.id <> $2
                 ORDER BY m.id DESC LIMIT $3
             ) t ORDER BY id`,
            [threadId, exclude, OVERVIEW_MAX_MESSAGES]
        );
        return res.rows;
    }
    const res = await db.query(
        `SELECT username, content FROM (
             SELECT m.id, u.username, m.content FROM messages m JOIN users u ON u.id = m.author_id
             WHERE m.channel_id = $1 AND m.thread_id IS NULL AND m.deleted_at IS NULL AND m.id <> $2
             ORDER BY m.id DESC LIMIT $3
         ) t ORDER BY id`,
        [channelId, exclude, OVERVIEW_MAX_MESSAGES]
    );
    return res.rows;
}

async function handleAudioOverview(
    db: Pool, io: Server,
    ctx: { serverId: string; channelId: string; threadId?: string; botId: string; author: { id: string }; content: string },
): Promise<void> {
    const { serverId, channelId, threadId, botId, author, content } = ctx;
    const placeholder = await createPlaceholder(db, io, { channelId, botId, threadId }, '🎙️ Writing an audio overview script…');
    const setContent = async (text: string, streaming: boolean, attachments?: object[]) => {
        await db.query('UPDATE messages SET content = $1 WHERE id = $2', [text, placeholder.id]);
        placeholder.stream(text, streaming, attachments);
    };

    try {
        const rows = await overviewRows(db, channelId, threadId, placeholder.id);
        const result = await createAudioOverview(db, {
            serverId, channelId, botId, requesterId: author.id, request: content, rows,
            onProgress: (status) => setContent(status, true),
        });
        if (!result.ok) {
            await setContent(`⚠️ Couldn't make an audio overview: ${result.error}`, false);
            return;
        }

        const stored = await storeFile(db, db, {
            buffer: result.mp3,
            filename: `audio-overview-${new Date().toISOString().slice(0, 10)}.mp3`,
            uploaderId: botId,
            channelId,
        });
        if (!stored.ok) {
            await setContent(`⚠️ The audio overview was recorded but couldn't be saved: ${stored.error}`, false);
            return;
        }
        await db.query('UPDATE files SET message_id = $1 WHERE id = $2', [placeholder.id, stored.file.id]);
        const file: StoredFile = stored.file;
        await setContent(overviewMessage(result.durationSec, result.script, !!threadId), false, [
            { id: file.id, name: file.name, mime: file.mime, size: file.size, width: null, height: null, url: file.url },
        ]);
    } catch (err) {
        log.error({ err, botId, channelId }, 'Audio overview failed');
        await setContent(`⚠️ Couldn't make an audio overview: ${err instanceof Error ? err.message : String(err)}`, false)
            .catch(() => { /* already logged */ });
    }
}

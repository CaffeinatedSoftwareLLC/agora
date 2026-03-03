import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgoraApi, BotInfo, Message } from './api.js';
import type { CursorTracker } from './cursor.js';

export function formatMessages(messages: Message[]): string {
    if (messages.length === 0) return 'No messages.';
    return messages.map(m => {
        const tag = m.authorBot ? ' [BOT]' : '';
        const author = m.authorUsername || 'System';
        if (m.systemEvent) return `[SYSTEM] ${m.content}`;
        if (m.deletedAt) return `[${m.createdAt}] ${author}${tag}: [deleted]`;
        return `[${m.createdAt}] ${author}${tag}: ${m.content}`;
    }).join('\n');
}

/**
 * Fetch all unread messages since the cursor, paging backwards from newest.
 * Returns messages in chronological order (oldest first).
 * Advances the cursor to the newest returned message.
 */
export async function fetchUnreadMessages(
    api: AgoraApi,
    cursors: CursorTracker,
    channelId: string,
    maxMessages: number,
    pageSize: number = 100,
): Promise<Message[]> {
    await cursors.load();
    const cursor = cursors.getCursor(channelId);

    const allUnread: Message[] = [];
    let before: string | undefined;
    let reachedCursor = false;

    while (allUnread.length < maxMessages) {
        const fetchLimit = Math.min(pageSize, maxMessages - allUnread.length);
        const page = await api.getMessages(channelId, { limit: fetchLimit, before });

        if (page.length === 0) break;

        for (const msg of page) {
            if (cursor && msg.id <= cursor) {
                reachedCursor = true;
                break;
            }
            allUnread.push(msg);
        }

        if (reachedCursor) break;
        if (page.length < fetchLimit) break;

        before = page[page.length - 1].id;
    }

    // Reverse for chronological order (collected in DESC)
    allUnread.reverse();

    // Advance cursor to latest
    if (allUnread.length > 0) {
        await cursors.ack(channelId, allUnread[allUnread.length - 1].id);
    }

    return allUnread;
}

export function registerTools(
    server: McpServer,
    api: AgoraApi,
    cursors: CursorTracker,
    config: { defaultChannel?: string },
) {
    let botInfo: BotInfo | null = null;

    async function resolveChannel(channel?: string): Promise<{ id: string; name: string }> {
        if (!botInfo) botInfo = await api.getMe();

        const target = channel || config.defaultChannel;
        if (!target) {
            throw new Error(
                'No channel specified and no default channel configured. '
                + `Available: ${botInfo.channels.map(c => c.name).join(', ')}`,
            );
        }

        const byId = botInfo.channels.find(c => c.id === target);
        if (byId) return { id: byId.id, name: byId.name };

        const byName = botInfo.channels.find(c => c.name === target);
        if (byName) return { id: byName.id, name: byName.name };

        // Refresh channel list in case it changed
        botInfo = await api.getMe();
        const refreshed = botInfo.channels.find(c => c.name === target || c.id === target);
        if (refreshed) return { id: refreshed.id, name: refreshed.name };

        throw new Error(
            `Channel "${target}" not found. Available: ${botInfo.channels.map(c => c.name).join(', ')}`,
        );
    }

    server.tool(
        'chat_send',
        'Send a message to an Agora channel',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            message: z.string().describe('Message content to send'),
        },
        async ({ channel, message }) => {
            const ch = await resolveChannel(channel);
            const idempotencyKey = randomUUID();
            const msg = await api.sendMessage(ch.id, message, idempotencyKey);

            return {
                content: [{
                    type: 'text' as const,
                    text: `Message sent to #${ch.name} (id: ${msg.id})`,
                }],
            };
        },
    );

    server.tool(
        'chat_read',
        'Read new messages from an Agora channel. Cursor-aware: returns only unread messages on subsequent calls.',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            limit: z.number().optional().describe('Max messages to return (default: 200)'),
        },
        async ({ channel, limit }) => {
            const ch = await resolveChannel(channel);
            const allUnread = await fetchUnreadMessages(api, cursors, ch.id, limit || 200);

            return {
                content: [{
                    type: 'text' as const,
                    text: allUnread.length > 0
                        ? `#${ch.name} — ${allUnread.length} new message(s):\n\n${formatMessages(allUnread)}`
                        : `#${ch.name} — no new messages`,
                }],
            };
        },
    );

    server.tool(
        'channel_list',
        'List all channels the bot has access to',
        {},
        async () => {
            const info = await api.getMe();
            botInfo = info;

            const lines = info.channels.map(c =>
                `#${c.name} (${c.channelType}, id: ${c.id})`,
            );

            return {
                content: [{
                    type: 'text' as const,
                    text: lines.length > 0
                        ? `Channels:\n${lines.join('\n')}`
                        : 'No channels assigned. Ask an admin to grant channel access.',
                }],
            };
        },
    );

    server.tool(
        'chat_history',
        'Fetch message history from an Agora channel. Does not update the read cursor.',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            before: z.string().optional().describe('Fetch messages before this message ID (for pagination)'),
            limit: z.number().optional().describe('Max messages to fetch (default: 50, max: 100)'),
        },
        async ({ channel, before, limit }) => {
            const ch = await resolveChannel(channel);
            const messages = await api.getMessages(ch.id, {
                limit: limit || 50,
                before,
            });

            // Reverse for chronological
            const chronological = messages.reverse();

            return {
                content: [{
                    type: 'text' as const,
                    text: chronological.length > 0
                        ? `#${ch.name} — ${chronological.length} message(s):\n\n${formatMessages(chronological)}`
                        : `#${ch.name} — no messages`,
                }],
            };
        },
    );
}

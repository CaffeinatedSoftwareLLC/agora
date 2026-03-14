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

export interface ReadResult {
    messages: Message[];
    /** Number of older unread messages skipped (backlog exceeded scan cap). */
    skipped: number;
}

/**
 * Fetch unread messages since the cursor, returning oldest-first.
 *
 * **No cursor (first read):** Returns the newest `maxMessages` for quick
 * context. Sets cursor to the newest returned message.
 *
 * **With cursor, backlog fits in scan window:** Scans backward to the
 * cursor boundary, returns oldest `maxMessages`. Cursor advances to the
 * last returned message; remaining newer messages stay for the next call.
 *
 * **With cursor, backlog exceeds scan window:** Scans the newest maxScan
 * messages. Returns the oldest `maxMessages` from the scanned window.
 * Cursor advances to the last returned message, skipping the gap between
 * the old cursor and the scan window. `skipped` reports the approximate
 * count so the caller can warn. This ensures forward progress — without
 * it, subsequent calls would return the same batch forever.
 */
export async function fetchUnreadMessages(
    api: AgoraApi,
    cursors: CursorTracker,
    channelId: string,
    maxMessages: number,
    pageSize: number = 100,
    maxScan: number = 2000,
): Promise<ReadResult> {
    await cursors.load();
    const cursor = cursors.getCursor(channelId);

    if (!cursor) {
        // First read: fetch newest maxMessages for immediate context.
        // Page backward until we have enough or run out.
        const collected: Message[] = [];
        let before: string | undefined;

        while (collected.length < maxMessages) {
            const fetchLimit = Math.min(pageSize, maxMessages - collected.length);
            const page = await api.getMessages(channelId, { limit: fetchLimit, before });
            if (page.length === 0) break;
            collected.push(...page);
            if (page.length < fetchLimit) break;
            before = page[page.length - 1].id;
        }

        // Reverse to chronological, take last maxMessages (newest)
        collected.reverse();
        const result = collected.slice(-maxMessages);

        if (result.length > 0) {
            await cursors.ack(channelId, result[result.length - 1].id);
        }
        return { messages: result, skipped: 0 };
    }

    // With cursor: scan backward from newest toward the cursor boundary.
    const collected: Message[] = []; // newest-first as collected
    let before: string | undefined;
    let reachedCursor = false;

    while (collected.length < maxScan) {
        const fetchLimit = Math.min(pageSize, maxScan - collected.length);
        const page = await api.getMessages(channelId, { limit: fetchLimit, before });

        if (page.length === 0) {
            reachedCursor = true;
            break;
        }

        let hitCursor = false;
        for (const msg of page) {
            if (msg.id <= cursor) {
                hitCursor = true;
                break;
            }
            collected.push(msg);
        }

        if (hitCursor) {
            reachedCursor = true;
            break;
        }

        if (page.length < fetchLimit) {
            reachedCursor = true;
            break;
        }

        before = page[page.length - 1].id;
    }

    // Reverse to chronological (oldest first)
    collected.reverse();

    // Take oldest maxMessages to preserve continuity.
    const result = collected.slice(0, maxMessages);

    // Calculate skipped messages when scan was incomplete.
    // The gap is between the old cursor and the oldest scanned message.
    // We can't know the exact count, but collected.length == maxScan
    // when incomplete, so report the minimum known skip.
    let skipped = 0;
    if (!reachedCursor && collected.length > 0) {
        // Scan didn't reach cursor — there are unseen messages in the gap.
        // We still advance cursor to make forward progress; without this,
        // every subsequent call returns the same batch forever.
        skipped = -1; // exact count unknown; set to sentinel
    }

    if (result.length > 0) {
        await cursors.ack(channelId, result[result.length - 1].id);
    }

    return { messages: result, skipped };
}

export function registerTools(
    server: McpServer,
    api: AgoraApi,
    cursors: CursorTracker,
    config: { defaultChannel?: string },
) {
    let botInfo: BotInfo | null = null;

    async function getBotId(): Promise<string> {
        if (!botInfo) botInfo = await api.getMe();
        return botInfo.id;
    }

    function filterSelf(messages: Message[], selfId: string): Message[] {
        return messages.filter(m => m.authorId !== selfId);
    }

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
            const selfId = await getBotId();
            const { messages: raw, skipped } = await fetchUnreadMessages(api, cursors, ch.id, limit || 200);
            const messages = filterSelf(raw, selfId);

            let text: string;
            if (messages.length === 0) {
                text = `#${ch.name} — no new messages`;
            } else {
                text = `#${ch.name} — ${messages.length} new message(s):\n\n${formatMessages(messages)}`;
                if (skipped !== 0) {
                    text += '\n\n[Note: Large backlog detected. Some older unread messages were skipped to make progress.]';
                }
            }

            return {
                content: [{ type: 'text' as const, text }],
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
        'chat_wait',
        'Wait for new messages in an Agora channel. Blocks until at least one new message arrives or the timeout expires. Use this to "listen" for incoming messages.',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            timeout: z.number().optional().describe('Max seconds to wait (default: 30, max: 120)'),
        },
        async ({ channel, timeout }) => {
            const ch = await resolveChannel(channel);
            const selfId = await getBotId();
            const maxWait = Math.min(timeout || 30, 120) * 1000;
            const pollInterval = 2000;
            const deadline = Date.now() + maxWait;

            while (Date.now() < deadline) {
                const { messages: raw } = await fetchUnreadMessages(api, cursors, ch.id, 200);
                const messages = filterSelf(raw, selfId);
                if (messages.length > 0) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: `#${ch.name} — ${messages.length} new message(s):\n\n${formatMessages(messages)}`,
                        }],
                    };
                }
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                await new Promise(r => setTimeout(r, Math.min(pollInterval, remaining)));
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: `#${ch.name} — no new messages after ${Math.round(maxWait / 1000)}s`,
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

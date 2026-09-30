import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgoraApi, BotInfo, Message, RuntimeRun, ThreadSummary } from './api.js';
import type { CursorTracker } from './cursor.js';

export function formatMessages(messages: Message[]): string {
    if (messages.length === 0) return 'No messages.';
    return messages.map(m => {
        const tag = m.authorBot ? ' [BOT]' : '';
        const author = m.authorUsername || 'System';
        if (m.systemEvent) return `[SYSTEM] ${m.content}`;
        if (m.deletedAt) return `[${m.createdAt}] (${m.id}) ${author}${tag}: [deleted]`;
        let thread = '';
        if (m.replyCount && m.replyCount > 0) {
            thread = m.threadClosedAt
                ? ` [thread closed: ${m.replyCount} replies]`
                : ` [thread: ${m.replyCount} replies]`;
        }
        return `[${m.createdAt}] (${m.id}) ${author}${tag}: ${m.content}${thread}`;
    }).join('\n');
}

export function formatThreads(threads: ThreadSummary[]): string {
    if (threads.length === 0) return 'No open threads.';
    return threads.map(t => {
        const tag = t.authorBot ? ' [BOT]' : '';
        const author = t.authorUsername || 'System';
        const preview = (t.content || '').replace(/\s+/g, ' ').slice(0, 120);
        return `(${t.id}) ${author}${tag}: ${preview} — ${t.replyCount} replies, last ${t.lastReplyAt}`;
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

/**
 * Fetch unread replies in a thread, returning oldest-first.
 *
 * Replies are paged oldest-first via `after`, so unlike channels there is no
 * backward scan: with a cursor, return the next `maxMessages` replies after it.
 *
 * **No cursor (first read):** Pages forward up to `maxScan`. If the whole
 * thread fits, returns the newest `maxMessages` for context; otherwise returns
 * the oldest `maxMessages` and later calls continue from there.
 */
export async function fetchUnreadReplies(
    api: AgoraApi,
    cursors: CursorTracker,
    channelId: string,
    threadId: string,
    maxMessages: number,
    pageSize: number = 100,
    maxScan: number = 2000,
): Promise<Message[]> {
    await cursors.loadThreads();
    const cursor = cursors.getThreadCursor(threadId);
    const limit = cursor ? maxMessages : maxScan;

    const collected: Message[] = [];
    let after = cursor;
    let reachedEnd = false;

    while (collected.length < limit) {
        const fetchLimit = Math.min(pageSize, limit - collected.length);
        const page = await api.getReplies(channelId, threadId, { limit: fetchLimit, after });
        collected.push(...page);
        if (page.length < fetchLimit) {
            reachedEnd = true;
            break;
        }
        after = page[page.length - 1].id;
    }

    const result = !cursor && reachedEnd
        ? collected.slice(-maxMessages)
        : collected.slice(0, maxMessages);

    if (result.length > 0) {
        await cursors.ackThread(threadId, result[result.length - 1].id);
    }
    return result;
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

    const threadParam = z.string().optional().describe(
        'Thread parent message ID. When set, operates on that thread\'s replies instead of the channel.',
    );

    /** Header label for tool output, e.g. "#general" or "#general › thread 01H...". */
    function label(channelName: string, thread?: string): string {
        return thread ? `#${channelName} › thread ${thread}` : `#${channelName}`;
    }

    /** Read unread messages from a channel (top-level) or a thread, excluding the bot's own. */
    async function readUnread(
        channelId: string,
        thread: string | undefined,
        limit: number,
    ): Promise<{ messages: Message[]; skipped: number }> {
        const selfId = await getBotId();
        if (thread) {
            const raw = await fetchUnreadReplies(api, cursors, channelId, thread, limit);
            return { messages: filterSelf(raw, selfId), skipped: 0 };
        }
        const { messages: raw, skipped } = await fetchUnreadMessages(api, cursors, channelId, limit);
        return { messages: filterSelf(raw, selfId), skipped };
    }

    server.tool(
        'chat_send',
        'Send a message to an Agora channel, or reply in a thread when `thread` is set.',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            message: z.string().describe('Message content to send'),
            thread: threadParam,
        },
        async ({ channel, message, thread }) => {
            const ch = await resolveChannel(channel);
            const idempotencyKey = randomUUID();
            const msg = thread
                ? await api.sendReply(ch.id, thread, message, idempotencyKey)
                : await api.sendMessage(ch.id, message, idempotencyKey);

            return {
                content: [{
                    type: 'text' as const,
                    text: `Message sent to ${label(ch.name, thread)} (id: ${msg.id})`,
                }],
            };
        },
    );

    server.tool(
        'chat_read',
        'Read new messages from an Agora channel, or from a thread when `thread` is set. Cursor-aware: returns only unread messages on subsequent calls. Channel reads return top-level messages only; messages with replies are marked [thread: N replies].',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            limit: z.number().optional().describe('Max messages to return (default: 200)'),
            thread: threadParam,
        },
        async ({ channel, limit, thread }) => {
            const ch = await resolveChannel(channel);
            const { messages, skipped } = await readUnread(ch.id, thread, limit || 200);

            let text: string;
            if (messages.length === 0) {
                text = `${label(ch.name, thread)} — no new messages`;
            } else {
                text = `${label(ch.name, thread)} — ${messages.length} new message(s):\n\n${formatMessages(messages)}`;
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

            const pausedNote = info.paused
                ? `[PAUSED by an admin${info.pausedReason ? `: ${info.pausedReason}` : ''} — read-only until resumed]\n\n`
                : '';

            return {
                content: [{
                    type: 'text' as const,
                    text: pausedNote + (lines.length > 0
                        ? `Channels:\n${lines.join('\n')}`
                        : 'No channels assigned. Ask an admin to grant channel access.'),
                }],
            };
        },
    );

    server.tool(
        'chat_wait',
        'Wait for new messages in an Agora channel, or in a thread when `thread` is set. Blocks until at least one new message arrives or the timeout expires. Use this to "listen" for incoming messages.',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            timeout: z.number().optional().describe('Max seconds to wait (default: 30, max: 120)'),
            thread: threadParam,
        },
        async ({ channel, timeout, thread }) => {
            const ch = await resolveChannel(channel);
            const maxWait = Math.min(timeout || 30, 120) * 1000;
            const pollInterval = 2000;
            const deadline = Date.now() + maxWait;

            while (Date.now() < deadline) {
                const { messages } = await readUnread(ch.id, thread, 200);
                if (messages.length > 0) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: `${label(ch.name, thread)} — ${messages.length} new message(s):\n\n${formatMessages(messages)}`,
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
                    text: `${label(ch.name, thread)} — no new messages after ${Math.round(maxWait / 1000)}s`,
                }],
            };
        },
    );

    server.tool(
        'chat_history',
        'Fetch message history from an Agora channel, or a thread\'s replies when `thread` is set. Does not update the read cursor.',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            before: z.string().optional().describe('Channel only: fetch messages before this message ID (for pagination)'),
            after: z.string().optional().describe('Thread only: fetch replies after this message ID (for pagination)'),
            limit: z.number().optional().describe('Max messages to fetch (default: 50, max: 100)'),
            thread: threadParam,
        },
        async ({ channel, before, after, limit, thread }) => {
            const ch = await resolveChannel(channel);
            // Replies come back oldest-first; channel messages newest-first
            const chronological = thread
                ? await api.getReplies(ch.id, thread, { limit: limit || 50, after })
                : (await api.getMessages(ch.id, { limit: limit || 50, before })).reverse();

            return {
                content: [{
                    type: 'text' as const,
                    text: chronological.length > 0
                        ? `${label(ch.name, thread)} — ${chronological.length} message(s):\n\n${formatMessages(chronological)}`
                        : `${label(ch.name, thread)} — no messages`,
                }],
            };
        },
    );

    server.tool(
        'thread_start',
        'Start a thread by posting its parent message to a channel. Returns the thread ID to pass as `thread` to chat_send / chat_read / chat_wait / chat_history. The thread appears in thread_list once it has a reply.',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            message: z.string().describe('Parent message content (the thread\'s topic or opening message)'),
        },
        async ({ channel, message }) => {
            const ch = await resolveChannel(channel);
            const msg = await api.sendMessage(ch.id, message, randomUUID());

            return {
                content: [{
                    type: 'text' as const,
                    text: `Thread started in #${ch.name} (thread: ${msg.id}). Reply with chat_send thread="${msg.id}".`,
                }],
            };
        },
    );

    server.tool(
        'thread_list',
        'List open threads in a channel, most recently active first.',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            limit: z.number().optional().describe('Max threads to return (default: 10, max: 10)'),
        },
        async ({ channel, limit }) => {
            const ch = await resolveChannel(channel);
            const threads = await api.listThreads(ch.id, { limit: limit || 10 });

            return {
                content: [{
                    type: 'text' as const,
                    text: `#${ch.name} — ${threads.length} open thread(s):\n\n${formatThreads(threads)}`,
                }],
            };
        },
    );

    server.tool(
        'thread_close',
        'Close a thread (no further replies), or reopen it with reopen=true. Requires being the thread starter or having Manage Messages.',
        {
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            thread: z.string().describe('Thread parent message ID'),
            reopen: z.boolean().optional().describe('Reopen a closed thread instead of closing it'),
        },
        async ({ channel, thread, reopen }) => {
            const ch = await resolveChannel(channel);
            await api.setThreadClosed(ch.id, thread, !reopen);

            return {
                content: [{
                    type: 'text' as const,
                    text: `${label(ch.name, thread)} ${reopen ? 'reopened' : 'closed'}`,
                }],
            };
        },
    );

    // ─── Sandboxed runtime ───

    const TERMINAL = new Set(['succeeded', 'failed', 'timeout', 'killed', 'error', 'denied']);

    server.tool(
        'runtime_exec',
        'Run TypeScript/JavaScript in Agora\'s sandbox (Deno). The code can call Agora capabilities via `import { chat, search, postFile, postMessage } from "agora:std"` (or the global `agora`), but has no other network or filesystem access. Declare every capability it uses. Depending on this bot\'s access, a human may need to approve the run in the thread first; this tool waits for that. Results (and any files it posts) land in the thread.',
        {
            code: z.string().describe('Deno TypeScript/JavaScript to run. Use console.log for output; top-level await is supported.'),
            capabilities: z.array(z.enum(['chat', 'search', 'image', 'tts', 'video', 'decide'])).optional()
                .describe('Capabilities the code calls through agora:std (undeclared calls are rejected)'),
            channel: z.string().optional().describe('Channel name or ID (uses default if omitted)'),
            thread: z.string().optional().describe('Thread parent message ID; approval requests and results are posted there'),
            wait: z.boolean().optional().describe('Wait for the run to finish (default true)'),
            timeout: z.number().optional().describe('Max seconds to wait, including human approval (default 300, max 900)'),
        },
        async ({ code, capabilities, channel, thread, wait, timeout }) => {
            const ch = await resolveChannel(channel);
            let run = await api.submitRun({ code, channelId: ch.id, ...(thread ? { threadId: thread } : {}), capabilities: capabilities ?? [] });

            const deadline = Date.now() + Math.min(timeout ?? 300, 900) * 1000;
            if (wait !== false) {
                while (!TERMINAL.has(run.status) && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, run.status === 'awaiting_approval' ? 3000 : 1000));
                    run = await api.getRun(run.id);
                }
            }
            return { content: [{ type: 'text' as const, text: formatRun(run) }] };
        },
    );

    server.tool(
        'runtime_status',
        'Check a sandbox run started with runtime_exec (status, output, errors).',
        { runId: z.string().describe('Run ID returned by runtime_exec') },
        async ({ runId }) => ({ content: [{ type: 'text' as const, text: formatRun(await api.getRun(runId)) }] }),
    );
}

export function formatRun(run: RuntimeRun): string {
    const lines = [`Run ${run.id}: ${run.status}`];
    if (run.status === 'denied') lines.push(`Denied: ${run.gate?.reason ?? 'no reason given'}`);
    if (run.status === 'awaiting_approval') lines.push('Waiting for a human to approve it in the thread. Check again with runtime_status.');
    if (run.status === 'queued' || run.status === 'running') lines.push('Still in progress. Check again with runtime_status.');
    if (run.error) lines.push(`Error: ${run.error}`);
    if (run.exitCode !== undefined && run.exitCode !== null) lines.push(`Exit code: ${run.exitCode}`);
    if (run.capabilityCalls !== undefined) lines.push(`Capability calls: ${run.capabilityCalls} · files posted: ${run.artifacts ?? 0}`);
    if (run.stdout) lines.push('', 'stdout:', run.stdout);
    if (run.stderr) lines.push('', 'stderr:', run.stderr);
    return lines.join('\n');
}

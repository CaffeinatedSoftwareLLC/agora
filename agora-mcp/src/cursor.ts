import type { AgoraApi } from './api.js';

export class CursorTracker {
    private cursors = new Map<string, string>();
    private loaded = false;
    private threadCursors = new Map<string, string>();
    private threadsLoaded = false;

    constructor(private api: AgoraApi) {}

    async load(): Promise<void> {
        if (this.loaded) return;
        const cursors = await this.api.getCursors();
        for (const c of cursors) {
            this.cursors.set(c.channelId, c.lastReadId);
        }
        this.loaded = true;
    }

    getCursor(channelId: string): string | undefined {
        return this.cursors.get(channelId);
    }

    async ack(channelId: string, messageId: string): Promise<void> {
        const current = this.cursors.get(channelId);
        if (current && current >= messageId) return;

        await this.api.updateCursor(channelId, messageId);
        this.cursors.set(channelId, messageId);
    }

    async loadThreads(): Promise<void> {
        if (this.threadsLoaded) return;
        const cursors = await this.api.getThreadCursors();
        for (const c of cursors) {
            this.threadCursors.set(c.threadId, c.lastReadId);
        }
        this.threadsLoaded = true;
    }

    getThreadCursor(threadId: string): string | undefined {
        return this.threadCursors.get(threadId);
    }

    async ackThread(threadId: string, messageId: string): Promise<void> {
        const current = this.threadCursors.get(threadId);
        if (current && current >= messageId) return;

        await this.api.updateThreadCursor(threadId, messageId);
        this.threadCursors.set(threadId, messageId);
    }
}

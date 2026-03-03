import type { AgoraApi } from './api.js';

export class CursorTracker {
    private cursors = new Map<string, string>();
    private loaded = false;

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
}

import { EventEmitter } from 'events';

export interface AssistantMentionEvent {
    channelId: string;
    messageId: string;
    /** Thread parent ID when the mention was a thread reply. */
    threadId?: string;
    content: string;
    author: { id: string; username: string };
    botId: string;
    timestamp: string;
}

export const internalBus = new EventEmitter();

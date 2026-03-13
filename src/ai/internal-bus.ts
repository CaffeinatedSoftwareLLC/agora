import { EventEmitter } from 'events';

export interface AssistantMentionEvent {
    channelId: string;
    messageId: string;
    content: string;
    author: { id: string; username: string };
    botId: string;
    timestamp: string;
}

export const internalBus = new EventEmitter();

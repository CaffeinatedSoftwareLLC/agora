import Redis from 'ioredis';
import type { Server } from 'socket.io';

/**
 * Cross-process Socket.IO events. Services without a Socket.IO server (cap-gateway)
 * publish here; the API process re-emits to clients. Only allowlisted rooms and
 * event names are forwarded, so a compromised publisher can't push arbitrary
 * events (e.g. auth or permission updates) to clients.
 */

export const EVENT_CHANNEL = 'agora:events';

export interface BridgedEvent {
    room: string;
    event: string;
    data: unknown;
}

const ALLOWED_EVENTS = new Set(['Message', 'ThreadMetadataUpdate', 'MessageUpdate']);
const ALLOWED_ROOM = /^channel:[0-9A-Z]{26}$/;

export function isForwardable(evt: Partial<BridgedEvent>): evt is BridgedEvent {
    return typeof evt.room === 'string' && ALLOWED_ROOM.test(evt.room)
        && typeof evt.event === 'string' && ALLOWED_EVENTS.has(evt.event);
}

export async function publishEvents(redis: Redis, events: BridgedEvent[]): Promise<void> {
    for (const evt of events) {
        await redis.publish(EVENT_CHANNEL, JSON.stringify(evt));
    }
}

/** Subscribe in the API process and forward allowlisted events to Socket.IO rooms. Returns a closer. */
export function startEventBridge(io: Server, redisUrl: string, log?: { warn: (...a: unknown[]) => void }): () => Promise<void> {
    const sub = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
    sub.subscribe(EVENT_CHANNEL).catch(err => log?.warn({ err }, 'Event bridge subscribe failed'));
    sub.on('message', (_channel, raw) => {
        let evt: Partial<BridgedEvent>;
        try { evt = JSON.parse(raw); } catch { return; }
        if (!isForwardable(evt)) {
            log?.warn({ room: evt.room, event: evt.event }, 'Dropped non-allowlisted bridged event');
            return;
        }
        io.to(evt.room).emit(evt.event, evt.data);
    });
    sub.on('error', err => log?.warn({ err }, 'Event bridge Redis error'));
    return async () => { await sub.quit().catch(() => sub.disconnect()); };
}

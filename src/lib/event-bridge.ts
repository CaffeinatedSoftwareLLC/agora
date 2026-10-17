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
export function startEventBridge(io: Server, redisUrl: string, log?: { warn: (...a: unknown[]) => void }, refreshAccess?: () => Promise<void>): () => Promise<void> {
    const sub = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
    // Preserve event order: a tripwire access change precedes its channel notice.
    let delivery = Promise.resolve();
    sub.subscribe(EVENT_CHANNEL).catch(err => log?.warn({ err }, 'Event bridge subscribe failed'));
    sub.on('message', (_channel, raw) => {
        let evt: Partial<BridgedEvent>;
        try { evt = JSON.parse(raw); } catch { return; }
        if (!evt || typeof evt !== 'object') return;
        if (evt?.event === '_GatewayAccessChanged' && typeof evt.room === 'string' && /^user:[0-9A-Z]{26}$/.test(evt.room)) {
            // This is only an invalidation hint, never authority supplied by Redis.
            // Re-read committed DB permissions; never forward this event to clients.
            delivery = delivery.then(() => refreshAccess?.()).catch(err => log?.warn({ err }, 'Gateway access refresh failed'));
            return;
        }
        if (!isForwardable(evt)) {
            log?.warn({ room: evt.room, event: evt.event }, 'Dropped non-allowlisted bridged event');
            return;
        }
        const event = evt;
        delivery = delivery.then(() => { io.to(event.room).emit(event.event, event.data); });
    });
    sub.on('error', err => log?.warn({ err }, 'Event bridge Redis error'));
    return async () => { await sub.quit().catch(() => sub.disconnect()); await delivery; };
}

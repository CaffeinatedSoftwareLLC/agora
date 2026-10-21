import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { io as connectClient, type Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { startEventBridge, EVENT_CHANNEL } from '../../src/lib/event-bridge';
import { config } from '../../src/config';
import { Permissions } from '../../src/permissions';
import { generateUlid } from '../../src/utils/ulid';

/**
 * SEC-01.bridge-allowlist (S0472): the Redis `agora:events` bridge (src/lib/event-bridge.ts:34).
 *
 * Redis is shared with other test runs, and the channel name is fixed, so every room here
 * carries a fresh ULID and warnings are counted only for this test's rooms. Each check ends
 * with an allowlisted sentinel on the same subscription: the bridge handles messages in
 * order, so once the sentinel arrives every earlier message has been dropped or delivered.
 */

let publisher: Redis;
beforeAll(() => { publisher = new Redis(config.redisUrl, { maxRetriesPerRequest: null }); });
afterAll(() => { publisher.disconnect(); });

const publish = (room: string, event: string, data: unknown = {}) =>
    publisher.publish(EVENT_CHANNEL, JSON.stringify({ room, event, data }));

function waitForEvent(socket: Socket, name: string, ms = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), ms);
        socket.once(name, value => { clearTimeout(timer); resolve(value); });
    });
}

/** Everything a client receives, by event name. */
function record(socket: Socket) {
    const got: { event: string; data: any }[] = [];
    socket.onAny((event, data) => got.push({ event, data }));
    return got;
}

describe('event bridge, driven directly with a real Socket.IO server and real Redis', () => {
    let httpServer: http.Server;
    let ioServer: Server;
    let stop: () => Promise<void>;
    let port: number;
    const warn = vi.fn();
    const refreshAccess = vi.fn(async () => {});
    const clients: Socket[] = [];

    // Rooms this run owns; the test socket joins all three
    const channelId = generateUlid();
    const userId = generateUlid();
    const channelRoom = `channel:${channelId}`;
    const userRoom = `user:${userId}`;
    const serverRoom = `server:${generateUlid()}`;

    const warningsFor = (room: string, event: string) =>
        warn.mock.calls.filter(([fields]) => fields?.room === room && fields?.event === event);

    beforeAll(async () => {
        httpServer = http.createServer();
        ioServer = new Server(httpServer, { transports: ['websocket'] });
        ioServer.on('connection', socket => {
            for (const room of socket.handshake.auth.rooms ?? []) socket.join(room);
            socket.emit('Joined');
        });
        await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
        port = (httpServer.address() as AddressInfo).port;
        stop = startEventBridge(ioServer, config.redisUrl, { warn }, refreshAccess);
        // The subscriber is up once a sentinel makes it through
        const probe = await join([channelRoom]);
        for (let i = 0; ; i++) {
            const arrived = waitForEvent(probe, 'Message', 300).then(() => true, () => false);
            await publish(channelRoom, 'Message', { probe: i });
            if (await arrived) break;
            if (i > 30) throw new Error('event bridge never subscribed');
        }
        probe.disconnect();
    });
    afterAll(async () => {
        await stop();
        ioServer.close();
        await new Promise(resolve => httpServer.close(resolve));
    });
    beforeEach(() => { warn.mockClear(); refreshAccess.mockClear(); });
    afterEach(() => { for (const c of clients.splice(0)) c.disconnect(); });

    async function join(rooms: string[]): Promise<Socket> {
        const socket = connectClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], auth: { rooms }, reconnection: false });
        clients.push(socket);
        await waitForEvent(socket, 'Joined');
        return socket;
    }

    async function sentinel(socket: Socket, got: { event: string }[]) {
        const marker = generateUlid();
        const arrived = waitForEvent(socket, 'Message');
        await publish(channelRoom, 'Message', { sentinel: marker });
        expect(await arrived).toEqual({ sentinel: marker });
        // Drop the sentinel from the record
        const i = got.findIndex(g => (g as any).data?.sentinel === marker);
        got.splice(i, 1);
    }

    it('[SEC-01.bridge-allowlist] a non-allowlisted event or room gives 0 deliveries and 1 warning each', async () => {
        const socket = await join([channelRoom, userRoom, serverRoom]);
        const got = record(socket);
        const refused: [string, string][] = [
            [channelRoom, 'PermissionsUpdate'],        // event not allowlisted, room is
            [channelRoom, 'Ready'],
            [userRoom, 'Message'],                     // room not allowlisted, event is
            [serverRoom, 'Message'],
            [`channel:${channelId.toLowerCase()}`, 'Message'], // not a ULID room
            [channelRoom, '_GatewayAccessChanged'],    // the hint only counts on a user room
        ];
        for (const [room, event] of refused) await publish(room, event, { secret: true });
        await sentinel(socket, got);

        expect(got).toEqual([]);
        for (const [room, event] of refused) expect(warningsFor(room, event), `${room} ${event}`).toHaveLength(1);
        expect(warningsFor(channelRoom, 'PermissionsUpdate')[0][1]).toBe('Dropped non-allowlisted bridged event');
        expect(refreshAccess).not.toHaveBeenCalled();
    });

    it('[SEC-01.bridge-allowlist] an allowlisted Message to channel:<id> gives exactly 1 delivery and no warning', async () => {
        const inRoom = await join([channelRoom]);
        const elsewhere = await join([`channel:${generateUlid()}`, userRoom]);
        const gotIn = record(inRoom);
        const gotElsewhere = record(elsewhere);

        const delivered = waitForEvent(inRoom, 'Message');
        await publish(channelRoom, 'Message', { id: 'm1', content: 'hello' });
        expect(await delivered).toEqual({ id: 'm1', content: 'hello' });
        await sentinel(inRoom, gotIn);

        expect(gotIn).toEqual([{ event: 'Message', data: { id: 'm1', content: 'hello' } }]);
        expect(gotElsewhere).toEqual([]);
        expect(warn.mock.calls.filter(([f]) => f?.room === channelRoom)).toEqual([]);
    });

    it('[SEC-01.bridge-allowlist] the other allowlisted events are forwarded once each', async () => {
        const socket = await join([channelRoom]);
        const got = record(socket);
        await publish(channelRoom, 'MessageUpdate', { id: 'u1' });
        await publish(channelRoom, 'ThreadMetadataUpdate', { id: 't1' });
        await sentinel(socket, got);
        expect(got).toEqual([
            { event: 'MessageUpdate', data: { id: 'u1' } },
            { event: 'ThreadMetadataUpdate', data: { id: 't1' } },
        ]);
    });

    it('[SEC-01.bridge-allowlist] _GatewayAccessChanged on user:<id> calls the access refresh once and is never forwarded', async () => {
        const socket = await join([channelRoom, userRoom]);
        const got = record(socket);
        await publish(userRoom, '_GatewayAccessChanged', { grant: 'admin' });
        await sentinel(socket, got);

        expect(refreshAccess).toHaveBeenCalledTimes(1);
        expect(got).toEqual([]);
        expect(warningsFor(userRoom, '_GatewayAccessChanged')).toEqual([]);
    });

    it('[SEC-01.bridge-allowlist] malformed payloads are ignored without delivery', async () => {
        const socket = await join([channelRoom]);
        const got = record(socket);
        await publisher.publish(EVENT_CHANNEL, 'not json');
        await publisher.publish(EVENT_CHANNEL, JSON.stringify(null));
        await publisher.publish(EVENT_CHANNEL, JSON.stringify({ room: channelRoom }));
        await sentinel(socket, got);
        expect(got).toEqual([]);
        expect(refreshAccess).not.toHaveBeenCalled();
    });
});

describe('event bridge as wired in the API (src/app.ts)', () => {
    let ctx: Awaited<ReturnType<typeof setupTestApp>>;
    let port: number;
    const sockets: Socket[] = [];

    beforeAll(async () => {
        ctx = await setupTestApp();
        await ctx.app.listen({ port: 0, host: '127.0.0.1' });
        port = (ctx.app.server.address() as AddressInfo).port;
    });
    afterAll(async () => { await ctx.close(); });
    beforeEach(async () => { await cleanDatabase(ctx.db); });
    afterEach(() => { for (const s of sockets.splice(0)) s.disconnect(); });

    async function ready(token: string): Promise<Socket> {
        const socket = connectClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], auth: { token }, reconnection: false, autoConnect: false });
        sockets.push(socket);
        const r = waitForEvent(socket, 'Ready');
        socket.connect();
        await r;
        return socket;
    }

    it('[SEC-01.bridge-allowlist] _GatewayAccessChanged makes the API re-read permissions from the DB and is never forwarded', async () => {
        const owner = await authedUser(ctx.request, 'bridgeowner');
        const member = await authedUser(ctx.request, 'bridgemember');
        const server = await createServer(ctx.request, owner.auth, 'Bridge');
        await joinViaInvite(ctx.request, owner.auth, member.auth, server.serverId);
        const room = `channel:${server.generalChannelId}`;
        const warn = vi.spyOn(ctx.app.log, 'warn');

        const memberSocket = await ready(member.token);
        const ownerSocket = await ready(owner.token);
        const gotMember = record(memberSocket);
        const gotOwner = record(ownerSocket);

        // A hint with nothing changed in the DB: everyone stays connected
        await publish(`user:${member.userId}`, '_GatewayAccessChanged', {});
        const first = waitForEvent(memberSocket, 'Message');
        await publish(room, 'Message', { n: 1 });
        expect(await first).toEqual({ n: 1 });
        expect(memberSocket.connected).toBe(true);

        // Revoke the member's view of #general in the DB only (no route, so no refresh of its own)
        await ctx.db.query(
            'INSERT INTO channel_member_overrides (channel_id, user_id, allow, deny) VALUES ($1, $2, 0, $3)',
            [server.generalChannelId, member.userId, Permissions.ViewChannel.toString()]);
        const second = waitForEvent(memberSocket, 'Message');
        await publish(room, 'Message', { n: 2 });
        expect(await second).toEqual({ n: 2 }); // still in the room: nothing re-read yet

        const evicted = waitForEvent(memberSocket, 'error');
        const disconnected = waitForEvent(memberSocket, 'disconnect');
        await publish(`user:${member.userId}`, '_GatewayAccessChanged', { anything: true });
        expect(await evicted).toEqual({ code: 'channel_access_revoked' });
        await disconnected;

        // After the re-read the member gets nothing; the owner still does
        const third = waitForEvent(ownerSocket, 'Message');
        await publish(room, 'Message', { n: 3 });
        expect(await third).toEqual({ n: 3 });

        const names = (got: { event: string }[]) => got.map(g => g.event).filter(e => e !== 'PresenceUpdate' && e !== 'TypingStart');
        expect(gotMember.filter(g => g.event === '_GatewayAccessChanged')).toEqual([]);
        expect(gotOwner.filter(g => g.event === '_GatewayAccessChanged')).toEqual([]);
        expect(gotMember.filter(g => g.event === 'Message').map(g => g.data)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(gotOwner.filter(g => g.event === 'Message').map(g => g.data)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
        expect(names(gotMember)).toEqual(['Message', 'Message', 'error']);
        expect(warn.mock.calls.filter(([f]: any[]) => f?.room === `user:${member.userId}` || f?.room === room)).toEqual([]);
        warn.mockRestore();
    });

    it('[SEC-01.bridge-allowlist] the API drops a non-allowlisted event with 1 warning and delivers nothing', async () => {
        const owner = await authedUser(ctx.request, 'bridgeowner2');
        const server = await createServer(ctx.request, owner.auth, 'Bridge 2');
        const room = `channel:${server.generalChannelId}`;
        const warn = vi.spyOn(ctx.app.log, 'warn');
        const socket = await ready(owner.token);
        const got = record(socket);

        await publish(room, 'ServerUpdate', { name: 'pwned' });
        await publish(`user:${owner.userId}`, 'Message', { content: 'direct' });
        const sentinel = waitForEvent(socket, 'Message');
        await publish(room, 'Message', { sentinel: true });
        await sentinel;

        expect(got.filter(g => g.event === 'ServerUpdate')).toEqual([]);
        expect(got.filter(g => g.event === 'Message').map(g => g.data)).toEqual([{ sentinel: true }]);
        const mine = warn.mock.calls.filter(([f]: any[]) => f?.room === room || f?.room === `user:${owner.userId}`);
        expect(mine).toEqual([
            [{ room, event: 'ServerUpdate' }, 'Dropped non-allowlisted bridged event'],
            [{ room: `user:${owner.userId}`, event: 'Message' }, 'Dropped non-allowlisted bridged event'],
        ]);
        warn.mockRestore();
    });
});

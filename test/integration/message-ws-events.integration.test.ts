import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

const TEST_PORT = 4999;

function connectSocket(token: string): Promise<{ socket: Socket; ready: any }> {
    return new Promise((resolve, reject) => {
        const socket = io(`http://localhost:${TEST_PORT}`, {
            auth: { token },
            transports: ['websocket'],
        });

        const timeout = setTimeout(() => {
            socket.disconnect();
            reject(new Error('Socket connect + Ready timeout (2s)'));
        }, 2000);

        socket.on('Ready', (data: any) => {
            clearTimeout(timeout);
            resolve({ socket, ready: data });
        });

        socket.on('connect_error', (err: Error) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    await ctx.app.listen({ port: TEST_PORT, host: '0.0.0.0' });
});

afterAll(async () => {
    await ctx.close();
});

describe('Message WS event payload', () => {
    test('Message event includes authorUsername and createdAt', async () => {
        const owner = await authedUser(ctx.request, 'mpayload_owner');
        const member = await authedUser(ctx.request, 'mpayload_member');

        const { serverId, generalChannelId } = await createServer(
            ctx.request, owner.auth, 'MsgPayload Server'
        );
        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);

        const { socket } = await connectSocket(member.token);

        const msgPromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Message timeout (2s)')), 2000);
            socket.on('Message', (data: any) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });

        await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: 'hello payload test' });

        const event = await msgPromise;
        expect(event.content).toBe('hello payload test');
        expect(event.authorId).toBeTruthy();
        expect(event.authorUsername).toBe('mpayload_owner');
        expect(event.createdAt).toBeTruthy();
        expect(event.channelId).toBe(generalChannelId);

        socket.disconnect();
    });
});

describe('MessageUpdate WS event', () => {
    test('editing a message broadcasts MessageUpdate to channel members', async () => {
        const owner = await authedUser(ctx.request, 'mupd_owner');
        const member = await authedUser(ctx.request, 'mupd_member');

        const { serverId, generalChannelId } = await createServer(
            ctx.request, owner.auth, 'MsgUpdate Server'
        );
        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);

        // Member connects via WS
        const { socket } = await connectSocket(member.token);

        // Register listener before triggering the edit
        const updatePromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('MessageUpdate timeout (2s)')), 2000);
            socket.on('MessageUpdate', (data: any) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });

        // Owner sends a message via REST
        const sendRes = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: 'original content' });
        expect(sendRes.status).toBe(201);
        const messageId = sendRes.body.id;

        // Owner edits the message
        const editRes = await ctx.request
            .patch(`/channels/${generalChannelId}/messages/${messageId}`)
            .set(owner.auth)
            .send({ content: 'edited content' });
        expect(editRes.status).toBe(200);

        // Member should receive MessageUpdate
        const event = await updatePromise;
        expect(event.id).toBe(messageId);
        expect(event.channelId).toBe(generalChannelId);
        expect(event.content).toBe('edited content');
        expect(event.editedAt).toBeTruthy();

        socket.disconnect();
    });

    test('non-member does not receive MessageUpdate', async () => {
        const owner = await authedUser(ctx.request, 'mupd_owner2');
        const outsider = await authedUser(ctx.request, 'mupd_outsider');

        const { generalChannelId } = await createServer(
            ctx.request, owner.auth, 'MsgUpdate Server2'
        );

        // Outsider connects via WS (not a member of the server)
        const { socket } = await connectSocket(outsider.token);

        let received = false;
        socket.on('MessageUpdate', () => { received = true; });

        // Owner sends + edits a message
        const sendRes = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: 'original' });
        const messageId = sendRes.body.id;

        await ctx.request
            .patch(`/channels/${generalChannelId}/messages/${messageId}`)
            .set(owner.auth)
            .send({ content: 'edited' });

        // Give a short window for any event to arrive
        await new Promise((r) => setTimeout(r, 200));
        expect(received).toBe(false);

        socket.disconnect();
    });
});

describe('MessageDelete WS event', () => {
    test('deleting a message broadcasts MessageDelete to channel members', async () => {
        const owner = await authedUser(ctx.request, 'mdel_owner');
        const member = await authedUser(ctx.request, 'mdel_member');

        const { serverId, generalChannelId } = await createServer(
            ctx.request, owner.auth, 'MsgDelete Server'
        );
        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);

        // Member connects via WS
        const { socket } = await connectSocket(member.token);

        // Register listener before triggering the delete
        const deletePromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('MessageDelete timeout (2s)')), 2000);
            socket.on('MessageDelete', (data: any) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });

        // Owner sends a message via REST
        const sendRes = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: 'to be deleted' });
        expect(sendRes.status).toBe(201);
        const messageId = sendRes.body.id;

        // Owner deletes the message
        const delRes = await ctx.request
            .delete(`/channels/${generalChannelId}/messages/${messageId}`)
            .set(owner.auth);
        expect(delRes.status).toBe(200);

        // Member should receive MessageDelete
        const event = await deletePromise;
        expect(event.id).toBe(messageId);
        expect(event.channelId).toBe(generalChannelId);
        expect(event.deletedAt).toBeTruthy();

        socket.disconnect();
    });

    test('non-member does not receive MessageDelete', async () => {
        const owner = await authedUser(ctx.request, 'mdel_owner2');
        const outsider = await authedUser(ctx.request, 'mdel_outsider');

        const { generalChannelId } = await createServer(
            ctx.request, owner.auth, 'MsgDelete Server2'
        );

        // Outsider connects via WS (not a member of the server)
        const { socket } = await connectSocket(outsider.token);

        let received = false;
        socket.on('MessageDelete', () => { received = true; });

        // Owner sends + deletes a message
        const sendRes = await ctx.request
            .post(`/channels/${generalChannelId}/messages`)
            .set(owner.auth)
            .send({ content: 'ephemeral' });
        const messageId = sendRes.body.id;

        await ctx.request
            .delete(`/channels/${generalChannelId}/messages/${messageId}`)
            .set(owner.auth);

        // Give a short window for any event to arrive
        await new Promise((r) => setTimeout(r, 200));
        expect(received).toBe(false);

        socket.disconnect();
    });
});

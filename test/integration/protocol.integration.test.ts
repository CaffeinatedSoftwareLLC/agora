import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

/**
 * agora-collab protocol headers in message content are parsed into a
 * structured `protocol` field on create, edit, read, and thread replies.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let channelId: string;

async function waitForRow(id: string) {
    for (let i = 0; i < 20; i++) {
        const res = await ctx.db.query('SELECT 1 FROM messages WHERE id = $1', [id]);
        if (res.rows.length > 0) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Message never committed: ${id}`);
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'protoowner');
    const server = await createServer(ctx.request, owner.auth, 'Protocol Server');
    channelId = server.generalChannelId;
});

afterAll(async () => {
    await ctx.close();
});

const TURN = '[AGORA/v1 MODE=plan STATE=TURN]\nMy proposal.\n[YIELD to=codex]';

describe('message protocol field', () => {
    let messageId: string;

    test('create returns parsed protocol', async () => {
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: TURN });
        expect(res.status).toBe(201);
        expect(res.body.protocol).toEqual({ version: 1, mode: 'plan', state: 'TURN', yieldTo: 'codex' });
        messageId = res.body.id;
        await waitForRow(messageId);
    });

    test('ordinary messages have no protocol field', async () => {
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: 'just chatting' });
        expect(res.status).toBe(201);
        expect(res.body.protocol).toBeUndefined();
        await waitForRow(res.body.id);
    });

    test('channel history includes protocol', async () => {
        const res = await ctx.request.get(`/channels/${channelId}/messages`).set(owner.auth);
        const msg = res.body.find((m: any) => m.id === messageId);
        expect(msg.protocol.state).toBe('TURN');
        expect(msg.protocol.yieldTo).toBe('codex');
    });

    test('editing re-parses the header', async () => {
        const res = await ctx.request
            .patch(`/channels/${channelId}/messages/${messageId}`)
            .set(owner.auth)
            .send({ content: '[AGORA/v1 MODE=plan STATE=DECIDE]\nAGREE' });
        expect(res.status).toBe(200);

        for (let i = 0; i < 20; i++) {
            const row = await ctx.db.query('SELECT protocol FROM messages WHERE id = $1', [messageId]);
            if (row.rows[0].protocol?.state === 'DECIDE') break;
            await new Promise(r => setTimeout(r, 50));
        }
        const row = await ctx.db.query('SELECT protocol FROM messages WHERE id = $1', [messageId]);
        expect(row.rows[0].protocol).toEqual({ version: 1, mode: 'plan', state: 'DECIDE', decision: 'AGREE' });
    });

    test('editing the header away clears protocol', async () => {
        await ctx.request.patch(`/channels/${channelId}/messages/${messageId}`).set(owner.auth).send({ content: 'never mind' });
        for (let i = 0; i < 20; i++) {
            const row = await ctx.db.query('SELECT protocol FROM messages WHERE id = $1', [messageId]);
            if (row.rows[0].protocol === null) return;
            await new Promise(r => setTimeout(r, 50));
        }
        throw new Error('protocol was not cleared');
    });

    test('thread replies carry protocol in create and list responses', async () => {
        const start = await ctx.request
            .post(`/channels/${channelId}/messages`)
            .set(owner.auth)
            .send({ content: '[AGORA/v1 MODE=review STATE=START]\nReview PR 12\nparticipants: [claude, codex]' });
        expect(start.body.protocol.participants).toEqual(['claude', 'codex']);
        await waitForRow(start.body.id);

        const ack = await ctx.request
            .post(`/channels/${channelId}/messages/${start.body.id}/replies`)
            .set(owner.auth)
            .send({ content: '[AGORA/v1 MODE=review STATE=ACK]\nScope confirmed.' });
        expect(ack.status).toBe(201);
        expect(ack.body.protocol).toEqual({ version: 1, mode: 'review', state: 'ACK' });
        await waitForRow(ack.body.id);

        const replies = await ctx.request
            .get(`/channels/${channelId}/messages/${start.body.id}/replies`)
            .set(owner.auth);
        expect(replies.body[0].protocol.state).toBe('ACK');
    });

    test('deleting a message clears protocol', async () => {
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: TURN });
        await waitForRow(res.body.id);
        await ctx.request.delete(`/channels/${channelId}/messages/${res.body.id}`).set(owner.auth);

        for (let i = 0; i < 20; i++) {
            const row = await ctx.db.query('SELECT protocol, deleted_at FROM messages WHERE id = $1', [res.body.id]);
            if (row.rows[0].deleted_at) {
                expect(row.rows[0].protocol).toBeNull();
                return;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        throw new Error('message was not deleted');
    });
});

import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

/**
 * Message text is cleaned on the way in (#88): terminal escape sequences are removed and
 * private-key blocks redacted, for channel posts, thread replies and edits.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let auth: { Authorization: string };
let channelId: string;

// Built from code points so this file holds no raw control characters
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
const DIRTY = `${ESC}]0;title${BEL}${ESC}[31mtests failed${ESC}[0m, key:\n${KEY}\ndone`;
const CLEAN = 'tests failed, key:\n[private key redacted]\ndone';

async function stored(id: string): Promise<string> {
    const row = await ctx.db.query('SELECT content FROM messages WHERE id = $1', [id]);
    return row.rows[0].content;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    const owner = await authedUser(ctx.request, 'sanitizer');
    auth = owner.auth;
    channelId = (await createServer(ctx.request, auth, 'Sanitize Server')).generalChannelId;
});

afterAll(async () => {
    await ctx.close();
});

describe('message text sanitizing (#88)', () => {
    it('cleans a channel post before storing and returning it', async () => {
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content: DIRTY });
        expect(res.status).toBe(201);
        expect(res.body.content).toBe(CLEAN);
        expect(await stored(res.body.id)).toBe(CLEAN);
    });

    it('cleans a thread reply', async () => {
        const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content: 'parent' });
        const res = await ctx.request.post(`/channels/${channelId}/messages/${parent.body.id}/replies`).set(auth).send({ content: DIRTY });
        expect(res.status).toBe(201);
        expect(await stored(res.body.id)).toBe(CLEAN);
    });

    it('cleans an edit', async () => {
        const msg = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content: 'first' });
        const res = await ctx.request.patch(`/channels/${channelId}/messages/${msg.body.id}`).set(auth).send({ content: DIRTY });
        expect(res.status).toBe(200);
        expect(await stored(msg.body.id)).toBe(CLEAN);
    });

    it('refuses text that is nothing but escape codes', async () => {
        const post = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content: `${ESC}[0m` });
        expect(post.status).toBe(400);
        expect(post.body.error).toBe('empty_content');
        const parent = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content: 'p' });
        const reply = await ctx.request.post(`/channels/${channelId}/messages/${parent.body.id}/replies`).set(auth).send({ content: `${ESC}[2J` });
        expect(reply.status).toBe(400);
    });

    it('leaves ordinary text untouched', async () => {
        const text = 'plain [text] with @mentions\n\ttabs and ]brackets[';
        const res = await ctx.request.post(`/channels/${channelId}/messages`).set(auth).send({ content: text });
        expect(await stored(res.body.id)).toBe(text);
    });
});

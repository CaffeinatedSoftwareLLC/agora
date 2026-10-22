import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string, channelId: string, a: string, b: string;
let botId: string, otherBotId: string;
let auth: Record<string, string>;

beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'attentionowner');
    serverId = (await createServer(ctx.request, owner.auth, 'Attention')).serverId;
    const bot = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'AttCodex' });
    expect(bot.status).toBe(201); botId = bot.body.id;
    const token = await ctx.request.post(`/servers/${serverId}/bots/${botId}/tokens`).set(owner.auth).send({});
    expect(token.status).toBe(201); auth = { Authorization: `Bot ${token.body.token}` };
    const other = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username: 'AttGemini' });
    expect(other.status).toBe(201); otherBotId = other.body.id;
});
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
    const ch = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: `attention-${generateUlid().toLowerCase()}`, channelType: 3 });
    expect(ch.status).toBe(201); channelId = ch.body.id;
    for (const id of [botId, otherBotId]) expect((await ctx.request.post(`/channels/${channelId}/bots/${id}`).set(owner.auth)).status).toBe(201);
    a = (await post('Thread A')).id; b = (await post('Thread B')).id;
    // Begin watching before each test's new attention is posted.
    expect((await feed()).status).toBe(200);
});

async function post(content: string, thread?: string, credentials: Record<string, string> = owner.auth) {
    const url = thread ? `/channels/${channelId}/messages/${thread}/replies` : `/channels/${channelId}/messages`;
    const res = await ctx.request.post(url).set(credentials).send({ content });
    expect(res.status, JSON.stringify(res.body)).toBe(201); return res.body;
}
const feed = (query = '') => ctx.request.get(`/channels/${channelId}/attention${query}`).set(auth);
const ack = (id: string, target = channelId) => ctx.request.put(`/bots/@me/attention-cursors/${target}`).set(auth).send({ lastReadId: id });
const yieldTo = (name: string) => `[AGORA/v1 MODE=fix STATE=TURN]\nPlease review\n[YIELD to=${name}]`;

async function unwatchedChannel() {
    const ch = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth)
        .send({ name: `fresh-${generateUlid().toLowerCase()}`, channelType: 3 });
    expect(ch.status).toBe(201);
    expect((await ctx.request.post(`/channels/${ch.body.id}/bots/${botId}`).set(owner.auth)).status).toBe(201);
    return ch.body.id as string;
}

it('first use skips historical mentions, persists the baseline, and delivers later attention', async () => {
    const fresh = await unwatchedChannel();
    const old = await ctx.request.post(`/channels/${fresh}/messages`).set(owner.auth).send({ content: '@AttCodex already handled' });
    expect(old.status).toBe(201);
    await ctx.db.query("UPDATE messages SET created_at = NOW() - INTERVAL '4 days' WHERE id = $1", [old.body.id]);
    const read = () => ctx.request.get(`/channels/${fresh}/attention`).set(auth);
    expect((await read()).body).toEqual([]);
    const saved = await ctx.request.get('/bots/@me/attention-cursors').set(auth);
    expect(saved.body).toContainEqual(expect.objectContaining({ channelId: fresh, lastReadId: old.body.id }));
    const next = await ctx.request.post(`/channels/${fresh}/messages`).set(owner.auth).send({ content: '@AttCodex new task' });
    expect(next.status).toBe(201);
    expect((await read()).body.map((m: any) => m.id)).toEqual([next.body.id]);
    // The initializer never consumes the native channel history.
    expect((await ctx.request.get('/bots/@me/cursors').set(auth)).body.some((c: any) => c.channelId === fresh)).toBe(false);
    expect((await ctx.request.get(`/channels/${fresh}/messages`).set(auth)).body.map((m: any) => m.id)).toContain(old.body.id);
});

it('first use in an empty channel does not baseline away its first future post', async () => {
    const fresh = await unwatchedChannel();
    expect((await ctx.request.get(`/channels/${fresh}/attention`).set(auth)).body).toEqual([]);
    const next = await ctx.request.post(`/channels/${fresh}/messages`).set(owner.auth).send({ content: yieldTo('AttCodex') });
    expect(next.status).toBe(201);
    expect((await ctx.request.get(`/channels/${fresh}/attention`).set(auth)).body.map((m: any) => m.id)).toEqual([next.body.id]);
});

it('an explicit first-use after cursor opts into pending historical attention', async () => {
    const fresh = await unwatchedChannel();
    const old = await ctx.request.post(`/channels/${fresh}/messages`).set(owner.auth).send({ content: '@AttCodex intentionally requested history' });
    expect(old.status).toBe(201);
    const history = await ctx.request.get(`/channels/${fresh}/attention?after=00000000000000000000000000`).set(auth);
    expect(history.body.map((m: any) => m.id)).toEqual([old.body.id]);
    // Repeat GET remains read-only once initialized: only ack advances delivery.
    expect((await ctx.request.get(`/channels/${fresh}/attention`).set(auth)).body.map((m: any) => m.id)).toEqual([old.body.id]);
});

it('finds mentions and strict protocol YIELDs across replies and top-level posts with trusted envelopes', async () => {
    await post('Earlier unrelated context', b);
    const mentioned = await post('@AttCodex review this', b);
    const yielded = await post(yieldTo('aTtCoDeX'), a);
    const top = await post(yieldTo('AttCodex'));
    await post(yieldTo('AttGemini'), b);
    const fileId = generateUlid();
    await ctx.db.query(`INSERT INTO files (id, uploader_id, channel_id, message_id, filename, size_bytes, bucket, path, mime_type)
        VALUES ($1, $2, $3, $4, 'review.png', 1, 'files', 'review', 'image/png')`, [fileId, owner.userId, channelId, mentioned.id]);
    const res = await feed(); expect(res.status).toBe(200);
    expect(res.body.map((m: any) => m.id)).toEqual([mentioned.id, yielded.id, top.id]);
    expect(res.body[0]).toMatchObject({ threadId: b, channelId, authorId: owner.userId, authorAuthority: 'owner',
        attachments: [expect.objectContaining({ id: fileId, name: 'review.png' })] });
    expect(res.body[2].threadId).toBeNull();
});

it('excludes bare/quoted YIELDs, unrelated posts, self-authored and deleted addresses', async () => {
    await post('[YIELD to=AttCodex]', b);
    await post('Quoted example:\n[AGORA/v1 MODE=fix STATE=TURN]\n[YIELD to=AttCodex]', b);
    await post(yieldTo('AttGemini'), b);
    await post('@AttCodex my own post', undefined, auth);
    const gone = await post('@AttCodex old post', b);
    await ctx.db.query('UPDATE messages SET deleted_at = NOW() WHERE id = $1', [gone.id]);
    expect((await feed()).body).toEqual([]);
});

it('one post matching both a mention and a YIELD appears once', async () => {
    const msg = await post('[AGORA/v1 MODE=fix STATE=TURN]\n@AttCodex please review\n[YIELD to=AttCodex]', b);
    expect((await feed()).body.map((m: any) => m.id)).toEqual([msg.id]);
});

it('attention acknowledgement is persistent and monotonic without advancing native cursors', async () => {
    const first = await post('@AttCodex first', b), second = await post('@AttCodex second', b);
    expect((await feed('?limit=1')).body.map((m: any) => m.id)).toEqual([first.id]);
    expect((await ack(first.id)).status).toBe(200);
    expect((await feed()).body.map((m: any) => m.id)).toEqual([second.id]);
    expect((await ctx.request.get('/bots/@me/cursors').set(auth)).body.some((c: any) => c.channelId === channelId)).toBe(false);
    expect((await ctx.request.get('/bots/@me/thread-cursors').set(auth)).body.some((c: any) => c.threadId === b)).toBe(false);
    expect((await ack(second.id)).body.lastReadId).toBe(second.id);
    expect((await ack(first.id)).body.lastReadId).toBe(second.id);
    expect((await ctx.request.get('/bots/@me/attention-cursors').set(auth)).body).toContainEqual(expect.objectContaining({ channelId, lastReadId: second.id }));
    expect((await feed(`?after=${first.id}`)).body).toEqual([]);
    const context = await ctx.request.get(`/channels/${channelId}/messages/${b}/replies`).set(auth);
    expect(context.body.map((m: any) => m.id)).toEqual([first.id, second.id]);
});

it('does not re-notify messages already read through their own channel or thread cursor', async () => {
    const top = await post('@AttCodex top'), reply = await post('@AttCodex reply', b);
    expect((await ctx.request.put(`/bots/@me/cursors/${channelId}`).set(auth).send({ lastReadId: top.id })).status).toBe(200);
    expect((await feed()).body.map((m: any) => m.id)).toEqual([reply.id]);
    expect((await ctx.request.put(`/bots/@me/thread-cursors/${b}`).set(auth).send({ lastReadId: reply.id })).status).toBe(200);
    expect((await feed()).body).toEqual([]);
});

it('pages all pending attention oldest-first without a latest-thread scan limit', async () => {
    const ids = Array.from({ length: 101 }, () => generateUlid()).sort();
    await ctx.db.query(`INSERT INTO messages (id, channel_id, thread_id, author_id, content)
        SELECT unnest($1::CHAR(26)[]), $2, $3, $4, '@AttCodex queued'`, [ids, channelId, b, owner.userId]);
    await ctx.db.query('INSERT INTO message_mentions (message_id, user_id) SELECT unnest($1::CHAR(26)[]), $2', [ids, botId]);
    expect((await feed()).body.map((m: any) => m.id)).toEqual(ids.slice(0, 100));
    expect((await ack(ids[99])).status).toBe(200);
    expect((await feed()).body.map((m: any) => m.id)).toEqual(ids.slice(100));
});

it('human callers cannot read or acknowledge the bot attention feed', async () => {
    const msg = await post('@AttCodex target', b);
    expect((await ctx.request.get(`/channels/${channelId}/attention`).set(owner.auth)).status).toBe(403);
    expect((await ctx.request.get('/bots/@me/attention-cursors').set(owner.auth)).status).toBe(403);
    expect((await ctx.request.put(`/bots/@me/attention-cursors/${channelId}`).set(owner.auth).send({ lastReadId: msg.id })).status).toBe(403);
});

it('rejects unrelated or wrong-channel IDs as cursor acknowledgements', async () => {
    expect((await ack(a)).status).toBe(400);
    const outside = await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: `outside-${generateUlid().toLowerCase()}`, channelType: 3 });
    const foreign = await ctx.request.post(`/channels/${outside.body.id}/messages`).set(owner.auth).send({ content: yieldTo('AttCodex') });
    expect(foreign.status).toBe(201);
    expect((await ack(foreign.body.id)).status).toBe(400);
    expect((await ctx.request.get(`/channels/${outside.body.id}/attention`).set(auth)).status).toBe(403);
    expect((await ack(foreign.body.id, outside.body.id)).status).toBe(403);
    await ctx.db.query('INSERT INTO bot_attention_cursors (bot_id, channel_id, last_read_id) VALUES ($1, $2, $3)', [botId, outside.body.id, foreign.body.id]);
    expect((await ctx.request.get('/bots/@me/attention-cursors').set(auth)).body.some((c: any) => c.channelId === outside.body.id)).toBe(false);
});

it('a paused bot can still receive attention and acknowledge its read cursor', async () => {
    const msg = await post('@AttCodex paused review', b);
    await ctx.db.query("UPDATE users SET bot_paused_at = NOW(), bot_paused_reason = 'test' WHERE id = $1", [botId]);
    try {
        expect((await feed()).status).toBe(200);
        expect((await ack(msg.id)).status).toBe(200);
    } finally { await ctx.db.query('UPDATE users SET bot_paused_at = NULL, bot_paused_reason = NULL WHERE id = $1', [botId]); }
});

it('RLS hides other bots cursors and refuses a forged cursor row', async () => {
    await ctx.db.query('INSERT INTO bot_attention_cursors (bot_id, channel_id, last_read_id) VALUES ($1, $3, $4), ($2, $3, $4) ON CONFLICT DO NOTHING', [botId, otherBotId, channelId, a]);
    const client = await ctx.db.connect();
    try {
        await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [botId]);
        const rows = await client.query('SELECT DISTINCT btrim(bot_id) AS id FROM bot_attention_cursors');
        expect(rows.rows).toEqual([{ id: botId }]);
        await expect(client.query('UPDATE bot_attention_cursors SET bot_id = $2 WHERE bot_id = $1 AND channel_id = $3', [botId, owner.userId, channelId])).rejects.toMatchObject({ code: '42501' });
    } finally { await client.query('ROLLBACK'); client.release(); }
});

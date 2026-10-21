import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'caseowner');
    const server = await createServer(ctx.request, owner.auth, 'Username uniqueness');
    serverId = server.serverId;
    channelId = server.generalChannelId;
});
afterAll(async () => { await ctx.close(); });

async function bot(username: string) {
    const res = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
}

it('registration rejects human and bot case twins, keeping distinct names available', async () => {
    await bot('speechbot');
    for (const username of ['CaseOwner', 'SpeechBot']) {
        const res = await ctx.request.post('/auth/register').send({ username, email: `${username}@fresh.test`, password: 'TestPass123!' });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'username_taken' });
    }
    await authedUser(ctx.request, 'distinctname');
});

it('bot creation rejects human and bot case twins across servers', async () => {
    const other = await createServer(ctx.request, owner.auth, 'Another server');
    await bot('globalbot');
    for (const username of ['CASEOWNER', 'GlobalBot']) {
        const res = await ctx.request.post(`/servers/${other.serverId}/bots`).set(owner.auth).send({ username });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'username_taken' });
    }
});

it('[ID-05.bot-edit] rejects a case twin rename; mentions still reach only the original', async () => {
    const original = await bot('casecodex');
    const twin = await bot('casetwin');
    for (const id of [original, twin]) {
        expect((await ctx.request.post(`/channels/${channelId}/bots/${id}`).set(owner.auth)).status).toBe(201);
    }
    const res = await ctx.request.patch(`/servers/${serverId}/bots/${twin}`).set(owner.auth).send({ username: 'CaseCodex' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'username_taken' });
    expect((await ctx.db.query('SELECT username FROM users WHERE id = $1', [twin])).rows[0].username).toBe('casetwin');
    const message = await ctx.request.post(`/channels/${channelId}/messages`).set(owner.auth).send({ content: '@CASECODEX check this' });
    expect(message.status).toBe(201);
    expect(message.body.mentions).toEqual([original]);
    expect((await ctx.db.query('SELECT btrim(user_id) AS id FROM message_mentions WHERE message_id = $1', [message.body.id])).rows).toEqual([{ id: original }]);
});

it('allows a case-only rename of the same bot', async () => {
    const id = await bot('owncase');
    const res = await ctx.request.patch(`/servers/${serverId}/bots/${id}`).set(owner.auth).send({ username: 'OwnCase' });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('OwnCase');
});

it('the index arbitrates simultaneous registrations without a 500', async () => {
    const results = await Promise.all(['Concurrent', 'concurrent'].map((username, i) => ctx.request.post('/auth/register')
        .send({ username, email: `concurrent${i}@fresh.test`, password: 'TestPass123!' })));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(results.find(r => r.status === 409)!.body).toEqual({ error: 'username_taken' });
});

const migration = readFileSync(resolve(__dirname, '../../src/db/migrations/061_case_insensitive_usernames.sql'), 'utf8');

it('migration reports every legacy collision with names and IDs, changing no accounts', async () => {
    const client = await ctx.db.connect();
    try {
        await client.query('BEGIN');
        // Shadow the real table only on this connection; never remove its index.
        await client.query('CREATE TEMP TABLE users (id CHAR(26), username VARCHAR(32))');
        await client.query("INSERT INTO users VALUES ('A', 'Alice'), ('B', 'alice'), ('C', 'BOB'), ('D', 'bob')");
        await client.query('SAVEPOINT before_migration');
        const error = await client.query(migration).catch(err => err);
        expect(error).toMatchObject({
            message: expect.stringContaining('Existing collisions:'),
            hint: expect.stringContaining('No accounts were renamed'),
        });
        for (const member of ["'Alice' (id=A)", "'alice' (id=B)", "'BOB' (id=C)", "'bob' (id=D)"]) {
            expect(error.message).toContain(member);
        }
        await client.query('ROLLBACK TO SAVEPOINT before_migration');
        expect((await client.query('SELECT username FROM users ORDER BY id')).rows.map(r => r.username)).toEqual(['Alice', 'alice', 'BOB', 'bob']);
        expect((await client.query("SELECT 1 FROM pg_index WHERE indrelid = 'pg_temp.users'::regclass")).rows).toEqual([]);
    } finally {
        await client.query('ROLLBACK');
        client.release();
    }
});

it('migration keeps original spelling and prevents direct SQL case twins', async () => {
    const client = await ctx.db.connect();
    try {
        await client.query('BEGIN');
        await client.query('CREATE TEMP TABLE users (id CHAR(26), username VARCHAR(32))');
        await client.query("INSERT INTO users VALUES ('E', 'OriginalSpelling')");
        await client.query(migration);
        expect((await client.query('SELECT username FROM users')).rows).toEqual([{ username: 'OriginalSpelling' }]);
        await expect(client.query("INSERT INTO users VALUES ('F', 'originalspelling')")).rejects.toMatchObject({ code: '23505', constraint: 'users_username_lower_key' });
    } finally {
        await client.query('ROLLBACK');
        client.release();
    }
});

import { setupTestApp, authedUser, createServer, cleanDatabase, joinViaInvite } from '../helpers';

/**
 * AI settings audit trail: every provider/route/assistant write is recorded with
 * the actor, the client, and before/after values; key material never is.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
const base = () => `/servers/${serverId}/ai`;
const SECRET_KEY = 'AIza-super-secret-key-123';

async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 40; i++) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('waitFor timed out');
}

async function changes() {
    const res = await ctx.request.get(`${base()}/changes`).set(owner.auth);
    expect(res.status).toBe(200);
    return res.body as any[];
}

async function auditCount() {
    return (await ctx.db.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE server_id = $1 AND action LIKE 'ai\\_%'", [serverId])).rows[0].n as number;
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'auditowner');
    ({ serverId } = await createServer(ctx.request, owner.auth, 'Audit Server'));
});

afterAll(async () => {
    await ctx.close();
});

describe('AI settings audit trail', () => {
    let geminiId: string;
    let tavilyId: string;

    test('provider create and route changes are recorded with before/after, actor, and client', async () => {
        const gem = await ctx.request.post(`${base()}/providers`).set(owner.auth).set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/140')
            .send({ adapter: 'gemini', label: 'Gemini', apiKey: SECRET_KEY });
        expect(gem.status).toBe(201);
        geminiId = gem.body.id;
        const tav = await ctx.request.post(`${base()}/providers`).set(owner.auth).send({ adapter: 'tavily', label: 'Tavy', apiKey: 'tvly-secret' });
        tavilyId = tav.body.id;
        await waitFor(async () => (await auditCount()) === 2);

        const chat = await ctx.request.put(`${base()}/routes/chat`).set(owner.auth).set('User-Agent', 'Mozilla/5.0 Chrome/140')
            .send({ providerId: geminiId, model: 'gemini-3.8-flash' });
        expect(chat.status).toBe(200);
        // Switch search from Tavily to Gemini: the case from the incident
        await ctx.request.put(`${base()}/routes/search`).set(owner.auth).send({ providerId: tavilyId, model: 'basic', enabled: true });
        await ctx.request.put(`${base()}/routes/search`).set(owner.auth).set('User-Agent', 'agora-mcp/0.3.0')
            .send({ providerId: geminiId, model: 'gemini-3.8-flash', enabled: true });
        await waitFor(async () => (await auditCount()) === 5);

        const list = await changes();
        expect(list.map(c => c.action)).toEqual(['ai_route_update', 'ai_route_update', 'ai_route_update', 'ai_provider_create', 'ai_provider_create']);
        const [searchSwitch, searchSet, chatSet] = list;
        expect(searchSwitch.changes).toMatchObject({
            capability: 'search',
            before: { provider: 'Tavy', model: 'basic', enabled: true },
            after: { provider: 'Gemini', model: 'gemini-3.8-flash', enabled: true },
            client: 'agora-mcp/0.3.0',
        });
        expect(searchSwitch.changes.changed).toEqual(expect.arrayContaining(['providerId', 'provider', 'model']));
        expect(searchSet.changes.before).toBeNull();
        expect(chatSet.changes).toMatchObject({ capability: 'chat', before: null, after: { model: 'gemini-3.8-flash' }, client: 'Mozilla/5.0 Chrome/140' });
        expect(chatSet.actor).toEqual({ id: owner.userId, username: 'auditowner', bot: false });
    });

    test('saving an unchanged route records nothing', async () => {
        const before = await auditCount();
        await ctx.request.put(`${base()}/routes/chat`).set(owner.auth).send({ providerId: geminiId, model: 'gemini-3.8-flash' });
        await new Promise(r => setTimeout(r, 200));
        expect(await auditCount()).toBe(before);
    });

    test('provider updates record fields and "key replaced", never key material', async () => {
        await ctx.request.patch(`${base()}/providers/${geminiId}`).set(owner.auth).send({ label: 'Gemini (team)', apiKey: 'AIza-another-secret' });
        await waitFor(async () => (await changes())[0]?.action === 'ai_provider_update');
        const [update] = await changes();
        expect(update.changes).toMatchObject({ before: { label: 'Gemini' }, after: { label: 'Gemini (team)' }, apiKey: 'replaced' });
        expect(update.changes.changed).toContain('label');

        const all = await ctx.db.query("SELECT changes::text AS c FROM audit_log WHERE server_id = $1 AND action LIKE 'ai\\_%'", [serverId]);
        for (const row of all.rows) {
            expect(row.c).not.toContain(SECRET_KEY);
            expect(row.c).not.toContain('AIza-another-secret');
            expect(row.c).not.toContain('tvly-secret');
            expect(row.c).not.toMatch(/api_key_(enc|iv|tag)/);
        }
    });

    test('route and provider deletes are recorded, including routes removed by the cascade', async () => {
        await ctx.request.delete(`${base()}/routes/search`).set(owner.auth);
        await waitFor(async () => (await changes())[0]?.action === 'ai_route_delete');
        expect((await changes())[0].changes).toMatchObject({ capability: 'search', before: { provider: 'Gemini (team)', model: 'gemini-3.8-flash' } });

        await ctx.request.delete(`${base()}/providers/${geminiId}`).set(owner.auth);
        await waitFor(async () => (await changes())[0]?.action === 'ai_provider_delete');
        expect((await changes())[0].changes).toMatchObject({ before: { label: 'Gemini (team)', adapter: 'gemini' }, routesRemoved: ['chat'] });
    });

    test('assistant setup (legacy PUT) and settings changes are recorded', async () => {
        const put = await ctx.request.put(`/servers/${serverId}/ai-config`).set(owner.auth).send({ provider: 'gemini', model: 'gemini-3.8-flash', apiKey: SECRET_KEY });
        expect(put.status).toBe(200);
        await waitFor(async () => (await changes()).some(c => c.changes.via === 'assistant setup'));
        const setup = (await changes()).find(c => c.changes.via === 'assistant setup')!;
        expect(setup.changes).toMatchObject({ capability: 'chat', before: null, after: { model: 'gemini-3.8-flash' }, apiKey: 'replaced' });

        await ctx.request.patch(`/servers/${serverId}/ai-config`).set(owner.auth).send({ systemPrompt: 'Be brief.', maxContext: 30 });
        await waitFor(async () => (await changes())[0]?.action === 'ai_assistant_update');
        expect((await changes())[0].changes).toMatchObject({ maxContext: 30, systemPrompt: { length: 9 } });
    });

    test('only server admins can read the trail', async () => {
        const member = await authedUser(ctx.request, 'auditmember');
        await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
        await waitFor(async () => (await ctx.db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, member.userId])).rows.length > 0);
        expect((await ctx.request.get(`${base()}/changes`).set(member.auth)).status).toBe(403);
        expect((await ctx.request.get(`${base()}/changes`)).status).toBe(401);
    });
});

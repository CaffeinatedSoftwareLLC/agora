import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { AgoraApi } from '../../agora-mcp/src/api';
import { decideTokenUse } from '../../src/auth/token-binding';

/**
 * Issue #39: a Codex session found Claude's bot token on the same machine and posted as
 * Claude. agora-mcp now names its MCP client (`X-Agora-Client`); the first named client
 * binds the token, and any other client is refused with a 403 naming the owner, recorded
 * on the token and in the audit log.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let channelId: string;
let baseUrl: string;
const sockets: Socket[] = [];

async function makeBot(username: string) {
    const created = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    const token = await ctx.request.post(`/servers/${serverId}/bots/${id}/tokens`).set(owner.auth).send({ name: 'claude' });
    expect(token.status).toBe(201);
    expect((await ctx.request.post(`/channels/${channelId}/bots/${id}`).set(owner.auth)).status).toBe(201);
    return { id, token: token.body.token as string, tokenId: token.body.tokenId as string };
}

const as = (token: string, client?: string) => ({ Authorization: `Bot ${token}`, ...(client ? { 'X-Agora-Client': client } : {}) });
const post = (token: string, client: string | undefined, content: string) =>
    ctx.request.post(`/channels/${channelId}/messages`).set(as(token, client)).send({ content });
const tokens = async (botId: string) => (await ctx.request.get(`/servers/${serverId}/bots/${botId}/tokens`).set(owner.auth)).body;
const audits = async (botId: string, action: string) =>
    (await ctx.db.query('SELECT changes FROM audit_log WHERE target_id = $1 AND action = $2 ORDER BY created_at', [botId, action])).rows.map((r: any) => r.changes);

function event(socket: Socket, name: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), 3000);
        socket.once(name, value => { clearTimeout(timer); resolve(value); });
    });
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = ctx.app.server.address();
    if (typeof addr === 'string' || !addr) throw new Error('no server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    owner = await authedUser(ctx.request, 'bindowner');
    member = await authedUser(ctx.request, 'bindmember');
    const server = await createServer(ctx.request, owner.auth, 'Token Binding');
    serverId = server.serverId;
    channelId = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    await ctx.db.query('UPDATE channels SET bot_rate_limit = 1000, max_bot_hops = 1000 WHERE id = $1', [channelId]);
});
afterEach(() => { for (const s of sockets.splice(0)) s.disconnect(); });
afterAll(async () => { await ctx.close(); });

describe('bot token client binding (#39)', () => {
    it('the rule: first named client binds, the same client passes, another or none is refused', () => {
        expect(decideTokenUse(null, null)).toEqual({ action: 'allow' });
        expect(decideTokenUse(null, 'claude-code')).toEqual({ action: 'bind', client: 'claude-code' });
        expect(decideTokenUse('claude-code', 'claude-code')).toEqual({ action: 'allow' });
        expect(decideTokenUse('claude-code', 'codex-mcp-client')).toEqual({ action: 'deny', boundClient: 'claude-code' });
        expect(decideTokenUse('claude-code', null)).toEqual({ action: 'deny', boundClient: 'claude-code' });
    });

    it('the Claude desktop app\'s client names count as Claude Code, and other vendors stay refused', async () => {
        expect(decideTokenUse('claude-code', 'Claude Desktop')).toEqual({ action: 'allow' });
        expect(decideTokenUse('Claude Desktop', 'claude-code')).toEqual({ action: 'allow' });
        expect(decideTokenUse('claude-code', 'claude-desktop-impostor')).toEqual({ action: 'deny', boundClient: 'claude-code' });
        expect(decideTokenUse('constructor', 'Constructor')).toEqual({ action: 'deny', boundClient: 'constructor' });

        const bot = await makeBot('desktopbot');
        expect((await post(bot.token, 'claude-code', 'from a CLI session')).status).toBe(201);
        expect((await post(bot.token, 'Claude Desktop', 'from a remote desktop session')).status).toBe(201);
        expect((await post(bot.token, 'codex-mcp-client', 'from codex')).status).toBe(403);
        expect((await tokens(bot.id))[0]).toMatchObject({ boundClient: 'claude-code', lastUsedClient: 'Claude Desktop' });
    });

    it('Codex using Claude\'s token gets a 403 naming the owning client, and the attempt is recorded and audited', async () => {
        const bot = await makeBot('claudebot');
        expect((await post(bot.token, 'claude-code', 'hello from claude')).status).toBe(201);

        const stolen = await post(bot.token, 'codex-mcp-client', 'hello from codex');
        expect(stolen.status).toBe(403);
        expect(stolen.body).toMatchObject({ error: 'token_bound_to_other_client', boundClient: 'claude-code' });
        expect(stolen.body.message).toContain('belongs to claude-code, not codex-mcp-client');

        // A script with the token and no client name is refused too, once the token is bound
        const curl = await ctx.request.get('/bots/@me').set(as(bot.token));
        expect(curl.status).toBe(403);
        expect(curl.body.message).toMatch(/^This bot token belongs to claude-code\. /);

        // Nothing was posted by the refused requests
        const messages = await ctx.db.query('SELECT content FROM messages WHERE author_id = $1', [bot.id]);
        expect(messages.rows.map((r: any) => r.content)).toEqual(['hello from claude']);

        const [token] = await tokens(bot.id);
        expect(token).toMatchObject({ boundClient: 'claude-code', lastUsedClient: 'claude-code', lastUsedIp: expect.any(String) });
        expect(token.boundAt).toBeTruthy();
        expect(token.lastRefused).toMatchObject({ client: null, ip: expect.any(String) });

        expect(await audits(bot.id, 'bot_token_bound')).toEqual([expect.objectContaining({ tokenId: bot.tokenId, client: 'claude-code' })]);
        expect(await audits(bot.id, 'bot_token_refused')).toEqual([
            expect.objectContaining({ tokenId: bot.tokenId, boundClient: 'claude-code', client: 'codex-mcp-client' }),
            expect.objectContaining({ tokenId: bot.tokenId, boundClient: 'claude-code', client: null }),
        ]);

        // The owning client keeps working
        expect((await post(bot.token, 'claude-code', 'still me')).status).toBe(201);
    });

    it('a repeated refusal from the same client is audited once per window, not once per request', async () => {
        const bot = await makeBot('loopbot');
        expect((await ctx.request.get('/bots/@me').set(as(bot.token, 'claude-code'))).status).toBe(200);
        for (let i = 0; i < 4; i++) expect((await ctx.request.get('/bots/@me').set(as(bot.token, 'codex-mcp-client'))).status).toBe(403);
        expect(await audits(bot.id, 'bot_token_refused')).toHaveLength(1);
    });

    it('a token never used with a client name stays unbound (scripts, older agora-mcp)', async () => {
        const bot = await makeBot('scriptbot');
        for (let i = 0; i < 2; i++) expect((await ctx.request.get('/bots/@me').set(as(bot.token))).status).toBe(200);
        const [token] = await tokens(bot.id);
        expect(token).toMatchObject({ boundClient: null, lastUsedClient: null, lastRefused: null });
    });

    it('agora-mcp\'s API client binds the token to the MCP client it reports', async () => {
        const bot = await makeBot('mcpbot');
        const api = new AgoraApi(baseUrl, bot.token);
        api.setClient(() => 'claude-code');
        expect((await api.getMe()).id.trim()).toBe(bot.id);
        const other = new AgoraApi(baseUrl, bot.token);
        other.setClient(() => 'codex-mcp-client');
        await expect(other.getMe()).rejects.toMatchObject({ status: 403 });
    });

    it('the socket is bound and refused the same way', async () => {
        const bot = await makeBot('socketbot');
        const first = io(baseUrl, { transports: ['websocket'], auth: { token: bot.token, type: 'bot', client: 'claude-code' }, reconnection: false });
        sockets.push(first);
        await event(first, 'BotReady');
        expect((await tokens(bot.id))[0].boundClient).toBe('claude-code');

        const stolen = io(baseUrl, { transports: ['websocket'], auth: { token: bot.token, type: 'bot', client: 'codex-mcp-client' }, reconnection: false });
        sockets.push(stolen);
        expect((await event(stolen, 'connect_error')).message).toContain('belongs to claude-code, not codex-mcp-client');
    });

    it('an owner can clear the binding; the next client binds it again. A member cannot', async () => {
        const bot = await makeBot('movedbot');
        expect((await post(bot.token, 'claude-code', 'one')).status).toBe(201);
        expect((await post(bot.token, 'codex-mcp-client', 'two')).status).toBe(403);

        const path = `/servers/${serverId}/bots/${bot.id}/tokens/${bot.tokenId}/binding`;
        expect((await ctx.request.delete(path).set(member.auth)).status).toBe(403);
        const cleared = await ctx.request.delete(path).set(owner.auth);
        expect(cleared.status).toBe(200);
        expect(cleared.body).toEqual({ cleared: true });
        expect(await audits(bot.id, 'bot_token_binding_clear')).toEqual([{ tokenId: bot.tokenId, boundClient: 'claude-code' }]);
        expect((await tokens(bot.id))[0]).toMatchObject({ boundClient: null, lastRefused: null });

        expect((await post(bot.token, 'codex-mcp-client', 'three')).status).toBe(201);
        expect((await tokens(bot.id))[0].boundClient).toBe('codex-mcp-client');
        expect((await post(bot.token, 'claude-code', 'four')).status).toBe(403);

        expect((await ctx.request.delete(`/servers/${serverId}/bots/${bot.id}/tokens/01ARZ3NDEKTSV4RRFFQ69G5FAV/binding`).set(owner.auth)).status).toBe(404);
    });

    it('moving a host profile to another CLI clears its bot\'s binding, so the owner\'s own move is not refused', async () => {
        const bot = await makeBot('hostedbot');
        const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'bind-host' });
        expect(host.status).toBe(201);
        const profile = await ctx.request.post(`/servers/${serverId}/agent-profiles`).set(owner.auth)
            .send({ name: 'hosted', botId: bot.id, hostId: host.body.host.id, adapter: 'claude', workdirAlias: 'agora' });
        expect(profile.status, JSON.stringify(profile.body)).toBe(201);
        expect((await post(bot.token, 'claude-code', 'as claude')).status).toBe(201);

        const moved = await ctx.request.patch(`/servers/${serverId}/agent-profiles/${profile.body.id}`).set(owner.auth).send({ adapter: 'codex' });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        expect((await tokens(bot.id))[0].boundClient).toBeNull();
        expect(await audits(bot.id, 'bot_token_binding_clear')).toEqual([expect.objectContaining({ tokenId: bot.tokenId, via: 'profile adapter change' })]);
        expect((await post(bot.token, 'codex-mcp-client', 'as codex')).status).toBe(201);
    });

    it('two first uses from different clients at once: exactly one binds, the other is refused', async () => {
        const bot = await makeBot('racebot');
        const [a, b] = await Promise.all([
            ctx.request.get('/bots/@me').set(as(bot.token, 'claude-code')),
            ctx.request.get('/bots/@me').set(as(bot.token, 'codex-mcp-client')),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 403]);
        expect(await audits(bot.id, 'bot_token_bound')).toHaveLength(1);
    });
});

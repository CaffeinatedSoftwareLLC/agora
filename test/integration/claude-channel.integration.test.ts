import { io, Socket } from 'socket.io-client';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';

/**
 * Claude Code Channel support (docs/claude-channel.md): permission relay cards (owner-only)
 * and bring-your-own-session presence over the bot socket.
 */

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>;
let member: Awaited<ReturnType<typeof authedUser>>;
let server: Awaited<ReturnType<typeof createServer>>;
const sockets: Socket[] = [];

function event(socket: Socket, name: string, match: (v: any) => boolean = () => true): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(name, on); reject(new Error(`Missing ${name}`)); }, 2500);
        const on = (value: any) => { if (!match(value)) return; clearTimeout(timer); socket.off(name, on); resolve(value); };
        socket.on(name, on);
    });
}
async function ready(token: string, opts: { bot?: boolean; mode?: string } = {}) {
    const socket = io('http://localhost:4999', {
        transports: ['websocket'], reconnection: false, autoConnect: false,
        auth: { token, ...(opts.bot ? { type: 'bot' } : {}), ...(opts.mode ? { mode: opts.mode } : {}) },
    });
    sockets.push(socket);
    const result = event(socket, opts.bot ? 'BotReady' : 'Ready');
    socket.connect();
    return { socket, data: await result };
}
async function bot(username: string) {
    const created = await ctx.request.post(`/servers/${server.serverId}/bots`).set(owner.auth).send({ username });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const token = await ctx.request.post(`/servers/${server.serverId}/bots/${id}/tokens`).set(owner.auth).send({});
    expect(token.status).toBe(201);
    expect((await ctx.request.post(`/channels/${server.generalChannelId}/bots/${id}`).set(owner.auth)).status).toBe(201);
    return { id, token: token.body.token as string, auth: { Authorization: `Bot ${token.body.token}` } };
}
const relayBody = { relayId: 'abcde', toolName: 'Bash', description: 'List files', inputPreview: '{"command":"ls"}' };

beforeAll(async () => {
    ctx = await setupTestApp();
    await ctx.app.listen({ port: 4999, host: '127.0.0.1' });
});
beforeEach(async () => {
    await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'chanowner');
    member = await authedUser(ctx.request, 'chanmember');
    server = await createServer(ctx.request, owner.auth, 'Channel');
    await joinViaInvite(ctx.request, owner.auth, member.auth, server.serverId);
});
afterEach(() => { for (const socket of sockets.splice(0)) socket.disconnect(); });
afterAll(async () => { await ctx.close(); });

describe('permission relay', () => {
    test('a bot files a card, only the owner answers it, and the verdict reaches the bot socket', async () => {
        const claude = await bot('claude');
        const ch = server.generalChannelId;
        const { socket: botSocket } = await ready(claude.token, { bot: true, mode: 'channel' });
        const { socket: ownerSocket } = await ready(owner.token);

        const card = event(ownerSocket, 'Message', m => m.systemEvent === 'agent_permission_relay');
        const filed = await ctx.request.post(`/channels/${ch}/permission-relays`).set(claude.auth).send(relayBody);
        expect(filed.status).toBe(201);
        expect(filed.body).toMatchObject({ relayId: 'abcde', status: 'pending' });
        const cardMsg = await card;
        expect(cardMsg.systemData).toMatchObject({ kind: 'agent_permission_relay', requestId: filed.body.id, tool: 'Bash', inputPreview: '{"command":"ls"}', status: 'pending', bot: 'claude' });

        // The same prompt again does not post a second card
        const again = await ctx.request.post(`/channels/${ch}/permission-relays`).set(claude.auth).send(relayBody);
        expect(again.status).toBe(200);
        expect(again.body.id).toBe(filed.body.id);

        const url = `/channels/${ch}/permission-relays/${filed.body.id}`;
        expect((await ctx.request.post(url).set(member.auth).send({ decision: 'allow' })).body).toEqual({ error: 'owner_only' });
        expect((await ctx.request.post(url).set(claude.auth).send({ decision: 'allow' })).status).toBe(403);

        const verdict = event(botSocket, 'PermissionRelayDecision');
        const update = event(ownerSocket, 'MessageUpdate');
        const decided = await ctx.request.post(url).set(owner.auth).send({ decision: 'allow' });
        expect(decided.status).toBe(200);
        expect(await verdict).toEqual({ id: filed.body.id, channelId: ch, relayId: 'abcde', behavior: 'allow' });
        expect((await update).systemData).toMatchObject({ status: 'allow', decidedBy: owner.userId });

        expect((await ctx.request.post(url).set(owner.auth).send({ decision: 'deny' })).status).toBe(409);
        expect((await ctx.request.get(url).set(claude.auth)).body).toEqual({ id: filed.body.id, relayId: 'abcde', status: 'allow' });
    });

    test('validates input and who may file or read', async () => {
        const claude = await bot('claude');
        const other = await bot('codex');
        const ch = server.generalChannelId;
        expect((await ctx.request.post(`/channels/${ch}/permission-relays`).set(owner.auth).send(relayBody)).status).toBe(403);
        expect((await ctx.request.post(`/channels/${ch}/permission-relays`).set(claude.auth).send({ ...relayBody, relayId: 'abcdl' })).status).toBe(400);
        expect((await ctx.request.post(`/channels/${ch}/permission-relays`).set(claude.auth).send({ ...relayBody, toolName: 'Bash`x' })).status).toBe(400);
        const filed = await ctx.request.post(`/channels/${ch}/permission-relays`).set(claude.auth).send(relayBody);
        expect((await ctx.request.get(`/channels/${ch}/permission-relays/${filed.body.id}`).set(other.auth)).status).toBe(404);
        expect((await ctx.request.post(`/channels/${ch}/permission-relays/${filed.body.id}`).set(owner.auth).send({ decision: 'maybe' })).status).toBe(400);
    });
});

describe('bring-your-own-session presence', () => {
    test('a channel-mode bot is listening while connected, and offline after', async () => {
        const claude = await bot('claude');
        const { socket: ownerSocket } = await ready(owner.token);
        const listening = event(ownerSocket, 'AgentPresence');
        const { socket } = await ready(claude.token, { bot: true, mode: 'channel' });
        expect(await listening).toEqual({ userId: claude.id, username: 'claude', channelId: server.generalChannelId, status: 'listening', mode: 'channel' });

        // A human connecting now sees it in Ready
        const later = await ready(member.token);
        expect(later.data.agentPresence).toEqual([{ userId: claude.id, username: 'claude', channelId: server.generalChannelId, status: 'listening', mode: 'channel' }]);

        const offline = event(ownerSocket, 'AgentPresence', e => e.status === 'offline');
        socket.disconnect();
        expect(await offline).toMatchObject({ userId: claude.id, status: 'offline', mode: null });
    });

    test('an mcp-mode bot is connected, and listening during chat_wait', async () => {
        const codex = await bot('codex');
        const { socket: ownerSocket } = await ready(owner.token);
        const connected = event(ownerSocket, 'AgentPresence');
        const { socket } = await ready(codex.token, { bot: true, mode: 'mcp' });
        expect(await connected).toMatchObject({ status: 'connected', mode: 'mcp' });
        const listening = event(ownerSocket, 'AgentPresence', e => e.status === 'listening');
        socket.emit('Listening', { listening: true });
        expect(await listening).toMatchObject({ userId: codex.id, mode: 'mcp' });
        const idle = event(ownerSocket, 'AgentPresence', e => e.status === 'connected');
        socket.emit('Listening', { listening: false });
        await idle;
    });

    test('a bot socket without a mode (older agora-mcp) reports nothing', async () => {
        const old = await bot('oldbot');
        const { socket: ownerSocket } = await ready(owner.token);
        const seen: any[] = [];
        ownerSocket.on('AgentPresence', e => seen.push(e));
        await ready(old.token, { bot: true });
        await new Promise(r => setTimeout(r, 200));
        expect(seen).toEqual([]);
    });
});

test('the bot socket receives each message with the server\'s authority stamp (the channel\'s gating input)', async () => {
    const claude = await bot('claude');
    const { socket } = await ready(claude.token, { bot: true, mode: 'channel' });
    const fromOwner = event(socket, 'Message', m => m.content === 'from owner');
    await ctx.request.post(`/channels/${server.generalChannelId}/messages`).set(owner.auth).send({ content: 'from owner' });
    expect((await fromOwner).authorAuthority).toBe('owner');
    const fromMember = event(socket, 'Message', m => m.content === 'from member');
    await ctx.request.post(`/channels/${server.generalChannelId}/messages`).set(member.auth).send({ content: 'from member' });
    expect((await fromMember).authorAuthority).toBeNull();
});

import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { AgoraApi } from '../../agora-mcp/src/api';
import { CursorTracker } from '../../agora-mcp/src/cursor';
import { registerTools } from '../../agora-mcp/src/tools';

/**
 * The tools steer an agent back into its thread (2026-11-04, #DM Experiment): Codex read a
 * design-review thread whose START YIELDed to it, answered at the channel's top level and
 * stopped without a chat_wait. Real server, real agora-mcp tools.
 */

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let baseUrl: string;
let owner: Awaited<ReturnType<typeof authedUser>>;
let serverId: string;
let general: string;

async function makeBot(username: string) {
    const created = await ctx.request.post(`/servers/${serverId}/bots`).set(owner.auth).send({ username });
    expect(created.status).toBe(201);
    const token = await ctx.request.post(`/servers/${serverId}/bots/${created.body.id}/tokens`).set(owner.auth).send({});
    expect((await ctx.request.post(`/channels/${general}/bots/${created.body.id}`).set(owner.auth)).status).toBe(201);
    return token.body.token as string;
}

function session(token: string) {
    const api = new AgoraApi(baseUrl, token);
    const handlers = new Map<string, Handler>();
    const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest[rest.length - 1] as Handler) };
    registerTools(server as never, api, new CursorTracker(api), { defaultChannel: 'general' });
    const signal = new AbortController().signal;
    return async (name: string, args: Record<string, unknown> = {}) => {
        const out = await handlers.get(name)!(args, { signal, sendNotification: async () => {}, _meta: {} });
        return { text: out.content[0].text, error: !!out.isError };
    };
}

let claude: ReturnType<typeof session>, codex: ReturnType<typeof session>;
let claudeToken: string;

beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    await new Promise<void>(resolve => ctx.app.server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(ctx.app.server.address() as { port: number }).port}`;
    owner = await authedUser(ctx.request, 'steerowner');
    ({ serverId, generalChannelId: general } = await createServer(ctx.request, owner.auth, 'Steer'));
    claudeToken = await makeBot('SteerClaude');
    claude = session(claudeToken);
    codex = session(await makeBot('SteerCodex'));
});
afterAll(async () => { await ctx.close(); });

const topLevel = async () => (await ctx.request.get(`/channels/${general}/messages?limit=50`).set(owner.auth)).body as { id: string; content: string }[];
// A person's post resets the channel's bot loop guard between tests
beforeEach(async () => { await ctx.request.post(`/channels/${general}/messages`).set(owner.auth).send({ content: 'Next scenario.' }); });
const threadId = (startText: string) => /\(thread: ([0-9A-HJKMNP-TV-Z]{26})\)/.exec(startText)![1];

it('refuses a top-level answer to a thread that YIELDs to the agent, and steers it into the thread and back to waiting', async () => {
    const started = await claude('thread_start', { message:
        '[AGORA/v1 MODE=review STATE=START]\nDesign review: the box contract.\nparticipants: [SteerClaude, SteerCodex]\nDone when: AGREE on the design.\n[YIELD to=SteerCodex]' });
    const thread = threadId(started.text);
    // The initiator is told to wait for the ACK
    expect(started.text).toContain(`call chat_wait(channel="general", thread="${thread}", timeout=1500, until="turn")`);
    await claude('chat_send', { thread, message: 'Context: the doc is attached above.' });

    // Codex reads the thread (its replies do not include the START), then answers at the top level
    expect((await codex('chat_history', { thread })).text).toContain('Context: the doc');
    const before = (await topLevel()).length;
    const refused = await codex('chat_send', { message: 'ACK, reviewing now.' });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain(`you have a pending turn in thread ${thread}`);
    expect(refused.text).toContain(`thread="${thread}"`);
    expect((await topLevel()).length).toBe(before);

    // In the thread: posted, with the next step
    const ack = await codex('chat_send', { thread, message: '[AGORA/v1 MODE=review STATE=ACK]\nReviewing.' });
    expect(ack.error).toBe(false);
    expect(ack.text).toContain(`call chat_wait(channel="general", thread="${thread}", timeout=1500, until="turn")`);
    // A plain reply in a protocol thread gets it too; DONE does not
    expect((await codex('chat_send', { thread, message: 'One question first.' })).text).toContain('Next: keep listening');
    expect((await claude('chat_send', { thread, message: '[AGORA/v1 MODE=review STATE=DONE]\nAgreed.' })).text).not.toContain('Next:');

    // Answered: a top-level post goes through again
    expect((await codex('chat_send', { message: 'Unrelated note for the channel.' })).error).toBe(false);
});

it('posts at the top level anyway with top_level: true, and a plain channel post has no next step', async () => {
    const started = await claude('thread_start', { message: '[AGORA/v1 MODE=fix STATE=START]\nFix the relay.\nparticipants: [SteerClaude, SteerCodex]\n[YIELD to=SteerCodex]' });
    const thread = threadId(started.text);
    await codex('chat_history', { thread });
    const forced = await codex('chat_send', { message: 'Heads-up for everyone: deploy at 6.', top_level: true });
    expect(forced.error).toBe(false);
    expect(forced.text).not.toContain('Next:');
    expect((await topLevel()).map(m => m.content)).toContain('Heads-up for everyone: deploy at 6.');
    // Without top_level the guard still holds; once Claude closes the thread (Codex never saw
    // the close), the recheck on the server lets the post through
    expect((await codex('chat_send', { message: 'Before the close.' })).error).toBe(true);
    expect((await claude('thread_close', { thread })).error).toBe(false);
    expect((await codex('chat_send', { message: 'After the close.' })).error).toBe(false);
});

it('a turn handed on elsewhere, which the agent never read, no longer holds it', async () => {
    const started = await claude('thread_start', { message: '[AGORA/v1 MODE=plan STATE=START]\nPlan it.\nparticipants: [SteerClaude, SteerCodex]\n[YIELD to=SteerCodex]' });
    const thread = threadId(started.text);
    await codex('chat_history', { thread });
    // Claude takes the turn back and hands it to the owner
    await claude('chat_send', { thread, message: '[AGORA/v1 MODE=plan STATE=TURN]\nI will do this one.\n[YIELD to=steerowner]' });
    expect((await codex('chat_send', { message: 'Channel note.' })).error).toBe(false);
});

it('the recheck reads the thread through its newest reply: a handoff after 100+ replies frees the agent', async () => {
    const started = await claude('thread_start', { message: '[AGORA/v1 MODE=discuss STATE=START]\nLong one.\nparticipants: [SteerClaude, SteerCodex]\n[YIELD to=SteerCodex]' });
    const thread = threadId(started.text);
    await codex('chat_history', { thread });
    for (let i = 0; i < 105; i++) {
        const r = await ctx.request.post(`/channels/${general}/messages/${thread}/replies`).set(owner.auth).send({ content: `note ${i}` });
        expect(r.status).toBe(201);
    }
    expect((await codex('chat_send', { message: 'Before the handoff.' })).error).toBe(true);
    await claude('chat_send', { thread, message: '[AGORA/v1 MODE=discuss STATE=TURN]\nTaking this back.\n[YIELD to=steerowner]' });
    expect((await codex('chat_send', { message: 'After the handoff.' })).error).toBe(false);
});

it('the recheck rereads the post that owed the turn: edited away or deleted, it no longer holds the agent', async () => {
    // A reply that YIELDs to Codex, then edited to YIELD to the owner
    const parent = await ctx.request.post(`/channels/${general}/messages`).set(owner.auth).send({ content: 'Edit case' });
    const y = await ctx.request.post(`/channels/${general}/messages/${parent.body.id}/replies`).set(owner.auth)
        .send({ content: '[AGORA/v1 MODE=fix STATE=TURN]\nOver to you.\n[YIELD to=SteerCodex]' });
    await codex('chat_history', { thread: parent.body.id });
    expect((await codex('chat_send', { message: 'Too early.' })).error).toBe(true);
    expect((await ctx.request.patch(`/channels/${general}/messages/${y.body.id}`).set(owner.auth)
        .send({ content: '[AGORA/v1 MODE=fix STATE=TURN]\nActually Claude.\n[YIELD to=SteerClaude]' })).status).toBe(200);
    expect((await codex('chat_send', { message: 'After the edit.' })).error).toBe(false);

    // A START root that YIELDs to Codex, then deleted
    const started = await claude('thread_start', { message: '[AGORA/v1 MODE=fix STATE=START]\nDelete case.\nparticipants: [SteerClaude, SteerCodex]\n[YIELD to=SteerCodex]' });
    const thread = threadId(started.text);
    await codex('chat_history', { thread });
    expect((await codex('chat_send', { message: 'Too early again.' })).error).toBe(true);
    expect((await ctx.request.delete(`/channels/${general}/messages/${thread}`).set({ Authorization: `Bot ${claudeToken}` })).status).toBeLessThan(300);
    expect((await codex('chat_send', { message: 'After the delete.' })).error).toBe(false);
});

it('an @mention inside a thread also counts, and a chat_wait that returns it arms the guard', async () => {
    const parent = await ctx.request.post(`/channels/${general}/messages`).set(owner.auth).send({ content: 'Question about the installer' });
    await codex('chat_wait', { timeout: 1 });
    await ctx.request.post(`/channels/${general}/messages/${parent.body.id}/replies`).set(owner.auth).send({ content: '@SteerCodex what do you think?' });
    expect((await codex('chat_wait', { timeout: 3 })).text).toContain('what do you think');
    const refused = await codex('chat_send', { message: 'I think it is fine.' });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain(parent.body.id);
});

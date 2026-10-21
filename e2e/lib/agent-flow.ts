/**
 * API-only steps for the agent E2E (beta-test-plan §3.2): channels holding the run's agents,
 * /start, posts, and waiting for the run a post caused. Everything is asserted by structure
 * (who posted, where, which run, which files), never by model wording.
 */
import type { Api } from './api';
import type { AgentHost } from './agent-host';
import { messages, replies, sessionOf, trimId } from './agents';
import { waitFor } from './fake-host';
import type { Seed } from './seed-types';

export interface Flow {
    ah: AgentHost; seed: Seed; owner: Api; fake: boolean;
    /** How long one run may take to finish (run timeout 300 s plus the claim poll). */
    runWait: number;
    /** Channels the current scenario created (its tokens are counted from their sessions). */
    channels: string[];
}

/** A run-tagged channel with these agents' bots in it; recorded for the scenario's usage row. */
export async function liveChannel(f: Flow, label: string, keys: string[]): Promise<{ id: string; name: string }> {
    const name = `${label}-${f.ah.tag}`;
    const id: string = trimId(((await f.owner.ok('POST', `/servers/${f.seed.serverId}/channels`, { name, channelType: 3 }, [201])) as any).id);
    for (const k of keys) await f.owner.ok('POST', `/channels/${id}/bots/${f.ah.agents[k].botId}`, undefined, [200, 201]);
    f.channels.push(id);
    return { id, name };
}

export async function latestRunId(owner: Api, channelId: string, profile: string, sessionId: string): Promise<string | null> {
    return (await sessionOf(owner, channelId, profile, sessionId))?.run?.id ?? null;
}

/** Wait for a run other than `prevRunId` to be reported (not claimed any more); returns the session. */
export async function waitRunAfter(f: Flow, channelId: string, profile: string, sessionId: string, prevRunId: string | null, what = `${profile} run`): Promise<any> {
    return waitFor(what, async () => {
        const s = await sessionOf(f.owner, channelId, profile, sessionId);
        return s && s.run && s.run.id !== prevRunId && s.run.status !== 'claimed' && !s.running ? s : null;
    }, f.runWait, 2000);
}

/** No run starts for this session within `ms` (a refusal leaves nothing behind). */
export async function expectNoRun(f: Flow, channelId: string, profile: string, sessionId: string, prevRunId: string | null, ms = 12_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const s = await sessionOf(f.owner, channelId, profile, sessionId);
        if ((s?.run?.id ?? null) !== prevRunId || s?.running) throw new Error(`a run started for ${profile}: ${s?.run?.id}`);
        await new Promise(r => setTimeout(r, 1500));
    }
}

/** POST a message (or a thread reply) as `as` (default the owner). */
export async function post(f: Flow, channelId: string, content: string, opts: { as?: Api; thread?: string; attachments?: string[] } = {}): Promise<any> {
    const api = opts.as ?? f.owner;
    const body = { content, ...(opts.attachments ? { attachments: opts.attachments } : {}) };
    const r = opts.thread
        ? await api.ok('POST', `/channels/${channelId}/messages/${opts.thread}/replies`, body, [201])
        : await api.ok('POST', `/channels/${channelId}/messages`, body, [201]);
    return r;
}

/** Bot posts in the channel (or one thread) newer than `afterId`, oldest first. */
export async function botPostsAfter(owner: Api, channelId: string, botId: string, afterId: string, thread?: string): Promise<any[]> {
    const list = thread ? await replies(owner, channelId, thread) : await messages(owner, channelId, 100);
    return list.filter(m => trimId(m.authorId) === botId && trimId(m.id) > trimId(afterId)).sort((a, b) => (trimId(a.id) < trimId(b.id) ? -1 : 1));
}

/** /start (API) and wait for the agent's first run and its first post in the channel. */
export async function startAgent(f: Flow, channelId: string, key: string): Promise<{ sid: string; session: any; hello: any }> {
    const a = f.ah.agents[key];
    const before = (await messages(f.owner, channelId, 5))[0];
    const r = (await f.owner.ok('POST', `/channels/${channelId}/agent-commands`, { command: 'start', profile: a.name }, [201])) as any;
    const sid = trimId(r.session.id);
    const session = await waitRunAfter(f, channelId, a.name, sid, null, `${a.name} first run`);
    const hello = await waitFor(`${a.name} hello post`, async () => (await botPostsAfter(f.owner, channelId, a.botId, trimId(before?.id ?? '0')))[0], 15_000, 1000);
    return { sid, session, hello };
}

/**
 * Post `text` (plus fake-CLI directives in fake mode only) and wait for the run it causes.
 * Returns the finished session and the bot's posts after the message.
 */
export async function ask(f: Flow, channelId: string, key: string, sid: string, text: string,
    opts: { fakeDirectives?: string; as?: Api; thread?: string; attachments?: string[] } = {}): Promise<{ msg: any; session: any; posts: any[] }> {
    const a = f.ah.agents[key];
    const prev = await latestRunId(f.owner, channelId, a.name, sid);
    const content = f.fake && opts.fakeDirectives ? `${text} ${opts.fakeDirectives}` : text;
    const msg = await post(f, channelId, content, opts);
    const session = await waitRunAfter(f, channelId, a.name, sid, prev);
    const posts = await botPostsAfter(f.owner, channelId, a.botId, trimId(msg.id), opts.thread);
    return { msg, session, posts };
}

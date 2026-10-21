import sharp from 'sharp';
import { setupTestApp, authedUser, createServer, joinViaInvite, cleanDatabase } from '../helpers';
import { Permissions } from '../../src/permissions';
import { previewMessage, previewUrl } from '../../src/routes/browser-previews';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof authedUser>>, member: typeof owner, outsider: typeof owner;
let serverId: string, channel: string, second: string, hostId: string, sessionId: string, botId: string;
let hostAuth: Record<string, string>, otherHostAuth: Record<string, string>, botAuth: Record<string, string>;
let png: Buffer;

const post = (body: object, auth: object = owner.auth, ch = channel) => ctx.request.post(`/channels/${ch}/messages`).set(auth).send(body);
const artifactPath = (id: string, ch = channel) => `/channels/${ch}/artifacts/${id}`;
const page = '<!doctype html><h1>Hello</h1><script>document.body.append("ran")</script>';

beforeAll(async () => {
    ctx = await setupTestApp(); await cleanDatabase(ctx.db);
    owner = await authedUser(ctx.request, 'canvasowner'); member = await authedUser(ctx.request, 'canvasmember'); outsider = await authedUser(ctx.request, 'canvasoutsider');
    const server = await createServer(ctx.request, owner.auth, 'Canvas'); serverId = server.serverId; channel = server.generalChannelId;
    await joinViaInvite(ctx.request, owner.auth, member.auth, serverId);
    second = (await ctx.request.post(`/servers/${serverId}/channels`).set(owner.auth).send({ name: 'other', channelType: 3 })).body.id;
    const host = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'preview-host' });
    hostId = host.body.host.id; hostAuth = { Authorization: `AgentHost ${host.body.token}` };
    const other = await ctx.request.post(`/servers/${serverId}/agent-hosts`).set(owner.auth).send({ name: 'other-host' });
    otherHostAuth = { Authorization: `AgentHost ${other.body.token}` };
    const agent = await ctx.request.post(`/servers/${serverId}/agents`).set(owner.auth).send({ name: 'builder', hostId, adapter: 'claude', workdirAlias: 'agora', channelId: channel });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    botId = agent.body.bot.id; botAuth = { Authorization: `Bot ${agent.body.token}` };
    png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#336699' } }).png().toBuffer();
});
afterAll(async () => { await ctx.close(); });

describe('canvas artifacts', () => {
    it('posts an artifact without text, lists it with the message and serves its content', async () => {
        const res = await post({ artifact: { title: 'Landing page', kind: 'html', content: page } });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.content).toBeNull();
        expect(res.body.artifact).toMatchObject({ title: 'Landing page', kind: 'html', version: 1, latestVersion: 1 });
        const id = res.body.artifact.id;

        const list = await ctx.request.get(`/channels/${channel}/messages`).set(member.auth);
        expect(list.body.find((m: any) => m.id === res.body.id).artifact).toMatchObject({ id, version: 1 });
        const meta = await ctx.request.get(artifactPath(id)).set(member.auth);
        expect(meta.status).toBe(200);
        expect(meta.body).toMatchObject({ id, title: 'Landing page', kind: 'html', latestVersion: 1 });
        expect(meta.body.versions).toEqual([expect.objectContaining({ version: 1, messageId: res.body.id, authorUsername: 'canvasowner', size: page.length })]);
        expect(meta.body.versions[0].content).toBeUndefined();
        const v1 = await ctx.request.get(`${artifactPath(id)}/versions/1`).set(member.auth);
        expect(v1.body).toMatchObject({ artifactId: id, version: 1, kind: 'html', content: page });
        const all = await ctx.request.get(`/channels/${channel}/artifacts`).set(member.auth);
        expect(all.body.artifacts[0]).toMatchObject({ id, title: 'Landing page', latestVersion: 1, createdByUsername: 'canvasowner' });
    });

    it('adds versions by artifact ID, keeping the title unless a new one is given', async () => {
        const first = (await post({ content: 'diagram', artifact: { title: 'Flow', kind: 'mermaid', content: 'graph TD; A-->B' } })).body;
        const id = first.artifact.id;
        const v2 = await post({ content: 'now with C', artifact: { id, content: 'graph TD; A-->B; B-->C' } }, botAuth);
        expect(v2.status, JSON.stringify(v2.body)).toBe(201);
        expect(v2.body.artifact).toEqual({ id, version: 2, title: 'Flow', kind: 'mermaid', latestVersion: 2 });
        const v3 = await post({ artifact: { id, title: 'Flow as SVG', kind: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' } });
        expect(v3.body.artifact).toMatchObject({ version: 3, title: 'Flow as SVG', kind: 'svg' });
        const meta = (await ctx.request.get(artifactPath(id)).set(owner.auth)).body;
        expect(meta.versions.map((v: any) => [v.version, v.kind])).toEqual([[3, 'svg'], [2, 'mermaid'], [1, 'mermaid']]);
        expect(meta.versions[1].authorBot).toBe(true);
        // Older posts report the newest version so the card can say "v1 of 3"
        const list = (await ctx.request.get(`/channels/${channel}/messages`).set(owner.auth)).body;
        expect(list.find((m: any) => m.id === first.id).artifact).toMatchObject({ version: 1, latestVersion: 3 });
    });

    it('refuses a bad artifact before anything is posted', async () => {
        const before = (await ctx.db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
        const other = (await post({ artifact: { title: 'Elsewhere', kind: 'markdown', content: '# hi' } }, owner.auth, second)).body.artifact.id;
        expect((await post({ content: 'x', artifact: { id: other, content: '# moved' } })).status).toBe(404);
        expect((await post({ artifact: { content: '# no title' } })).body.error).toBe('artifact_title_and_kind_required');
        expect((await post({ artifact: { title: 'T', kind: 'pdf', content: 'x' } })).status).toBe(400);
        expect((await post({ artifact: { title: 'T', kind: 'html', content: 'x'.repeat(200_001) } })).status).toBe(400);
        expect((await post({ artifact: { title: '\u001b[2J', kind: 'html', content: 'x' } })).body.error).toBe('empty_artifact_title');
        // Only the one artifact in the other channel was posted
        expect((await ctx.db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(before + 1);
    });

    it('cleans titles and content like message text', async () => {
        const res = await post({ artifact: { title: 'Line one\nline two', kind: 'markdown',
            content: '# Keys\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n' } });
        expect(res.body.artifact.title).toBe('Line one line two');
        const v = await ctx.request.get(`${artifactPath(res.body.artifact.id)}/versions/1`).set(owner.auth);
        expect(v.body.content).toBe('# Keys\n[private key redacted]\n');
    });

    it('carries artifacts in thread replies and in client_key replays', async () => {
        const parent = (await post({ content: 'thread' })).body;
        const replyBody = { content: 'see canvas', client_key: 'k1', artifact: { title: 'Notes', kind: 'markdown', content: '# Notes' } };
        const reply = await ctx.request.post(`/channels/${channel}/messages/${parent.id}/replies`).set(owner.auth).send(replyBody);
        expect(reply.status, JSON.stringify(reply.body)).toBe(201);
        expect(reply.body.artifact).toMatchObject({ title: 'Notes', version: 1 });
        const again = await ctx.request.post(`/channels/${channel}/messages/${parent.id}/replies`).set(owner.auth).send(replyBody);
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ id: reply.body.id, replayed: true, artifact: { id: reply.body.artifact.id, version: 1 } });
        const replies = await ctx.request.get(`/channels/${channel}/messages/${parent.id}/replies`).set(member.auth);
        expect(replies.body[0].artifact.id).toBe(reply.body.artifact.id);
        const meta = await ctx.request.get(artifactPath(reply.body.artifact.id)).set(member.auth);
        expect(meta.body.versions[0].threadId).toBe(parent.id);
    });

    it('needs channel access, and only finds an artifact in its own channel', async () => {
        const id = (await post({ artifact: { title: 'Private', kind: 'svg', content: '<svg/>' } })).body.artifact.id;
        expect((await ctx.request.get(artifactPath(id)).set(outsider.auth)).status).toBe(403);
        expect((await ctx.request.get(`${artifactPath(id)}/versions/1`).set(outsider.auth)).status).toBe(403);
        expect((await ctx.request.get(`/channels/${channel}/artifacts`).set(outsider.auth)).status).toBe(403);
        expect((await ctx.request.get(artifactPath(id, second)).set(owner.auth)).status).toBe(404);
        expect((await ctx.request.get(`${artifactPath(id)}/versions/9`).set(owner.auth)).status).toBe(404);
    });

    it('deletes a version with its post and the artifact with its last version; numbers are not reused', async () => {
        const a = (await post({ artifact: { title: 'Doc', kind: 'markdown', content: 'one' } })).body;
        const b = (await post({ artifact: { id: a.artifact.id, content: 'two' } })).body;
        expect((await ctx.request.delete(`/channels/${channel}/messages/${b.id}`).set(owner.auth)).status).toBe(200);
        const meta = (await ctx.request.get(artifactPath(a.artifact.id)).set(owner.auth)).body;
        expect(meta.versions.map((v: any) => v.version)).toEqual([1]);
        expect((await ctx.request.get(`${artifactPath(a.artifact.id)}/versions/2`).set(owner.auth)).status).toBe(404);
        const c = (await post({ artifact: { id: a.artifact.id, content: 'three' } })).body;
        expect(c.artifact.version).toBe(3);
        await ctx.request.delete(`/channels/${channel}/messages/${a.id}`).set(owner.auth);
        await ctx.request.delete(`/channels/${channel}/messages/${c.id}`).set(owner.auth);
        expect((await ctx.request.get(artifactPath(a.artifact.id)).set(owner.auth)).status).toBe(404);
    });
});

describe('browser previews', () => {
    const queue = (body: object, auth: object = botAuth) => ctx.request.post(`/channels/${channel}/browser-previews`).set(auth).send(body);
    const next = (auth = hostAuth) => ctx.request.get('/agent-hosts/@me/browser-previews/next').set(auth);
    const result = (claim: any, fields: Record<string, string>, image?: Buffer, auth = hostAuth) => {
        let req = ctx.request.post(`/agent-hosts/@me/browser-previews/${claim.id}/result`).set(auth).field('claimToken', claim.claimToken);
        for (const [k, v] of Object.entries(fields)) if (v) req = req.field(k, v);
        return image ? req.attach('screenshot', image, 'shot.png') : req;
    };

    beforeEach(async () => {
        await ctx.db.query('TRUNCATE agent_sessions CASCADE');
        await ctx.db.query('TRUNCATE channel_member_overrides');
        await ctx.db.query('UPDATE agent_hosts SET revoked_at = NULL');
        const start = await ctx.request.post(`/channels/${channel}/agent-commands`).set(owner.auth).send({ command: 'start', profile: 'builder' });
        expect(start.status, JSON.stringify(start.body)).toBe(201);
        sessionId = start.body.session.id;
    });

    it('accepts only loopback http(s) URLs with an explicit port', () => {
        expect(previewUrl('http://localhost:5173/app?x=1')).toBe('http://localhost:5173/app?x=1');
        expect(previewUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
        expect(previewUrl('http://[::1]:8080/')).toBe('http://[::1]:8080/');
        for (const bad of ['http://localhost/', 'https://example.com:443/', 'file:///etc/passwd', 'http://user:pw@localhost:3000/',
            'http://localhost.evil.com:80/', 'http://0.0.0.0:3000/', 'javascript:alert(1)', 'not a url']) expect(previewUrl(bad), bad).toBeNull();
    });

    // beta-test-plan §6.2 "Preview port isolation", server side: fixed code, nothing queued
    it('refuses a URL off loopback, with credentials or without a port: 400 url_not_allowed, nothing queued', async () => {
        for (const url of ['https://example.com:443/', 'http://192.168.1.10:8080/', 'http://10.0.0.5:3000/', 'http://user:pw@localhost:3000/',
            'http://:pw@127.0.0.1:3000/', 'http://localhost/', 'https://127.0.0.1/', 'http://localhost.evil.com:80/', 'http://0.0.0.0:3000/',
            'file:///etc/passwd', 'javascript:alert(1)']) {
            for (const auth of [botAuth, owner.auth]) {
                const res = await queue(auth === owner.auth ? { url, sessionId } : { url }, auth);
                expect(res.status, url).toBe(400);
                expect(res.body.error, url).toBe('url_not_allowed');
            }
        }
        expect((await ctx.db.query('SELECT count(*)::int AS n FROM browser_previews WHERE session_id = $1', [sessionId])).rows[0].n).toBe(0);
        expect((await next()).status).toBe(204);
    });

    it('lets an agent preview its own session, and a director any session; one at a time', async () => {
        expect((await queue({ url: 'https://example.com:443/' })).status).toBe(400);
        expect((await queue({ url: 'http://localhost:5173/' }, outsider.auth)).status).toBe(403);
        expect((await queue({ url: 'http://localhost:5173/', sessionId }, member.auth)).body.error).toBe('cannot_direct');
        expect((await queue({ url: 'http://localhost:5173/' }, owner.auth)).body.error).toBe('session_required');
        const q = await queue({ url: 'http://localhost:5173/', width: 390, height: 844 });
        expect(q.status, JSON.stringify(q.body)).toBe(202);
        expect(q.body).toMatchObject({ sessionId, status: 'queued' });
        expect((await queue({ url: 'http://localhost:5173/other' })).body.error).toBe('preview_in_progress');
        await ctx.db.query(`UPDATE browser_previews SET status = 'failed'`);
        await ctx.db.query(`INSERT INTO channel_member_overrides (channel_id, user_id, allow, deny) VALUES ($1, $2, $3, 0)`, [channel, member.userId, Permissions.DirectAgents.toString()]);
        expect((await queue({ url: 'http://localhost:5173/', sessionId }, member.auth)).status).toBe(202);
    });

    it('refuses an agent on a subscription login when someone other than the owner started the session', async () => {
        await ctx.db.query(`UPDATE agent_sessions SET started_by = $1`, [member.userId]);
        await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'subscription'`);
        expect((await queue({ url: 'http://localhost:5173/' })).body.error).toBe('subscription_owner_only');
        await ctx.db.query(`UPDATE agent_sessions SET started_by = $1`, [owner.userId]);
        expect((await queue({ url: 'http://localhost:5173/' })).status).toBe(202);
        await ctx.db.query(`UPDATE browser_previews SET status = 'failed'`);
        await ctx.db.query(`UPDATE agent_sessions SET started_by = $1`, [member.userId]);
        await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'ANTHROPIC_API_KEY'`);
        expect((await queue({ url: 'http://localhost:5173/' })).status).toBe(202);
    });

    it('lets a siwc agent preview a session its plan owner started, even when that is not the server owner', async () => {
        try {
            await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'siwc', api_key_env = NULL, plan_owner_id = $1`, [member.userId]);
            await ctx.db.query(`UPDATE agent_sessions SET started_by = $1`, [member.userId]);
            const q = await queue({ url: 'http://localhost:5173/' });
            expect(q.status, JSON.stringify(q.body)).toBe(202);
            await ctx.db.query(`UPDATE browser_previews SET status = 'failed'`);
            // The server owner is not this plan's owner
            await ctx.db.query(`UPDATE agent_sessions SET started_by = $1`, [owner.userId]);
            expect((await queue({ url: 'http://localhost:5173/' })).body.error).toBe('plan_owner_only');
        } finally {
            await ctx.db.query(`UPDATE agent_profiles SET auth_mode = 'api_key', api_key_env = 'ANTHROPIC_API_KEY', plan_owner_id = NULL`);
            await ctx.db.query(`UPDATE agent_sessions SET started_by = $1`, [owner.userId]);
        }
    });

    it('needs a live hosted session on a working host', async () => {
        await ctx.request.post(`/channels/${channel}/agent-commands`).set(owner.auth).send({ command: 'end', profile: 'builder' });
        expect((await queue({ url: 'http://localhost:5173/' })).body.error).toBe('no_live_hosted_session');
        expect((await queue({ url: 'http://localhost:5173/', sessionId }, owner.auth)).body.error).toBe('no_live_hosted_session');
        await ctx.request.post(`/channels/${channel}/agent-commands`).set(owner.auth).send({ command: 'start', profile: 'builder', fresh: true });
        await ctx.db.query('UPDATE agent_hosts SET revoked_at = NOW() WHERE id = $1', [hostId]);
        expect((await queue({ url: 'http://localhost:5173/' })).body.error).toBe('host_unavailable');
    });

    it('is claimed by the session host only, then posts the screenshot as the agent', async () => {
        const q = (await queue({ url: 'http://localhost:5173/', fullPage: true })).body;
        expect((await next(otherHostAuth)).status).toBe(204);
        const claim = (await next()).body;
        expect(claim).toMatchObject({ id: q.id, sessionId, profile: 'builder', workdirAlias: 'agora', url: 'http://localhost:5173/',
            options: { width: 1280, height: 800, fullPage: true } });
        expect((await next()).status).toBe(204);
        expect((await result({ ...claim, claimToken: 'wrong-token-123' }, { success: 'true' }, png)).status).toBe(409);
        expect((await result(claim, { success: 'true' }, png, otherHostAuth)).status).toBe(404);
        expect((await result(claim, { success: 'true' })).body.error).toBe('screenshot_required');
        expect((await result(claim, { success: 'true', console: '[]' }, Buffer.from('GIF89a not a png'))).status).toBe(415);

        const lines = [{ level: 'error', text: 'Uncaught TypeError: x is undefined' }, { level: 'warning', text: 'deprecated' }, { level: 'log', text: 'ready' }];
        const done = await result(claim, { success: 'true', title: 'My App', console: JSON.stringify(lines) }, png);
        expect(done.status, JSON.stringify(done.body)).toBe(201);
        const status = (await ctx.request.get(`/channels/${channel}/browser-previews/${q.id}`).set(member.auth)).body;
        expect(status).toMatchObject({ status: 'succeeded', messageId: done.body.messageId, fileId: done.body.fileId, result: { title: 'My App', console: lines } });
        const msg = (await ctx.request.get(`/channels/${channel}/messages`).set(member.auth)).body.find((m: any) => m.id === done.body.messageId);
        expect(msg).toMatchObject({ authorId: botId, authorBot: true });
        expect(msg.content).toContain('Browser preview of http://localhost:5173/ (“My App”). Console: 1 error(s), 1 warning(s)');
        expect(msg.content).toContain('ERROR: Uncaught TypeError');
        expect(msg.attachments).toEqual([expect.objectContaining({ id: done.body.fileId, mime: 'image/png', width: 4, height: 3 })]);
        expect((await ctx.request.get(`/files/${done.body.fileId}`).set(member.auth)).status).toBe(200);
        // The agent reads its own screenshot back through the preview (or, since #117, the file route)
        const shot = await ctx.request.get(`/channels/${channel}/browser-previews/${q.id}/screenshot`).set(botAuth).buffer(true)
            .parse((res, cb) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); });
        expect(shot.status).toBe(200);
        expect(shot.headers['content-type']).toBe('image/png');
        expect((await sharp(shot.body).metadata()).width).toBe(4);
        expect((await ctx.request.get(`/files/${done.body.fileId}`).set(botAuth)).status).toBe(200);   // the bot has access to the channel
        expect((await ctx.request.get(`/channels/${channel}/browser-previews/${q.id}/screenshot`).set(outsider.auth)).status).toBe(403);
        // A repeated report changes nothing
        expect((await result(claim, { success: 'true' }, png)).body.repeated).toBe(true);
        expect((await ctx.request.get(`/channels/${channel}/browser-previews/${q.id}`).set(outsider.auth)).status).toBe(403);
        expect((await ctx.request.get(`/channels/${second}/browser-previews/${q.id}`).set(owner.auth)).status).toBe(404);
    });

    it('posts into the thread it was asked from', async () => {
        const parent = (await post({ content: 'ui work' })).body;
        const q = (await queue({ url: 'http://127.0.0.1:4000/', threadId: parent.id })).body;
        const done = await result((await next()).body, { success: 'true' }, png);
        expect(done.status).toBe(201);
        const replies = (await ctx.request.get(`/channels/${channel}/messages/${parent.id}/replies`).set(owner.auth)).body;
        expect(replies.map((r: any) => r.id)).toEqual([done.body.messageId]);
        expect((await ctx.db.query('SELECT reply_count FROM messages WHERE id = $1', [parent.id])).rows[0].reply_count).toBe(1);
        expect(q.id).toBeTruthy();
    });

    it('reports a failure as a notice and frees the session for the next preview', async () => {
        const q = (await queue({ url: 'http://localhost:9999/' })).body;
        const failed = await result((await next()).body, { success: 'false', error: 'port_not_in_session_range' });
        expect(failed.status).toBe(200);
        expect((await ctx.request.get(`/channels/${channel}/browser-previews/${q.id}`).set(owner.auth)).body).toMatchObject({
            status: 'failed', result: { error: 'port_not_in_session_range' } });
        const notice = (await ctx.request.get(`/channels/${channel}/messages?limit=1`).set(owner.auth)).body[0];
        expect(notice).toMatchObject({ systemEvent: 'agent_session', content: 'Browser preview of http://localhost:9999/ failed: port_not_in_session_range' });
        expect((await queue({ url: 'http://localhost:9999/' })).status).toBe(202);
    });

    it('fails previews no host claimed, and claims whose lease ran out', async () => {
        const q = (await queue({ url: 'http://localhost:5173/' })).body;
        await ctx.db.query(`UPDATE browser_previews SET created_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [q.id]);
        expect((await ctx.request.get(`/channels/${channel}/browser-previews/${q.id}`).set(owner.auth)).body).toMatchObject({
            status: 'failed', result: { error: 'host_did_not_claim' } });
        const q2 = (await queue({ url: 'http://localhost:5173/' })).body;
        const claim = (await next()).body;
        await ctx.db.query(`UPDATE browser_previews SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [q2.id]);
        expect((await result(claim, { success: 'true' }, png)).body.error).toBe('lease_expired');
        expect((await ctx.request.get(`/channels/${channel}/browser-previews/${q2.id}`).set(owner.auth)).body.result.error).toBe('host_timeout');
    });

    it('rechecks the session and the requester at claim time', async () => {
        await ctx.db.query(`INSERT INTO channel_member_overrides (channel_id, user_id, allow, deny) VALUES ($1, $2, $3, 0)`, [channel, member.userId, Permissions.DirectAgents.toString()]);
        const q = (await queue({ url: 'http://localhost:5173/', sessionId }, member.auth)).body;
        await ctx.db.query('TRUNCATE channel_member_overrides');
        expect((await next()).status).toBe(204);
        expect((await ctx.request.get(`/channels/${channel}/browser-previews/${q.id}`).set(owner.auth)).body.result.error).toBe('binding_or_authority_changed');
    });

    it('keeps the posted console digest under the message limit', () => {
        const text = previewMessage('http://localhost:1/', '', Array.from({ length: 100 }, () => ({ level: 'error', text: 'e'.repeat(400) })));
        expect(text.length).toBeLessThanOrEqual(4000);
        expect(text).toContain('…');
        expect(previewMessage('http://localhost:1/', '', [{ level: 'log', text: 'a ``` b' }])).not.toMatch(/a ``` b/);
    });
});

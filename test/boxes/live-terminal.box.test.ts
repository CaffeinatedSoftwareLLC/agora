import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { API, OPERATOR, api, createBox, docker, inBox, instance, psql, until, waitRunning, type Box, type Instance } from './harness';

/**
 * A live terminal in a real box (docs/planning/live-terminals.md): the box's agora-host starts the
 * interactive CLI (the image's fake one, box/fake, which honours the Claude Code Channel push through
 * the REAL agora-mcp in channel mode and runs the settings file's hooks through the REAL
 * box/agora-live-hook) on a pty as the AGENT's user, the hub in the gateway joins it to the owner's
 * browser, and a chat message reaches it as a push, never as typed keys.
 *
 * What only a real Claude Code login can prove is NOT here: that the real CLI accepts the development
 * channel flag unattended, what its startup dialogs look like and whether its hooks fire as the fake's
 * do. docs/planning/live-terminals.md lists the manual steps for that.
 */

const PASSWORD = 'box-admin-password-1';
let inst: Instance;
let box: Box;
let profileId = '';
let sessionId = '';
let conversation = '';
let cookie = '';
const sockets: Socket[] = [];
const NAME = 'live-a';
const STATE = `/home/agent/.agora/state/${NAME}`;

async function cookieLogin() {
    const res = await fetch(`${API}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agora-Session': 'cookie' },
        body: JSON.stringify({ login: 'boxadmin', password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie();
    const value = (n: string) => set.find(c => c.startsWith(`${n}=`))!.split(';')[0].slice(n.length + 1);
    cookie = `agora_session=${value('agora_session')}; agora_csrf=${value('agora_csrf')}`;
}

/** The page: a socket on the live hub that reads the screen. */
async function watch() {
    const socket = io(API, { transports: ['websocket'], reconnection: false, autoConnect: false, extraHeaders: { cookie, origin: API }, auth: { type: 'live-view', sessionId } });
    sockets.push(socket);
    let out = '';
    let replay = '';
    const events: string[] = [];
    socket.on('live:output', (d: ArrayBuffer) => { out += Buffer.from(d).toString('utf8'); });
    socket.on('live:replay', (d: ArrayBuffer) => { replay += Buffer.from(d).toString('utf8'); });
    socket.onAny((e: string) => events.push(e));
    await new Promise<void>((resolve, reject) => {
        socket.once('connect_error', e => reject(new Error(e.message)));
        socket.once('connect', () => resolve());
        socket.connect();
    });
    return { socket, screen: () => replay + out, events };
}

const liveState = () => psql(`SELECT live_state FROM agent_sessions WHERE id = '${sessionId}'`);
const logOf = async (file: string) => (await inBox(box.container, `cat ${STATE}/${file} 2>/dev/null || true`)).stdout;
/** The box's live CLI processes: "uid cmdline" (the image has no pgrep; the bracket keeps grep from matching itself) */
const liveProcs = async (includeHelper = false) => (await inBox(box.container,
    `for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case "$c" in *[d]angerously-load-development-channels*) ${includeHelper ? '' : 'case "$c" in *agora-pty*) continue;; esac;'} echo "$(stat -c %u $p) \${p#/proc/}";; esac; done`)).stdout.trim().split('\n').filter(Boolean);
const post = (content: string) => api(`/channels/${inst.channelId}/messages`, { method: 'POST', auth: inst.admin, body: { content } });
const hubTurns = () => psql(`SELECT count(*) FROM live_terminal_turns WHERE session_id = '${sessionId}' AND ended_at IS NOT NULL`);

beforeAll(async () => {
    inst = await instance();
    box = await createBox(inst, NAME, 'claude');
    profileId = (await psql(`SELECT profile_id FROM agent_boxes WHERE id = '${box.id}'`)).trim();
    const mode = await api(`/servers/${inst.serverId}/agent-profiles/${profileId}`, { method: 'PATCH', auth: inst.admin, body: { sessionMode: 'live' } });
    expect(mode.status, JSON.stringify(mode.body)).toBe(200);
    // The box's agora-host has opened its live socket through the edge
    await until('the box to report the live protocol', async () =>
        (await psql(`SELECT h.live_protocol FROM agent_boxes b JOIN agent_hosts h ON h.id = b.host_id WHERE b.id = '${box.id}'`)) === '1', 120_000, 2000);
    const started = await api(`/channels/${inst.channelId}/agent-commands`, { method: 'POST', auth: inst.admin, body: { command: 'start', profile: NAME, fresh: true } });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    sessionId = started.body.session.id;
    conversation = (await psql(`SELECT native_session_id FROM agent_sessions WHERE id = '${sessionId}'`)).trim();
    await cookieLogin();
}, 900_000);
afterAll(() => { for (const s of sockets.splice(0)) s.disconnect(); });

describe('a live terminal in a real box', () => {
    it('starts the interactive CLI on a pty as the agent, resumes nothing yet, and reports idle from its SessionStart hook', async () => {
        await until('the live session to be idle', async () => (await liveState()) === 'idle', 180_000, 1500);
        const procs = await liveProcs();
        expect(procs.length).toBeGreaterThan(0);
        // Every process of the CLI, and the pty helper that holds its terminal, is the agent's (uid 1000), none the operator's
        expect((await liveProcs(true)).every(p => p.startsWith('1000 '))).toBe(true);
        const pid = procs[0].split(' ')[1];
        // ... on a pseudo-terminal
        expect((await inBox(box.container, `readlink /proc/${pid}/fd/0`)).stdout.trim()).toMatch(/^\/dev\/pts\/\d+$/);
        const start = JSON.parse((await logOf('.fake-live-starts.log')).trim().split('\n')[0]);
        expect(start.args).toContain('--dangerously-load-development-channels');
        expect(start.args[start.args.indexOf('--dangerously-load-development-channels') + 1]).toBe('server:agora');
        expect(start.args.slice(-2)).toEqual(['--session-id', conversation]);
        expect(start.args).toContain('--dangerously-skip-permissions');
        // The worktree of its session, on its own branch
        expect(start.cwd).toMatch(/\/wt-/);
        expect(await psql(`SELECT live_note IS NULL FROM agent_sessions WHERE id = '${sessionId}'`)).toBe('t');
    }, 300_000);

    it('keeps the agent\'s secrets out of the operator\'s reach: the operator cannot read the CLI\'s environment, memory or terminal', async () => {
        const pid = (await liveProcs())[0].split(' ')[1];
        for (const path of [`/proc/${pid}/environ`, `/proc/${pid}/mem`, `/proc/${pid}/fd/0`, `/proc/${pid}/cwd/`]) {
            const r = await inBox(box.container, `cat ${path} >/dev/null 2>&1 && echo readable || echo denied`, 20_000, OPERATOR);
            expect([path, r.stdout.trim()]).toEqual([path, 'denied']);
        }
        // The terminal relay (the operator's) is a different process from the agent's pty owner
        const relay = (await inBox(box.container, `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q '[b]ox-relay' && stat -c %u $p; done | head -1`)).stdout.trim();
        expect(relay).toBe(OPERATOR);
    });

    it('delivers a chat message through the Channel push, never as typed keys, and records the turn with the commit at both ends', async () => {
        const before = Number(await hubTurns());
        const sent = await post(`@${NAME} please commit something`);
        expect(sent.status).toBe(201);
        await until('the agent\'s reply', async () => (await psql(`SELECT count(*) FROM messages WHERE channel_id = '${inst.channelId}' AND content = 'fake-claude reply'`)) !== '0', 120_000, 1500);
        await until('the turn to be recorded', async () => Number(await hubTurns()) === before + 1, 60_000, 1000);
        // It arrived as a Channel event naming the message, and nothing was typed
        const prompts = (await logOf('.fake-live-prompts.log')).trim().split('\n').map(l => JSON.parse(l));
        expect(prompts[prompts.length - 1]).toMatchObject({ pushed: true });
        expect(prompts[prompts.length - 1].prompt).toMatch(/^<channel source="agora" /);
        expect((await logOf('.fake-live-stdin.log')).trim()).toBe('');
        const turn = (await psql(`SELECT source || '|' || agent_reported_clean || '|' || (start_sha <> end_sha) || '|' || end_signal FROM live_terminal_turns WHERE session_id = '${sessionId}' ORDER BY started_at DESC LIMIT 1`)).trim();
        expect(turn).toBe('message|true|true|stop_hook');
        expect(await psql(`SELECT wakes_used FROM agent_sessions WHERE id = '${sessionId}'`)).toBe('1');
        expect(await liveState()).toBe('idle');
        // No per-wake run was made for it
        expect(await psql(`SELECT count(*) FROM agent_runs WHERE session_id = '${sessionId}'`)).toBe('0');
    }, 300_000);

    it('mirrors the screen to a watcher, replays it to a late one, and takes the owner\'s keystrokes into the agent\'s terminal only after the confirmation', async () => {
        const a = await watch();
        await until('the screen', async () => a.screen().includes('Channels (experimental)'), 30_000, 300);
        a.socket.emit('live:input', 'before the confirmation\r');
        await new Promise(r => setTimeout(r, 1500));
        expect(await logOf('.fake-live-stdin.log')).not.toContain('before the confirmation');
        a.socket.emit('live:take', { ack: true });
        await until('the confirmation', async () => a.events.includes('live:taken'), 10_000, 100);
        a.socket.emit('live:input', 'hello from the owner\r');
        await until('the typed line to reach the CLI', async () => (await logOf('.fake-live-stdin.log')).includes('hello from the owner'), 30_000, 500);
        await until('the typed turn', async () => Number(await psql(`SELECT count(*) FROM live_terminal_turns WHERE session_id = '${sessionId}' AND source = 'typed' AND ended_at IS NOT NULL`)) >= 1, 60_000, 1000);
        // A typed turn is not a wake
        expect(await psql(`SELECT wakes_used FROM agent_sessions WHERE id = '${sessionId}'`)).toBe('1');
        // The late joiner sees what is already on the screen
        const b = await watch();
        await until('the replay', async () => b.screen().includes('hello from the owner') || b.screen().includes('Channels (experimental)'), 30_000, 300);
        expect(b.events[0]).toBe('live:ready');
        // The operator's shell never saw any of it
        expect((await inBox(box.container, `ls /home/operator`, 20_000, OPERATOR)).stdout).not.toContain('hello from the owner');
    }, 300_000);

    it('holds a chat message while the owner has the controls and delivers it when they stop', async () => {
        // The earlier test's owner page is closed, so its keystrokes no longer count as the controls
        for (const s of sockets.splice(0)) s.disconnect();
        await new Promise(r => setTimeout(r, 1500));
        const a = await watch();
        a.socket.emit('live:take', { ack: true });
        await until('the confirmation', async () => a.events.includes('live:taken'), 10_000, 100);
        const before = (await logOf('.fake-live-prompts.log')).trim().split('\n').length;
        a.socket.emit('live:input', 'x');
        await until('controls', async () => a.events.includes('live:controls'), 10_000, 100);
        await post(`@${NAME} a message sent while the owner types`);
        await new Promise(r => setTimeout(r, 4000));
        // Held: no new push yet (the owner's own typed 'x' is not a line)
        expect((await logOf('.fake-live-prompts.log')).trim().split('\n').length).toBe(before);
        // 20 s of no keystroke (the default) releases it
        await until('the held message to arrive', async () => (await logOf('.fake-live-prompts.log')).trim().split('\n').length > before, 90_000, 2000);
    }, 300_000);

    it('survives every viewer leaving, and comes back after the box restarts with the same conversation resumed', async () => {
        for (const s of sockets.splice(0)) s.disconnect();
        await new Promise(r => setTimeout(r, 2000));
        expect((await liveProcs()).length).toBeGreaterThan(0);
        expect(await psql(`SELECT state FROM agent_sessions WHERE id = '${sessionId}'`)).toBe('live');
        const starts = (await logOf('.fake-live-starts.log')).trim().split('\n').length;
        await docker('restart', box.container);
        await waitRunning(inst, box.id);
        await until('the CLI to start again', async () => (await logOf('.fake-live-starts.log')).trim().split('\n').length > starts, 180_000, 2000);
        const again = JSON.parse((await logOf('.fake-live-starts.log')).trim().split('\n').pop()!);
        // It had started, so the conversation is resumed, not begun again
        expect(again.args.slice(-2)).toEqual(['--resume', conversation]);
        await until('idle again', async () => (await liveState()) === 'idle', 180_000, 1500);
        expect(await psql(`SELECT count(*) FROM agent_sessions WHERE profile_id = '${profileId}' AND state = 'live'`)).toBe('1');
    }, 600_000);

    it('/end stops the CLI and a watcher is told', async () => {
        const a = await watch();
        const end = await api(`/channels/${inst.channelId}/agent-commands`, { method: 'POST', auth: inst.admin, body: { command: 'end', profile: NAME } });
        expect(end.status, JSON.stringify(end.body)).toBe(200);
        await until('the CLI to stop', async () => (await liveProcs()).length === 0, 60_000, 1000);
        await until('the watcher to be told', async () => a.events.includes('live:exit'), 30_000, 500);
    }, 300_000);
});

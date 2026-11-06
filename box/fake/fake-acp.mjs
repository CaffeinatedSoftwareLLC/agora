#!/usr/bin/env node
// A fake ACP CLI for the box test image (box/Dockerfile, target "test"): `opencode acp` or
// `devin acp`, as agora-host drives them over the Agent Client Protocol (acp/session.ts), just
// enough for one turn. Installed as /opt/agora/fake/<cli>.mjs and linked as /opt/agora/bin/<cli>;
// which CLI it plays is its file name. `--version` answers like the pinned CLI.
//
// opencode: it offers the model agora-host put in OPENCODE_CONFIG_CONTENT, asks permission for
// one shell call (in a box agora-host allows everything), posts one reply in the wake's channel
// with the Agora MCP server's environment from session/new, and ends the turn. Without
// OPENROUTER_API_KEY the prompt fails, as the real one does without a key.
//
// devin: `devin [--config <file>] acp` reads the config agora-host wrote for the run; its session
// starts in the "accept-edits" mode, and asks permission for the shell call unless the session was
// switched to "bypass". Without a login in $XDG_DATA_HOME/devin (written by `devin auth login
// --force-manual-token-flow`, which prints a sign-in link on app.devin.ai and reads the pasted
// code like the real one) the prompt fails.
//
// Every call records its arguments, the names (never values) of its environment variables, the
// permission config it was given, its session mode and the answers it got in
// <state dir>/.fake-last-call.json, so isolation tests can check what the CLI saw. The state dir
// is the parent of XDG_CONFIG_HOME (agora-host points both CLIs' XDG directories into the
// profile's state directory).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const CLI = basename(process.argv[1] ?? '').replace(/\.mjs$/, '') === 'devin' ? 'devin' : 'opencode';
const VERSION = CLI === 'devin' ? '3000.11.234' : '1.18.34';
let args = process.argv.slice(2);
// On Windows agora-host gives Devin a home of its own in the state directory instead (adapters.ts devinDirs)
const windowsDevin = CLI === 'devin' && process.platform === 'win32' && !process.env.XDG_CONFIG_HOME;
const stateDir = process.env.XDG_CONFIG_HOME ? dirname(process.env.XDG_CONFIG_HOME)
    : windowsDevin && process.env.USERPROFILE ? dirname(process.env.USERPROFILE) : null;
const json = text => { try { return JSON.parse(text); } catch { return null; } };
// devin: `--config <file>` is a global option, before the subcommand
let devinConfig = null;
if (CLI === 'devin' && args[0] === '--config') {
    devinConfig = json((() => { try { return readFileSync(args[1], 'utf8'); } catch { return 'null'; } })());
    args = args.slice(2);
}
const config = CLI === 'devin' ? devinConfig : json(process.env.OPENCODE_CONFIG_CONTENT ?? 'null');
const seen = { cli: CLI, args: process.argv.slice(2), envNames: Object.keys(process.env).sort(), cwd: process.cwd(),
    permission: (CLI === 'devin' ? config?.permissions : config?.permission) ?? null, config: CLI === 'devin' ? config : undefined, modes: [], answers: [] };

function record() {
    if (!stateDir) return;
    try { mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, '.fake-last-call.json'), JSON.stringify(seen)); }
    catch { /* read-only or missing state dir: nothing to record */ }
}
record();

const devinData = process.env.XDG_DATA_HOME ?? (windowsDevin ? process.env.APPDATA : undefined);
const devinLogin = devinData ? join(devinData, 'devin', 'credentials.toml') : null;
if (args[0] === '--version') { console.log(CLI === 'devin' ? `devin ${VERSION} (fake)` : VERSION); process.exit(0); }
if (CLI === 'devin' && args[0] === 'auth' && args[1] === 'login' && args[2] === '--force-manual-token-flow') {
    process.stdout.write('Visit https://app.devin.ai/auth/cli/continue?state=fake-state&prompt=select_account to sign in, then copy the code and paste it below.\n\n');
    const lines = createInterface({ input: process.stdin });
    let done = false;
    lines.on('line', line => {
        if (done || !line.trim()) return;
        done = true;
        // The real CLI exchanges the code for a token; the fake keeps only that it was given one
        mkdirSync(dirname(devinLogin), { recursive: true });
        writeFileSync(devinLogin, 'fake_login = true\n', { mode: 0o600 });
        process.stdout.write('Logged in.\n');
        process.exit(0);
    });
    lines.on('close', () => { if (!done) { console.error('Error: Failed to read code - user canceled'); process.exit(1); } });
} else if (args[0] !== 'acp') {
    console.error(`fake ${CLI}: unsupported arguments`); process.exit(2);
} else acp();

function acp() {
    const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
    const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
    const fail = (id, error) => send({ jsonrpc: '2.0', id, error });
    const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
    let nextId = 1000;
    const waiting = new Map();
    const ask = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });

    const sessions = new Map();
    const model = CLI === 'devin' ? 'swe-1-6-fast' : typeof config?.model === 'string' ? config.model : 'openrouter/fake/model';
    const modeOption = mode => ({ id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: mode,
        options: ['accept-edits', 'ask', 'plan', 'bypass'].map(value => ({ value, name: value })) });
    const configOptions = session => [...(CLI === 'devin' ? [modeOption(session.mode)] : []),
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: model, name: model }] }];

    /** What a real agent does with its Agora tools: one reply in the wake's channel. */
    async function postReply(env) {
        const { AGORA_INSTANCE: instance, AGORA_BOT_TOKEN: token, AGORA_DEFAULT_CHANNEL: channel } = env;
        if (!instance || !token || !channel) return;
        try {
            const res = await fetch(new URL(`/channels/${channel}/messages`, instance), {
                method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: `fake-${CLI} reply` }), signal: AbortSignal.timeout(10000),
            });
            await res.body?.cancel();
        } catch { /* the turn still succeeds; the test looks at the message */ }
    }

    async function prompt(id, { sessionId }) {
        const session = sessions.get(sessionId);
        if (!session) return fail(id, { code: -32602, message: 'Unknown session' });
        if (CLI === 'opencode' && !process.env.OPENROUTER_API_KEY) return fail(id, { code: -32000, message: 'No API key for provider openrouter (401)' });
        if (CLI === 'devin' && !(devinLogin && existsSync(devinLogin))) return fail(id, { code: -32000, message: 'Authentication required' });
        seen.modes.push(session.mode ?? null); record();
        const toolCallId = 'call-0';
        update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: CLI === 'devin' ? 'git status' : 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'git status' } });
        // Devin asks nothing in bypass mode
        const answer = CLI === 'devin' && session.mode === 'bypass' ? { outcome: { outcome: 'selected', optionId: 'once' } }
            : await ask('session/request_permission', { sessionId, toolCall: { toolCallId },
                options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' },
                    { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
        if (!(CLI === 'devin' && session.mode === 'bypass')) { seen.answers.push(answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? null); record(); }
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: answer?.outcome?.optionId === 'once' ? 'completed' : 'failed' });
        await postReply(session.env);
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `{"summary":"fake ${CLI} turn"}` } });
        reply(id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    }

    createInterface({ input: process.stdin }).on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (!message.method) { waiting.get(message.id)?.(message.result ?? message.error); waiting.delete(message.id); return; }
        const { id, method, params } = message;
        switch (method) {
            case 'initialize':
                // opencode offers only a terminal login, devin only its browser login; agora-host calls neither
                return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true },
                    authMethods: CLI === 'devin' ? [{ id: 'devin-browser', name: 'Log in with browser' }] : [{ id: 'opencode-login', name: 'Login', type: 'terminal' }],
                    agentInfo: CLI === 'devin' ? { name: 'affogato', title: 'Devin Agent', version: '0.0.0-dev' } : { name: 'OpenCode', version: VERSION } });
            case 'session/new': case 'session/load': {
                const sessionId = method === 'session/new' ? `ses${randomUUID().replace(/-/g, "").slice(0, 16)}` : params?.sessionId;
                const env = Object.fromEntries((params?.mcpServers?.[0]?.env ?? []).map(e => [e.name, e.value]));
                // A resumed Devin session keeps its saved mode; a new one starts in "accept-edits"
                const session = { env, mode: sessions.get(sessionId)?.mode ?? 'accept-edits' };
                sessions.set(sessionId, session);
                return reply(id, method === 'session/new' ? { sessionId, configOptions: configOptions(session) } : { configOptions: configOptions(session) });
            }
            case 'session/set_config_option': {
                const session = sessions.get(params?.sessionId);
                if (session && params?.configId === 'mode') session.mode = params.value;
                return reply(id, { configOptions: session ? configOptions(session) : [] });
            }
            case 'session/prompt': return void prompt(id, params);
            case 'session/cancel': return;
            default: if (id !== undefined) fail(id, { code: -32601, message: 'Method not found' });
        }
    });
}

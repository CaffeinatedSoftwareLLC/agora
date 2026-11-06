#!/usr/bin/env node
// A fake oh-my-pi for the box test image (box/Dockerfile, target "test"): `omp acp` as
// agora-host drives it over the Agent Client Protocol (acp/session.ts, acp/omp.ts), just enough
// for one turn. Installed as /opt/agora/bin/omp; `--version` answers like the pinned CLI.
//
// It offers the model agora-host named with --model, asks permission for one shell call (in a
// box agora-host allows everything), posts one reply in the wake's channel with the Agora MCP
// server's environment from session/new, and ends the turn. Without OPENROUTER_API_KEY the
// prompt fails, as the real one does without a key.
//
// Every call records its arguments, its working directory, the names (never values) of its
// environment variables, the settings overlay it was given (--config) and the answers it got in
// <state dir>/.fake-last-call.json, so isolation tests can check what the CLI saw. The state
// dir is the parent of PI_CODING_AGENT_DIR (agora-host puts omp's agent folder there).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '18.17.0';
const args = process.argv.slice(2);
const stateDir = process.env.PI_CODING_AGENT_DIR ? dirname(process.env.PI_CODING_AGENT_DIR) : null;
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const settings = (() => { try { return JSON.parse(readFileSync(flag('--config'), 'utf8')); } catch { return null; } })();
const seen = { cli: 'omp', args, envNames: Object.keys(process.env).sort(), cwd: process.cwd(), settings, answers: [] };

function record() {
    if (!stateDir) return;
    try { mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, '.fake-last-call.json'), JSON.stringify(seen)); }
    catch { /* read-only or missing state dir: nothing to record */ }
}
record();

if (args[0] === '--version') { console.log(`omp/${VERSION}`); process.exit(0); }
if (args[0] !== 'acp') { console.error('fake omp: unsupported arguments'); process.exit(2); }

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, error) => send({ jsonrpc: '2.0', id, error });
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });

const sessions = new Map();
const model = flag('--model') ?? 'openrouter/fake/model';
const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: model, name: model }] }];

/** What a real agent does with its Agora tools: one reply in the wake's channel. */
async function postReply(env) {
    const { AGORA_INSTANCE: instance, AGORA_BOT_TOKEN: token, AGORA_DEFAULT_CHANNEL: channel } = env;
    if (!instance || !token || !channel) return;
    try {
        const res = await fetch(new URL(`/channels/${channel}/messages`, instance), {
            method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'fake-omp reply' }), signal: AbortSignal.timeout(10000),
        });
        await res.body?.cancel();
    } catch { /* the turn still succeeds; the test looks at the message */ }
}

async function prompt(id, { sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) return fail(id, { code: -32602, message: 'Unknown session' });
    if (!process.env.OPENROUTER_API_KEY) return fail(id, { code: -32603, message: 'Internal error', data: { details: 'No model selected. Use /login or set an API key environment variable.' } });
    const toolCallId = 'call_0|fc_0';
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: '$ git status', kind: 'execute', status: 'pending', rawInput: { command: 'git status' } });
    const answer = await ask('session/request_permission', { sessionId, toolCall: { toolCallId, title: 'git status', kind: 'execute', status: 'pending', rawInput: { command: 'git status' } },
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }, { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' }] });
    seen.answers.push(answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? null); record();
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: answer?.outcome?.optionId === 'allow_once' ? 'completed' : 'failed' });
    await postReply(session.env);
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"summary":"fake omp turn"}' } });
    reply(id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
}

createInterface({ input: process.stdin }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message.method) { waiting.get(message.id)?.(message.result ?? message.error); waiting.delete(message.id); return; }
    const { id, method, params } = message;
    switch (method) {
        case 'initialize':
            seen.clientCapabilities = params?.clientCapabilities ?? null; record();
            // omp offers its stored credentials ("agent"), which agora-host never calls
            return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} } },
                authMethods: [{ id: 'agent', name: 'Use existing local credentials' }], agentInfo: { name: 'omp', title: 'omp', version: VERSION } });
        case 'session/new': case 'session/load': case 'session/resume': {
            const sessionId = method === 'session/new' ? `01${Date.now().toString(16)}-fake` : params?.sessionId;
            const env = Object.fromEntries((params?.mcpServers?.[0]?.env ?? []).map(e => [e.name, e.value]));
            sessions.set(sessionId, { env });
            seen.sessionCwd = params?.cwd ?? null; record();
            return reply(id, method === 'session/new' ? { sessionId, configOptions } : { configOptions });
        }
        case 'session/set_config_option': return reply(id, { configOptions });
        case 'session/prompt': return void prompt(id, params);
        case 'session/cancel': return;
        default: if (id !== undefined) fail(id, { code: -32601, message: 'Method not found' });
    }
});

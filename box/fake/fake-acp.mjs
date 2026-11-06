#!/usr/bin/env node
// A fake opencode for the box test image (box/Dockerfile, target "test"): `opencode acp` as
// agora-host drives it over the Agent Client Protocol (acp/session.ts), just enough for one
// turn. Installed as /opt/agora/bin/opencode; `--version` answers like the pinned CLI.
//
// It offers the model agora-host put in OPENCODE_CONFIG_CONTENT, asks permission for one shell
// call (in a box agora-host allows everything), posts one reply in the wake's channel with the
// Agora MCP server's environment from session/new, and ends the turn. Without
// OPENROUTER_API_KEY the prompt fails, as the real one does without a key.
//
// Every call records its arguments, the names (never values) of its environment variables, the
// permission config it was given and the answers it got in <state dir>/.fake-last-call.json,
// so isolation tests can check what the CLI saw. The state dir is the parent of XDG_CONFIG_HOME
// (agora-host points opencode's XDG directories into the profile's state directory).
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '1.18.34';
const args = process.argv.slice(2);
const stateDir = process.env.XDG_CONFIG_HOME ? dirname(process.env.XDG_CONFIG_HOME) : null;
const config = (() => { try { return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? 'null'); } catch { return null; } })();
const seen = { cli: 'opencode', args, envNames: Object.keys(process.env).sort(), cwd: process.cwd(), permission: config?.permission ?? null, answers: [] };

function record() {
    if (!stateDir) return;
    try { mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, '.fake-last-call.json'), JSON.stringify(seen)); }
    catch { /* read-only or missing state dir: nothing to record */ }
}
record();

if (args[0] === '--version') { console.log(VERSION); process.exit(0); }
if (args[0] !== 'acp') { console.error('fake opencode: unsupported arguments'); process.exit(2); }

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, error) => send({ jsonrpc: '2.0', id, error });
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });

const sessions = new Map();
const model = typeof config?.model === 'string' ? config.model : 'openrouter/fake/model';
const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: model, name: model }] }];

/** What a real agent does with its Agora tools: one reply in the wake's channel. */
async function postReply(env) {
    const { AGORA_INSTANCE: instance, AGORA_BOT_TOKEN: token, AGORA_DEFAULT_CHANNEL: channel } = env;
    if (!instance || !token || !channel) return;
    try {
        const res = await fetch(new URL(`/channels/${channel}/messages`, instance), {
            method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'fake-opencode reply' }), signal: AbortSignal.timeout(10000),
        });
        await res.body?.cancel();
    } catch { /* the turn still succeeds; the test looks at the message */ }
}

async function prompt(id, { sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) return fail(id, { code: -32602, message: 'Unknown session' });
    if (!process.env.OPENROUTER_API_KEY) return fail(id, { code: -32000, message: 'No API key for provider openrouter (401)' });
    const toolCallId = 'call-0';
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'git status' } });
    const answer = await ask('session/request_permission', { sessionId, toolCall: { toolCallId },
        options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
    seen.answers.push(answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? null); record();
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: answer?.outcome?.optionId === 'once' ? 'completed' : 'failed' });
    await postReply(session.env);
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"summary":"fake opencode turn"}' } });
    reply(id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
}

createInterface({ input: process.stdin }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message.method) { waiting.get(message.id)?.(message.result ?? message.error); waiting.delete(message.id); return; }
    const { id, method, params } = message;
    switch (method) {
        case 'initialize':
            // opencode offers only a terminal login, which agora-host never calls
            return reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'opencode-login', name: 'Login', type: 'terminal' }],
                agentInfo: { name: 'OpenCode', version: VERSION } });
        case 'session/new': case 'session/load': {
            const sessionId = method === 'session/new' ? `ses${randomUUID().replace(/-/g, "").slice(0, 16)}` : params?.sessionId;
            const env = Object.fromEntries((params?.mcpServers?.[0]?.env ?? []).map(e => [e.name, e.value]));
            sessions.set(sessionId, { env });
            return reply(id, method === 'session/new' ? { sessionId, configOptions } : { configOptions });
        }
        case 'session/set_config_option': return reply(id, { configOptions });
        case 'session/prompt': return void prompt(id, params);
        case 'session/cancel': return;
        default: if (id !== undefined) fail(id, { code: -32601, message: 'Method not found' });
    }
});

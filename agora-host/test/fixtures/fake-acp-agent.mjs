// A fake ACP v1 agent for agora-host tests. Behaviour comes from environment variables;
// every message it receives is appended to ACP_LOG as one JSON line.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
const json = (name, fallback) => (env[name] ? JSON.parse(env[name]) : fallback);
const log = message => { if (env.ACP_LOG) appendFileSync(env.ACP_LOG, `${JSON.stringify(message)}\n`); };
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });

let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, error) => send({ jsonrpc: '2.0', id, error });

const capabilities = {
    loadSession: env.ACP_RESUME === 'load',
    sessionCapabilities: env.ACP_RESUME === 'resume' ? { resume: {} } : {},
};
const configOptions = json('ACP_CONFIG', []);
const sessionConfig = () => ({ ...(env.ACP_OMIT_CONFIG ? {} : { configOptions }),
    ...(env.ACP_MODELS ? { models: json('ACP_MODELS', {}) } : {}) });

async function prompt(id, { sessionId }) {
    if (env.ACP_HANG) return;
    if (env.ACP_PROMPT_ERROR) { fail(id, JSON.parse(env.ACP_PROMPT_ERROR)); return; }
    update(sessionId, { sessionUpdate: 'plan', entries: [
        { content: 'Look', priority: 'high', status: 'completed' }, { content: 'Change', priority: 'high', status: 'pending' }] });
    if (!env.ACP_NO_PREAMBLE) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me check.' } });
    for (const [n, tool] of json('ACP_TOOLS', []).entries()) {
        const toolCallId = `call-${n}`;
        update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: tool.title, kind: tool.kind, status: 'pending', rawInput: tool.rawInput, ...(tool.locations ? { locations: tool.locations } : {}),
            ...(tool.name ? { name: tool.name } : {}), content: tool.diff ? [{ type: 'diff', ...tool.diff }] : [] });
        // opencode: an update with the call's input, then a request that repeats the call with empty fields
        if (tool.update) update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', ...tool.update });
        const answer = await ask('session/request_permission', { sessionId, toolCall: { toolCallId, ...(tool.ask ?? {}) },
            options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' },
                { optionId: 'no', name: 'Reject', kind: 'reject_once' }, { optionId: 'never', name: 'Never', kind: 'reject_always' }] });
        log({ permission: toolCallId, answer });
        const allowed = answer.outcome?.optionId === 'yes';
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed' });
    }
    for (const text of json('ACP_MESSAGE', ['{"summary":', '"Done"}'])) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    reply(id, { stopReason: env.ACP_STOP ?? 'end_turn', ...(env.ACP_USAGE ? { usage: JSON.parse(env.ACP_USAGE) } : {}) });
}

createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    log(message);
    if (!message.method) { waiting.get(message.id)?.(message.result ?? message.error); waiting.delete(message.id); return; }
    const { id, method, params } = message;
    switch (method) {
        case 'initialize':
            return reply(id, { protocolVersion: Number(env.ACP_VERSION ?? 1), agentCapabilities: capabilities,
                authMethods: json('ACP_AUTH_METHODS', []), agentInfo: { name: 'fake-acp', version: '9.9.9' } });
        case 'authenticate': return reply(id, {});
        case 'session/new':
            if (env.ACP_NEW_ERROR) return fail(id, JSON.parse(env.ACP_NEW_ERROR));
            return reply(id, { sessionId: 'sess-1', ...sessionConfig() });
        case 'session/resume': case 'session/load': return reply(id, sessionConfig());
        case 'session/set_config_option': return reply(id, { configOptions });
        case 'session/set_model':
            return env.ACP_SET_MODEL_ERROR ? fail(id, json('ACP_SET_MODEL_ERROR', {})) : reply(id, {});
        case 'session/prompt': return void prompt(id, params);
        case 'session/cancel': return;
        default: if (id !== undefined) fail(id, { code: -32601, message: 'Method not found' });
    }
});

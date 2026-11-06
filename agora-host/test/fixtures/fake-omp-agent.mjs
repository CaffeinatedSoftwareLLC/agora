// A fake `omp acp` (oh-my-pi 18.17) for agora-host tests: its prompts are shaped as the real
// one sends them (checked against the pinned binary): shell commands as
// session/request_permission, other tools as elicitation/create forms ("Allow tool: <name>",
// Approve / Deny), each after the tool call's pending update.
//
// ACP_LOG: every message it receives, one JSON line each, plus {cwd} and {argv} at start.
// OMP_STEPS: JSON array; each step is { calls: [{title, kind, rawInput}], elicit?: {message, choices},
// permission?: true } -- the calls are announced pending, then the elicitation (or a permission
// request for the first call) is sent, and the answer logged.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
const log = message => { if (env.ACP_LOG) appendFileSync(env.ACP_LOG, `${JSON.stringify(message)}\n`); };
log({ cwd: process.cwd(), argv: process.argv.slice(2) });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, error) => send({ jsonrpc: '2.0', id, error });
const model = env.OMP_MODEL ?? 'openrouter/qwen/qwen3-coder';
const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'openrouter/ai21/jamba-large-1.7',
    options: [{ value: 'openrouter/ai21/jamba-large-1.7', name: 'Jamba' }, { value: model, name: model }] }];

let n = 0;
async function prompt(id, { sessionId }) {
    for (const step of JSON.parse(env.OMP_STEPS ?? '[]')) {
        const ids = step.calls.map(() => `call_${n}|fc_${n++}`);
        step.calls.forEach((c, i) => update(sessionId, { sessionUpdate: 'tool_call', toolCallId: ids[i], status: 'pending', ...c }));
        let allowed;
        if (step.permission) {
            const answer = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: ids[0], ...step.calls[0] },
                options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
                    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }, { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' }] });
            log({ permission: ids[0], answer });
            allowed = answer?.outcome?.optionId === 'allow_once';
        } else {
            const answer = await ask('elicitation/create', { mode: 'form', sessionId, message: step.elicit.message,
                requestedSchema: { type: 'object', properties: { value: { type: 'string', enum: step.elicit.choices ?? ['Approve', 'Deny'] } }, required: ['value'] } });
            log({ elicitation: ids[0], answer });
            allowed = answer?.action === 'accept' && typeof answer.content?.value === 'string' && answer.content.value.startsWith('Approve');
        }
        for (const toolCallId of ids) update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed' });
    }
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"summary":"Done"}' } });
    reply(id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
}

createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    log(message);
    if (!message.method) { waiting.get(message.id)?.(message.result ?? message.error); waiting.delete(message.id); return; }
    const { id, method, params } = message;
    switch (method) {
        case 'initialize':
            return reply(id, { protocolVersion: 1, agentInfo: { name: 'omp', title: 'omp', version: env.OMP_VERSION ?? '18.17.0' },
                authMethods: [{ id: 'agent', name: 'Use existing local credentials' }],
                agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} } } });
        case 'session/new': return reply(id, { sessionId: '01a1b1b6-23da-7634-9236-019317a5b12a', configOptions });
        case 'session/resume': case 'session/load': return reply(id, { configOptions });
        case 'session/set_config_option': return reply(id, { configOptions: configOptions.map(o => ({ ...o, currentValue: params.value })) });
        case 'session/prompt': return void prompt(id, params);
        case 'session/cancel': return;
        default: if (id !== undefined) fail(id, { code: -32601, message: 'Method not found' });
    }
});

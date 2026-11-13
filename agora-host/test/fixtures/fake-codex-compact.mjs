// A fake `codex app-server --listen stdio://` speaking the JSON-RPC lines codex-cli 0.166.0 spoke for
// thread/resume + thread/compact/start (captured with the real server). FAKE_MODE picks the case.
import { createInterface } from 'node:readline';
const mode = process.env.FAKE_MODE ?? 'ok';
const send = (m) => console.log(JSON.stringify(m));
const thread = '01a1d63d-7bd8-7d51-ba19-45c0d2d2de0d';
const turn = '01a1d640-7a0a-72d1-9d3e-fc423592ee21';
console.error(JSON.stringify(process.argv.slice(2)));
for await (const line of createInterface({ input: process.stdin })) {
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'agora-host/0.166.0', codexHome: 'x' } });
    else if (m.method === 'thread/resume') {
        if (mode === 'no-thread') { send({ id: m.id, error: { code: -32600, message: 'no rollout found' } }); continue; }
        send({ id: m.id, result: { thread: { id: m.params.threadId } } });
        send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId: turn, tokenUsage: { total: { totalTokens: 48387 }, last: { totalTokens: 25063 } } } });
    } else if (m.method === 'thread/compact/start') {
        send({ id: m.id, result: {} });
        if (mode === 'hang') continue;
        send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn, status: 'inProgress' } } });
        send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: { type: 'contextCompaction', id: 'i1' } } });
        if (mode === 'ask') send({ id: 77, method: 'item/commandExecution/requestApproval', params: {} });
        if (mode !== 'no-item') send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { type: 'contextCompaction', id: 'i1' } } });
        send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: mode === 'failed' ? 'failed' : 'completed', error: null } } });
    }
}

// A stand-in for `codex app-server --listen stdio://` in tests: newline-delimited JSON-RPC.
// FAKE_LOG: file to append what it saw (argv, ACCESS_TOKEN, requests, responses).
// FAKE_MODE: 'ok' | 'expire' (401 while ACCESS_TOKEN is "old") | 'ineligible' (403 not eligible) | 'limit'.
// FAKE_REQUESTS: JSON list of server requests to send during the turn, as codex 0.163 does
// (item/started first, then the request): { id, method, params, item?, resolveAfterMs?, otherTurn? }.
// `resolveAfterMs` sends serverRequest/resolved (Codex clearing it) instead of waiting for an answer.
// The turn completes once every other request is answered.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const log = o => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n'); };
log({ start: true, argv: process.argv.slice(2), token: process.env.ACCESS_TOKEN ?? null });
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const mode = process.env.FAKE_MODE ?? 'ok';
let threadId = null;

function fail(turnId, error) {
    send({ method: 'error', params: { error } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error, items: [] } } });
}

const waiting = new Set();
let finish = null;
createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    log({ method: m.method ?? null, id: m.id ?? null, params: m.params ?? null, result: m.result ?? null, error: m.error ?? null });
    if (m.method === undefined && m.id !== undefined && waiting.has(m.id)) {
        waiting.delete(m.id);
        send({ method: 'serverRequest/resolved', params: { threadId, requestId: m.id } });
        if (waiting.size === 0 && finish) finish();
        return;
    }
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake/0' } });
    else if (m.method === 'initialized') { /* notification */ }
    else if (m.method === 'thread/start') { threadId = '0199a000-0000-7000-8000-000000000001'; send({ id: m.id, result: { thread: { id: threadId } } }); }
    else if (m.method === 'thread/resume') { threadId = m.params.threadId; send({ id: m.id, result: { thread: { id: threadId } } }); }
    else if (m.method === 'turn/start') {
        const turnId = 'turn-' + Date.now();
        // Codex sends turn/started before the turn/start response
        send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
        send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
        if (process.env.FAKE_REQUESTS) {
            const done = () => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } } });
            for (const r of JSON.parse(process.env.FAKE_REQUESTS)) {
                if (r.item) send({ method: 'item/started', params: { threadId, turnId, item: r.item } });
                const params = { threadId, turnId: r.otherTurn ? 'turn-old' : turnId, startedAtMs: Date.now(), ...r.params };
                send({ id: r.id, method: r.method, params });
                if (r.resolveAfterMs !== undefined) setTimeout(() => send({ method: 'serverRequest/resolved', params: { threadId, requestId: r.id } }), r.resolveAfterMs);
                else waiting.add(r.id);
            }
            send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: JSON.stringify({ summary: 'Done' }) } } });
            const end = () => setTimeout(done, Number(process.env.FAKE_LINGER_MS ?? 100));
            if (waiting.size === 0) end(); else finish = end;
            return;
        }
        if (mode === 'expire' && process.env.ACCESS_TOKEN === 'old')
            return fail(turnId, { message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'unauthorized', additionalDetails: null });
        if (mode === 'ineligible')
            return fail(turnId, { message: 'unexpected status 403 Forbidden: {"error":{"code":"subscription_sharing_user_not_eligible"}}',
                codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } }, additionalDetails: null });
        if (mode === 'limit')
            return fail(turnId, { message: 'subscription_sharing_usage_limit_exceeded', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null });
        // An approval request with no rule behind it: the host must decline it
        send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'cmd1' } });
        send({ method: 'item/completed', params: { item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'src/a.ts', kind: 'update', diff: '' }] } } });
        send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { inputTokens: 100, outputTokens: 20 }, total: { inputTokens: 900, outputTokens: 99 } } } });
        send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { inputTokens: 30, outputTokens: 5 }, total: {} } } });
        send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: JSON.stringify({ summary: 'Done on the plan' }) } } });
        setTimeout(() => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } } }), 50);
    }
});

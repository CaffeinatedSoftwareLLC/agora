// A stand-in for `codex app-server --listen stdio://` in tests: newline-delimited JSON-RPC.
// FAKE_LOG: file to append what it saw (argv, ACCESS_TOKEN, requests, responses).
// FAKE_MODE: 'ok' | 'expire' (401 while ACCESS_TOKEN is "old") | 'ineligible' (403 not eligible) | 'limit'.
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

createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    log({ method: m.method ?? null, id: m.id ?? null, params: m.params ?? null, result: m.result ?? null });
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake/0' } });
    else if (m.method === 'initialized') { /* notification */ }
    else if (m.method === 'thread/start') { threadId = '0199a000-0000-7000-8000-000000000001'; send({ id: m.id, result: { thread: { id: threadId } } }); }
    else if (m.method === 'thread/resume') { threadId = m.params.threadId; send({ id: m.id, result: { thread: { id: threadId } } }); }
    else if (m.method === 'turn/start') {
        const turnId = 'turn-' + Date.now();
        send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
        if (mode === 'expire' && process.env.ACCESS_TOKEN === 'old')
            return fail(turnId, { message: 'unexpected status 401 Unauthorized', codexErrorInfo: 'unauthorized', additionalDetails: null });
        if (mode === 'ineligible')
            return fail(turnId, { message: 'unexpected status 403 Forbidden: {"error":{"code":"subscription_sharing_user_not_eligible"}}',
                codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } }, additionalDetails: null });
        if (mode === 'limit')
            return fail(turnId, { message: 'subscription_sharing_usage_limit_exceeded', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null });
        // An approval request: the host must decline it (approval policy "never")
        send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'cmd1' } });
        send({ method: 'item/completed', params: { item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'src/a.ts', kind: 'update', diff: '' }] } } });
        send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { inputTokens: 100, outputTokens: 20 }, total: { inputTokens: 900, outputTokens: 99 } } } });
        send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { inputTokens: 30, outputTokens: 5 }, total: {} } } });
        send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: JSON.stringify({ summary: 'Done on the plan' }) } } });
        setTimeout(() => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } } }), 50);
    }
});

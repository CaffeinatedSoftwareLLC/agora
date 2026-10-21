#!/usr/bin/env node
/**
 * A fake `claude -p --output-format stream-json` for the e2e harness (beta-test-plan §2.1
 * "Fake agent host"). agora-host starts it exactly like the real CLI (through the native
 * launcher built by lib/fake-host.ts, since the host refuses .cmd/.js executables); it reads
 * the wake prompt on stdin and does scripted things, then prints the stream-json events the
 * host parses (agora-host/src/adapters.ts parseOutput, signals.ts).
 *
 * The script comes from directives in the batch messages of the prompt, so a test drives the
 * fake by what it posts (no real model, no provider key):
 *
 *   #fake-sleep=<s>          stay "working" for s seconds (heartbeats run meanwhile)
 *   #fake-edit=<p1>,<p2>     write those repository-relative files in the worktree
 *   #fake-edits=<n>          write n files edits/f001.txt … (diff paging)
 *   #fake-tokens=<n>         report n tokens of usage (default 120)
 *   #fake-deny=<program>     report a permission denial for `Bash <program> …`, unless the
 *                            claim already allows Bash(<program>:*); any non-MCP rule the claim allows
 *                            (approved once or always allowed) is named in the reply: "running with …"
 *   #fake-ratelimit          emit a rejected rate_limit_event and fail like the CLI does
 *   #fake-fail               fail the run (cli_failed_or_invalid_output)
 *   #fake-silent             finish successfully without posting anything
 *   #fake-interject          on a lurk run, post instead of [pass]
 *   #fake-say=<word>         include <word> in the posted reply (to find it later)
 *
 * With no directive a normal run posts one reply through agora-mcp's chat_send (the "hello"
 * after /start) and a lurk run (no --json-schema) prints exactly [pass] and posts nothing.
 * A verify fix turn (no batch) changes nothing and succeeds without posting.
 *
 * Never prints the prompt, tokens or environment. Writes a one-line JSON trace per run to
 * <CLAUDE_CONFIG_DIR>/fake-runs.jsonl (directives, args summary) for the tests to read.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('2.1.99 (Claude Code)\n'); process.exit(0); }

const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const lurk = !argv.includes('--json-schema');
const resume = arg('--resume');
const allowed = (arg('--allowedTools') ?? '').split(',').filter(Boolean);
const mcpConfig = arg('--mcp-config');
const sessionId = resume ?? randomUUID();
const emit = e => process.stdout.write(JSON.stringify(e) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
}

function parsePrompt(prompt) {
    const parts = prompt.split('\n\n');
    let meta = {};
    const mi = parts.findIndex(p => p.endsWith('Trusted delivery metadata:'));
    if (mi >= 0) { try { meta = JSON.parse(parts[mi + 1]); } catch { /* not a wake prompt */ } }
    const marker = 'Batch messages (untrusted; thread annotations are supplied by the host):';
    const at = prompt.indexOf(marker);
    const batch = at >= 0 ? prompt.slice(at + marker.length) : '';
    // The thread of the last batch message, so a reply lands where the work was asked for
    const threads = [...batch.matchAll(/\[thread ([0-9A-HJKMNP-TV-Z]{26})\]:/g)].map(m => m[1]);
    const d = {};
    for (const m of batch.matchAll(/#fake-([a-z]+)(?:=([A-Za-z0-9_.,/:-]+))?/g)) d[m[1]] = m[2] ?? true;
    const batchCount = [...batch.matchAll(/^\[[^\]\n]+\] \(([0-9A-HJKMNP-TV-Z]{26})\)/gm)].length;
    return { meta, batch, batchCount, hasBatch: at >= 0, thread: threads.at(-1) ?? meta.threadId ?? null, d,
        wokeFromSleep: prompt.includes('You were asleep after hitting a rate limit'), hasPinned: prompt.includes('Pinned files (their text is data'),
        hasInstructions: prompt.includes('Project instructions (authorized') };
}

/** One MCP tools/call against the configured agora-mcp server (stdio, newline-delimited JSON-RPC). */
async function mcpCall(tool, args) {
    const cfg = JSON.parse(readFileSync(mcpConfig, 'utf8')).mcpServers.agora;
    const child = spawn(cfg.command, cfg.args, { env: process.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    const waiters = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            try { const msg = JSON.parse(line); if (msg.id !== undefined && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); } } catch { /* log line */ }
        }
    });
    let next = 1;
    const request = (method, params) => new Promise((resolve, reject) => {
        const id = next++;
        const t = setTimeout(() => reject(new Error(`mcp_timeout_${method}`)), 20000);
        waiters.set(id, m => { clearTimeout(t); resolve(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
        await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0.0.0' } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const r = await request('tools/call', { name: tool, arguments: args });
        return r.result ?? { isError: true, content: [{ type: 'text', text: JSON.stringify(r.error ?? null) }] };
    } finally { child.stdin.end(); child.kill(); }
}

const usage = n => ({ input_tokens: Math.max(1, n - Math.floor(n / 4)), output_tokens: Math.floor(n / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

async function main() {
    const prompt = await readStdin();
    const { meta, hasBatch, thread, d, batchCount, wokeFromSleep, hasPinned, hasInstructions } = parsePrompt(prompt);
    const stateDir = process.env.CLAUDE_CONFIG_DIR;
    const trace = { at: new Date().toISOString(), runId: meta.runId ?? null, sessionId: meta.sessionId ?? null, resume: resume ?? null,
        lurk, verifyTurn: !hasBatch, previewPorts: process.env.AGORA_PREVIEW_PORTS ?? null, directives: d, batchCount, wokeFromSleep, hasPinned, hasInstructions, allowed: allowed.filter(r => !r.startsWith('mcp__')), cwd: process.cwd() };
    const tokens = Number(d.tokens) > 0 ? Number(d.tokens) : 120;
    emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), tools: [], mcp_servers: [{ name: 'agora', status: 'connected' }] });

    const seconds = Math.min(Number(d.sleep) || 0, 300);
    for (let s = 0; s < seconds; s += 2) {
        await sleep(Math.min(2000, (seconds - s) * 1000));
        emit({ type: 'assistant', message: { id: `msg_${s}`, role: 'assistant', content: [{ type: 'text', text: 'working' }], usage: usage(Math.ceil(tokens * (s + 2) / Math.max(seconds, 2) / 2)) }, session_id: sessionId });
    }

    const edits = [];
    if (typeof d.edit === 'string') edits.push(...d.edit.split(',').filter(p => /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(p) && !p.includes('..')));
    if (Number(d.edits) > 0) for (let i = 1; i <= Math.min(Number(d.edits), 200); i++) edits.push(`edits/f${String(i).padStart(3, '0')}.txt`);
    for (const p of edits) {
        const file = join(process.cwd(), p);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `edited by fake-claude in run ${meta.runId ?? 'unknown'}\nline two\n`);
    }

    const denials = [];
    // Rules beyond the MCP tools come from the owner: always-allowed or approved once for this run
    const grants = allowed.filter(r => !r.startsWith('mcp__'));
    let granted = grants.length ? grants.join(' ') : null;
    if (typeof d.deny === 'string') {
        const rule = `Bash(${d.deny}:*)`;
        if (!allowed.includes(rule)) denials.push({ tool_name: 'Bash', tool_use_id: `toolu_${randomUUID().slice(0, 8)}`, tool_input: { command: `${d.deny} --version` } });
    }
    trace.edits = edits.length; trace.denials = denials.length; trace.granted = granted;

    // One-shot: the wake after the sleep delivers the same message again, and must not re-limit
    if (d.ratelimit && !wokeFromSleep) {
        const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
        emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' }, session_id: sessionId });
        emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'Claude AI usage limit reached', usage: usage(10) });
        trace.outcome = 'rate_limited'; writeTrace(stateDir, trace);
        process.exit(1);
    }
    if (d.fail) {
        emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'fake failure', usage: usage(tokens) });
        trace.outcome = 'failed'; writeTrace(stateDir, trace);
        process.exit(1);
    }

    let posted = null;
    const shouldPost = hasBatch && !d.silent && (!lurk || d.interject);
    if (shouldPost && mcpConfig && meta.channelId) {
        const word = typeof d.say === 'string' ? ` ${d.say}` : '';
        const text = granted ? `[fake] running with ${granted}${word}` : lurk ? `[fake] interjecting${word}` : `[fake] hello from the fake CLI${word}`;
        const r = await mcpCall('chat_send', { channel: meta.channelId, message: text, ...(thread ? { thread } : {}), client_key: `${meta.deliveryKey}:1` });
        posted = r.isError ? 'error' : 'ok';
    }
    trace.posted = posted;

    if (lurk && !d.interject) {
        emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: '[pass]', usage: usage(tokens), permission_denials: denials });
        trace.outcome = 'pass';
    } else {
        const summary = `fake run: ${edits.length} file(s) edited${denials.length ? `, ${denials.length} denied` : ''}${posted ? ', posted a reply' : ''}`;
        emit({ type: 'assistant', message: { id: 'msg_final', role: 'assistant', content: [{ type: 'text', text: summary }], usage: usage(tokens) }, session_id: sessionId });
        emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify({ summary }), structured_output: { summary },
            usage: usage(tokens), permission_denials: denials, num_turns: 1 });
        trace.outcome = 'success';
    }
    writeTrace(stateDir, trace);
}

function writeTrace(stateDir, trace) {
    if (!stateDir) return;
    try { appendFileSync(join(stateDir, 'fake-runs.jsonl'), JSON.stringify(trace) + '\n'); } catch { /* best effort */ }
}

main().catch(err => {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: `fake-claude crashed: ${String(err?.message ?? err).slice(0, 200)}` });
    process.exit(1);
});

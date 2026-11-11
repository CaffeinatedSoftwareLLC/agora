#!/usr/bin/env node
// A fake NemoClaw CLI for agora-host's tests (agora-host/test/nemoclaw.test.ts): no NVIDIA key,
// no Docker, no sandbox. It answers the commands agora-host runs, as NemoClaw v0.0.143 documents
// them (docs.nvidia.com/nemoclaw/latest/reference/commands):
//   nemoclaw --version                                       -> "nemoclaw v0.0.143"
//   nemoclaw <sandbox> status --json                         -> { found, agent, provider, model }
//   nemoclaw <sandbox> agent --session-id <id> --json ...    -> one OpenClaw turn (prompt on stdin),
//                                                               printed as the gateway envelope
//   nemoclaw <sandbox> mcp add|remove|status ...             -> exit 0 (add needs --env's variable set)
// In an agent box (the image's /etc/agora-box marker, or settings.mode "openclaw") it plays
// OpenClaw, which the nemoclaw adapter runs there (box/Dockerfile links it as /opt/agora/bin/nemoclaw):
//   openclaw --version                                       -> "OpenClaw 2026.11.3 (0000000)"
//   openclaw agent exec --json --config <f> --cwd <d> ...    -> one turn (prompt on stdin), the exec envelope;
//                                                               the config must hold mcp.servers.agora
// Settings come from `<this file>.json` next to it, not the environment (agora-host passes a run
// only the OS variables): { log, version, agent, found, turn, mode }.
//   log: append one JSON line per call (argv, stdin, which variables were set)
//   version (default 0.0.143), agent (default openclaw), found (false = no such sandbox)
//   turn: 'ok' (default), 'error' (meta.error incomplete_turn, exit 1), 'garbage'
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const env = process.env;
const settingsFile = `${process.argv[1]}.json`;
const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
const openclaw = settings.mode === 'openclaw' || existsSync('/etc/agora-box');

function readStdin() {
    return new Promise(resolve => {
        if (process.stdin.isTTY) return resolve('');
        let text = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { text += chunk; });
        process.stdin.on('end', () => resolve(text));
        process.stdin.on('error', () => resolve(text));
    });
}

function log(entry) {
    if (!settings.log) return;
    appendFileSync(settings.log, JSON.stringify({
        argv: args, cwd: process.cwd(),
        set: ['AGORA_MCP_TOKEN', 'AGORA_BOT_TOKEN', 'NEMOCLAW_DISABLE_TELEMETRY', 'NEMOCLAW_NON_INTERACTIVE'].filter(k => env[k] !== undefined),
        tokenInArgv: args.some(a => /bot_/.test(a)),
        ...entry,
    }) + '\n');
}

const flag = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };

if (args[0] === '--version' || args[0] === '-v') {
    log({});
    console.log(openclaw ? `OpenClaw ${settings.version ?? '2026.11.3'} (0000000)` : `nemoclaw v${settings.version ?? '0.0.143'}`);
    process.exit(0);
}

if (args[0] === 'agent' && args[1] === 'exec') {
    const prompt = await readStdin();
    let config = null;
    try { config = JSON.parse(readFileSync(flag('--config'), 'utf8')); } catch { /* checked below */ }
    const server = config?.mcp?.servers?.agora;
    log({ stdinBytes: Buffer.byteLength(prompt), stdinHead: prompt.slice(0, 200), model: flag('--model'), cwdFlag: flag('--cwd'),
        mcp: server ? { command: server.command, args: server.args, envNames: Object.keys(server.env ?? {}).sort() } : null,
        toolSearch: config?.tools?.toolSearch ?? null, nvidiaKey: env.NVIDIA_API_KEY !== undefined });
    const fail = (message, code = 1) => {
        console.log(JSON.stringify({ ok: false, status: 'error', final: '', payloads: [], model: null, provider: null, sessionId: 'f0000000-0000-4000-8000-000000000000', error: { kind: 'exception', message } }));
        process.exit(code);
    };
    if (!server || !server.command) fail('no agora MCP server in the config');
    if ((settings.turn ?? 'ok') === 'error') fail('Couldn\'t sign in to the AI service.');
    const lurk = /passive lurk run/.test(prompt);
    const text = lurk ? '[pass]' : JSON.stringify({ summary: 'Handled in a box' });
    console.log(JSON.stringify({ ok: true, status: 'ok', final: text, payloads: [{ text, mediaUrl: null }],
        usage: { input: 900, output: 60, cacheRead: 0, cacheWrite: 0, total: 960 }, assistantTurns: 1,
        model: (flag('--model') ?? 'nvidia/x').replace(/^nvidia\//, ''), provider: 'nvidia', sessionId: 'f0000000-0000-4000-8000-000000000001' }));
    process.exit(0);
}

const [sandbox, command, sub] = args;
if (command === 'status') {
    log({});
    console.log(JSON.stringify({ schemaVersion: 1, name: sandbox, found: settings.found !== false,
        agent: settings.agent ?? 'openclaw', provider: 'nvidia-prod', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', phase: 'Ready' }));
    process.exit(0);
}

if (command === 'mcp') {
    log({ sub });
    if (sub === 'add') {
        const name = flag('--env');
        if (!name || name.includes('=')) { console.error('--env KEY is required; inline KEY=VALUE is rejected'); process.exit(2); }
        if (!env[name]) { console.error(`${name} is not set`); process.exit(1); }
        if (!/^https:\/\//.test(flag('--url') ?? '')) { console.error('All endpoints must use HTTPS.'); process.exit(1); }
    }
    process.exit(0);
}

if (command === 'agent') {
    const prompt = await readStdin();
    const sessionId = flag('--session-id');
    log({ stdinBytes: Buffer.byteLength(prompt), stdinHead: prompt.slice(0, 200), worktreeNote: prompt.includes('NemoClaw sandbox') });
    if (!sessionId && !flag('--agent')) { console.error('No target session selected'); process.exit(2); }
    if (!args.includes('--json')) { console.log('Done.'); process.exit(0); }
    const mode = settings.turn ?? 'ok';
    if (mode === 'garbage') { console.log('not json'); process.exit(0); }
    const usage = { input: 1200, output: 80, cacheRead: 300, cacheWrite: 20 };
    if (mode === 'error') {
        console.log(JSON.stringify({ status: 'ok', result: { payloads: [], meta: { durationMs: 10, error: { kind: 'incomplete_turn', message: 'turn ended early' },
            agentMeta: { sessionId, provider: 'nvidia', model: 'nemotron', usage } } } }));
        process.exit(1);
    }
    const lurk = /passive lurk run/.test(prompt);
    const text = lurk ? '[pass]' : JSON.stringify({ summary: `Handled ${sessionId}` });
    console.log(JSON.stringify({ status: 'ok', result: {
        payloads: [{ text: 'thinking...', isReasoning: true }, { text }],
        meta: { durationMs: 1200, agentMeta: { sessionId, provider: 'nvidia', model: flag('--model') ?? 'nemotron', usage, costUsd: 0 } } } }));
    process.exit(0);
}

log({ unknown: true });
console.error(`fake nemoclaw: unknown command ${args.join(' ')}`);
process.exit(2);

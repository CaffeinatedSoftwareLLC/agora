#!/usr/bin/env node
// Fake Claude Code and Codex CLIs for the box test image (box/Dockerfile, target "test").
// They answer the headless modes agora-host drives just enough for its parsers
// (adapters.ts parseOutput): --version with a verified version, one turn, and the login
// commands the box login relay runs (box-login.ts). Installed as /opt/agora/bin/claude and
// /opt/agora/bin/codex; the name it is called by picks the CLI.
//
// Every call records its arguments and the names (never values) of its environment
// variables in <state dir>/.fake-last-call.json, so isolation tests can check what a CLI saw.
import { randomUUID, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const cli = basename(process.argv[1]).includes('codex') ? 'codex' : 'claude';
const args = process.argv.slice(2);
const stateDir = cli === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
const marker = stateDir ? join(stateDir, '.fake-login') : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function record() {
    if (!stateDir) return;
    try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, '.fake-last-call.json'), JSON.stringify({ cli, args, envNames: Object.keys(process.env).sort(), cwd: process.cwd() }));
    } catch { /* read-only or missing state dir: nothing to record */ }
}
async function readStdin() {
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    return data;
}
function readLine() {
    return new Promise(resolve => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => {
            data += chunk;
            const i = data.indexOf('\n');
            if (i >= 0) { process.stdin.destroy(); resolve(data.slice(0, i).trim()); }
        });
        process.stdin.on('end', () => resolve(data.trim()));
    });
}
const loggedIn = () => (marker && existsSync(marker)) || !!(cli === 'codex' ? process.env.CODEX_API_KEY : process.env.ANTHROPIC_API_KEY);

/** What a real agent does with its Agora tools: one reply in the wake's channel. */
async function reply() {
    const { AGORA_INSTANCE: instance, AGORA_BOT_TOKEN: token, AGORA_DEFAULT_CHANNEL: channel } = process.env;
    if (!instance || !token || !channel) return;
    try {
        const res = await fetch(new URL(`/channels/${channel}/messages`, instance), {
            method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `fake-${cli} reply` }), signal: AbortSignal.timeout(10000),
        });
        await res.body?.cancel();
    } catch { /* the turn still succeeds; the test looks at the message */ }
}
const out = event => process.stdout.write(`${JSON.stringify(event)}\n`);

async function claude() {
    if (args[0] === '--version') { console.log('2.1.311 (Claude Code)'); return 0; }
    if (args[0] === 'auth' && args[1] === 'login') {
        const state = randomUUID();
        process.stdout.write(`Opening browser to sign in…\nBrowser didn't open? Use the url below to sign in:\n\n`
            + `\x1b]8;;https://claude.ai/oauth/authorize?code=true&client_id=fake&state=${state}\x07https://claude.ai/oauth/authorize?code=true&client_id=fake&state=${state}\x1b]8;;\x07\n\n`
            + 'Paste code here if prompted > ');
        const code = await readLine();
        if (!code || code === 'wrong') { console.log('\nOAuth error: Invalid code'); return 1; }
        mkdirSync(stateDir, { recursive: true }); writeFileSync(marker, 'fake claude login\n', { mode: 0o600 });
        console.log('\nLogin successful.');
        return 0;
    }
    if (args[0] !== '-p') { console.error('fake claude: unsupported arguments'); return 2; }
    await readStdin();
    const i = args.indexOf('--resume');
    const session = i >= 0 ? args[i + 1] : randomUUID();
    out({ type: 'system', subtype: 'init', session_id: session });
    if (!loggedIn()) {
        out({ type: 'result', subtype: 'success', is_error: true, session_id: session, result: 'Not logged in · Please run /login', usage: { input_tokens: 0, output_tokens: 0 } });
        return 1;
    }
    await reply();
    const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    out({ type: 'assistant', message: { id: `msg_${randomUUID()}`, usage } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: '{"summary":"fake claude turn"}',
        structured_output: { summary: 'fake claude turn' }, usage });
    return 0;
}

async function codex() {
    if (args[0] === '--version') { console.log('codex-cli 0.163.0'); return 0; }
    if (args[0] === 'login' && args[1] === '--device-auth') {
        const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const pick = n => Array.from({ length: n }, () => letters[randomInt(letters.length)]).join('');
        process.stdout.write('\nWelcome to Codex [v\x1b[90m0.163.0\x1b[0m]\n\x1b[90mOpenAI\'s command-line coding agent\x1b[0m\n\n'
            + 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n'
            + '1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n'
            + `2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m${pick(4)}-${pick(5)}\x1b[0m\n\n`);
        // Tests steer the login with files in the state dir (the env is agora-host's allowlist)
        const knob = name => { try { return readFileSync(join(stateDir, name), 'utf8').trim(); } catch { return null; } };
        await sleep(Number(knob('.fake-login-delay-ms') ?? 3000));
        if (knob('.fake-login-fail') !== null) { console.log('Error logging in: device code expired'); return 1; }
        mkdirSync(stateDir, { recursive: true }); writeFileSync(marker, 'fake codex login\n', { mode: 0o600 });
        console.log('Successfully logged in');
        return 0;
    }
    if (args[0] !== 'exec') { console.error('fake codex: unsupported arguments'); return 2; }
    await readStdin();
    const i = args.indexOf('resume');
    const thread = i >= 0 ? args[i + 1] : randomUUID();
    out({ type: 'thread.started', thread_id: thread });
    if (!loggedIn()) {
        out({ type: 'error', message: 'Not logged in' });
        out({ type: 'turn.failed', error: { message: 'Not logged in' } });
        return 1;
    }
    await reply();
    out({ type: 'turn.started' });
    out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '{"summary":"fake codex turn"}' } });
    out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
    return 0;
}

record();
process.exitCode = await (cli === 'codex' ? codex() : claude());

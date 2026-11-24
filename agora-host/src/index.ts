#!/usr/bin/env node
import { loadConfig } from './config.js';
import { verifyProfile } from './adapters.js';
import { Client, errorCode } from './client.js';
import { ProcessRunner } from './process.js';
import { Scheduler } from './scheduler.js';
import { describeAuth, HostConfigError, profileReport } from './terms.js';
import { siwcCommand } from './siwc/cli.js';
import { autostartCommand } from './autostart.js';
import { creditLine } from './openrouter.js';
import { boxConfigCommand, inBox, missingCli } from './box.js';
import { boxRelayCommand } from './box-shell.js';
import { runAsAgentServer } from './box-as-agent.js';
import { liveLoop } from './live-terminal.js';
import { devinCommand } from './devin.js';

/**
 * The box has no CLI for its agent: keep the host (and the owner's terminal) up, tell Agora why every
 * minute (that also keeps the box "seen"), and claim no runs.
 */
async function idleWithoutCli(config: Awaited<ReturnType<typeof loadConfig>>, absent: Record<string, ReturnType<typeof missingCli>>) {
    const client = new Client(config.instance, config.hostToken);
    const report = profileReport(config.profiles).map(p => ({ ...p, cliMissing: absent[p.name] ?? null }));
    for (const [name, m] of Object.entries(absent)) console.error(`WARNING: profile ${name} (${config.profiles[name]!.adapter}): its CLI is not in this box image (${m!.code}: ${m!.detail}). Agents on it cannot start; other agents are unaffected.`);
    const shell = new AbortController();
    void runAsAgentServer(config, { signal: shell.signal, log: code => console.error(code) }).catch(() => console.error('as_agent_loop_failed'));
    const send = async () => { try { await client.reportProfiles(report); } catch (err) { console.error(`profile_report_failed ${errorCode(err)}`); } };
    await send();
    const timer = setInterval(() => void send(), 60_000);
    await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    clearInterval(timer); shell.abort();
}

async function main() {
    // agora-host siwc <login|status|logout> --profile <name> --config <file> (docs/codex-chatgpt-plan.md)
    if (process.argv[2] === 'siwc') { process.exitCode = await siwcCommand(process.argv.slice(3)); return; }
    // agora-host autostart <enable|disable|status> --config <file>: start the host at login (README: Start automatically)
    if (process.argv[2] === 'autostart') { process.exitCode = await autostartCommand(process.argv.slice(3)); return; }
    // agora-host box-config --repos | --state | --out <file>: the agent box entrypoint's config (box.ts)
    if (process.argv[2] === 'box-config') { process.exitCode = await boxConfigCommand(process.argv.slice(3)); return; }
    // agora-host box-relay --token-fd <n>: the owner's terminal relay, a process of its own user (box-shell.ts)
    if (process.argv[2] === 'box-relay') { process.exitCode = await boxRelayCommand(process.argv.slice(3)); return; }
    // agora-host devin login --profile <name> --config <file> [--paste]: a Devin profile's own login (devin.ts)
    if (process.argv[2] === 'devin') { process.exitCode = await devinCommand(process.argv.slice(3)); return; }
    if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('usage');
    const config = await loadConfig(process.argv[3]);
    // A box whose image was built without this agent's CLI (its download was not available): nothing to verify
    // or run. Report it so Agora shows the reason and refuses to start the agent, and stay up (docs/agent-boxes.md §6.1)
    const absent = inBox() ? Object.entries(config.profiles).map(([name, p]) => [name, missingCli(p.adapter)] as const).filter(([, m]) => m !== null) : [];
    if (absent.length) { await idleWithoutCli(config, Object.fromEntries(absent)); return; }
    for (const [name, profile] of Object.entries(config.profiles)) {
        const version = await verifyProfile(profile);
        const via = profile.protocol === 'acp' ? ` over ACP (${version})` : '';
        console.log(`Verified ${profile.adapter}${via}; hard token cap unavailable; using lease, timeout and server session budget.`);
        console.log(describeAuth(name, profile));
        // opencode on OpenRouter: the key's credit limit is the spend cap (openrouter.ts). Not in a
        // box: agora-host's own requests reach only the edge, and the CLI's go through its proxy
        const credit = inBox() ? null : await creditLine(name, profile);
        if (credit) console.log(credit);
    }
    if (inBox()) console.log('Agent box: the CLI runs without its own sandbox or permission prompts; the box and its edge are the boundary.');
    const client = new Client(config.instance, config.hostToken);
    // Agora applies the subscription rule from this report; the host enforces it too
    try { await client.reportProfiles(profileReport(config.profiles)); } catch (err) { console.error(`profile_report_failed ${errorCode(err)}`); }
    const scheduler = new Scheduler(config, client, new ProcessRunner(), { log: code => console.error(code) });
    // as-agent (docs/box-terminal.md): box mode only. The owner's terminal is NOT here: it is another
    // process of another user (box-relay), so nothing of the terminal passes through the agent's host.
    const shell = new AbortController();
    void runAsAgentServer(config, { signal: shell.signal, log: code => console.error(code) }).catch(() => console.error('as_agent_loop_failed'));
    // Live terminals (docs/planning/live-terminals.md): box mode only; the agent's own interactive CLI, owned by this process
    void liveLoop({ instance: config.instance, token: config.hostToken, config, signal: shell.signal, enabled: s => client.liveEnabled(s), log: code => console.error(code) }).catch(() => console.error('live_loop_failed'));
    process.once('SIGINT', () => { shell.abort(); void scheduler.stop(); });
    process.once('SIGTERM', () => { shell.abort(); void scheduler.stop(); });
    try { await scheduler.run(); } finally {
        // The host is done (stopped, or its token was refused): the as-agent server goes with it, so the
        // process ends as it always did and a box's restart policy can start it again
        shell.abort();
    }
}
main().catch(err => {
    // Never print raw config, API responses, CLI output or exceptions containing credentials.
    // A HostConfigError's message is fixed text (provider terms, missing key variable names).
    if (err instanceof HostConfigError) console.error(err.message);
    console.error('Host failed. Check local config, executable versions and CLI login. Usage: agora-host --config <absolute-file> | agora-host autostart <enable|disable|status> --config <absolute-file> | agora-host siwc <login|status|logout> --profile <name> --config <absolute-file> | agora-host devin login --profile <name> --config <absolute-file>');
    process.exitCode = 1;
});

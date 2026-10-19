#!/usr/bin/env node
import { loadConfig } from './config.js';
import { verifyProfile } from './adapters.js';
import { Client } from './client.js';
import { ProcessRunner } from './process.js';
import { Scheduler } from './scheduler.js';
import { describeAuth, HostConfigError, profileReport } from './terms.js';

async function main() {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('usage');
    const config = await loadConfig(process.argv[3]);
    for (const [name, profile] of Object.entries(config.profiles)) {
        await verifyProfile(profile);
        console.log(`Verified ${profile.adapter}; hard token cap unavailable; using lease, timeout and server session budget.`);
        console.log(describeAuth(name, profile));
    }
    const client = new Client(config.instance, config.hostToken);
    // Agora applies the subscription rule from this report; the host enforces it too
    try { await client.reportProfiles(profileReport(config.profiles)); } catch { console.error('profile_report_failed'); }
    const scheduler = new Scheduler(config, client, new ProcessRunner(), { log: code => console.error(code) });
    process.once('SIGINT', () => { void scheduler.stop(); });
    process.once('SIGTERM', () => { void scheduler.stop(); });
    await scheduler.run();
}
main().catch(err => {
    // Never print raw config, API responses, CLI output or exceptions containing credentials.
    // A HostConfigError's message is fixed text (provider terms, missing key variable names).
    if (err instanceof HostConfigError) console.error(err.message);
    console.error('Host failed. Check local config, executable versions and CLI login. Usage: agora-host --config <absolute-file>');
    process.exitCode = 1;
});

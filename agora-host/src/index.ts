#!/usr/bin/env node
import { loadConfig } from './config.js';
import { verifyProfile } from './adapters.js';
import { Client } from './client.js';
import { ProcessRunner } from './process.js';
import { Scheduler } from './scheduler.js';

async function main() {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('usage');
    const config = await loadConfig(process.argv[3]);
    for (const profile of Object.values(config.profiles)) {
        await verifyProfile(profile);
        console.log(`Verified ${profile.adapter}; hard token cap unavailable; using lease, timeout and server session budget.`);
    }
    const scheduler = new Scheduler(config, new Client(config.instance, config.hostToken), new ProcessRunner(), { log: code => console.error(code) });
    process.once('SIGINT', () => { void scheduler.stop(); });
    process.once('SIGTERM', () => { void scheduler.stop(); });
    await scheduler.run();
}
main().catch(() => {
    // Never print raw config, API responses, CLI output or exceptions containing credentials.
    console.error('Host failed. Check local config, executable versions and CLI login. Usage: agora-host --config <absolute-file>');
    process.exitCode = 1;
});

import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { childEnv, ensureDevinDirs } from './adapters.js';

/**
 * `agora-host devin login --profile <name> --config <file>`: log a Devin profile in on this
 * machine (agora-host README, "Devin"). A Devin agent runs on the owner's own Devin login, kept
 * in the profile's state directory and never in the user's own Devin folders (adapters.ts
 * devinDirs), so it is logged in once with the same environment its runs get. This runs Devin's
 * own `devin auth login` in the terminal: the browser sign-in, or `--paste` for the flow that
 * prints a link and reads the code back (for a machine without a browser). The host never reads
 * the login it saves.
 */
export async function devinCommand(argv: string[], out: (line: string) => void = console.log): Promise<number> {
    const flag = (name: string) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
    const profile = flag('--profile'); const configPath = flag('--config');
    if (argv[0] !== 'login' || !profile || !configPath) {
        out('Usage: agora-host devin login --profile <name> --config <absolute-file> [--paste]');
        return 2;
    }
    const config = await loadConfig(configPath);
    const local = config.profiles[profile];
    if (local?.adapter !== 'devin') { out(`Profile "${profile}" is not a devin profile in this config.`); return 2; }
    await ensureDevinDirs(local);
    const args = ['auth', 'login', ...(argv.includes('--paste') ? ['--force-manual-token-flow'] : [])];
    out(`Logging ${profile} in to Devin. Use the Devin account this agent should run on: yours (only you can wake it).`);
    const code = await new Promise<number | null>(resolve => {
        const child = spawn(local.executable, args, { cwd: local.stateDir, env: childEnv(local), stdio: 'inherit', shell: false, windowsHide: false });
        child.once('error', () => resolve(null));
        child.once('close', resolve);
    });
    out(code === 0 ? `Logged in. ${profile}'s login is saved in its state directory only.` : 'Devin login did not finish.');
    return code === 0 ? 0 : 1;
}

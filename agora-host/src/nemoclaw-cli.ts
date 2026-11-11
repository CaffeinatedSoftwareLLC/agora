import { loadConfig, type LocalProfile } from './config.js';
import { nemoclawSetup, type NemoclawSettings } from './nemoclaw.js';

/**
 * `agora-host nemoclaw setup --profile <name> --config <file> [--bot <botId>] [--replace]`:
 * attach Agora's MCP endpoint to a NemoClaw profile's sandbox once, with the bot's token from
 * the config's botTokens (nemoclaw.ts). `--bot` picks the bot; it can be left out when the
 * config holds one token.
 */
export async function nemoclawCli(argv: string[], out: (line: string) => void = console.log): Promise<number> {
    const flag = (name: string) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
    const name = flag('--profile'); const configPath = flag('--config'); const bot = flag('--bot');
    if (argv[0] !== 'setup' || !name || !configPath) {
        out('Usage: agora-host nemoclaw setup --profile <name> --config <absolute-file> [--bot <botId>] [--replace]');
        return 2;
    }
    const config = await loadConfig(configPath);
    const profile = config.profiles[name];
    if (profile?.adapter !== 'nemoclaw' || !profile.nemoclaw) { out(`Profile "${name}" is not a nemoclaw profile with a "nemoclaw" block in this config.`); return 2; }
    const tokens = Object.entries(config.botTokens);
    const token = bot ? config.botTokens[bot] : tokens.length === 1 ? tokens[0][1] : undefined;
    if (!token) { out(bot ? `No token for bot ${bot} in botTokens.` : 'This config has several bot tokens: name the bot with --bot <botId>.'); return 2; }
    return nemoclawSetup(profile as LocalProfile & { nemoclaw: NemoclawSettings }, token, argv.includes('--replace'), out);
}

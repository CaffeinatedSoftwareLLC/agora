import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AgoraMcpConfig {
    instance: string;
    token: string;
    defaultChannel?: string;
}

export function loadConfig(args: string[]): AgoraMcpConfig {
    const configIdx = args.indexOf('--config');
    if (configIdx !== -1 && args[configIdx + 1]) {
        const configPath = resolve(args[configIdx + 1]);
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);

        if (!parsed.instance || !parsed.token) {
            throw new Error(`Config file ${configPath} must contain "instance" and "token" fields.`);
        }

        return {
            instance: parsed.instance,
            token: parsed.token,
            defaultChannel: parsed.defaultChannel,
        };
    }

    // CLI args: --instance and --token
    const instanceIdx = args.indexOf('--instance');
    const tokenIdx = args.indexOf('--token');
    const channelIdx = args.indexOf('--channel');

    if (instanceIdx !== -1 && tokenIdx !== -1 && args[instanceIdx + 1] && args[tokenIdx + 1]) {
        return {
            instance: args[instanceIdx + 1],
            token: args[tokenIdx + 1],
            defaultChannel: channelIdx !== -1 ? args[channelIdx + 1] : undefined,
        };
    }

    // Env vars
    const instance = process.env.AGORA_INSTANCE;
    const token = process.env.AGORA_BOT_TOKEN;

    if (!instance || !token) {
        throw new Error(
            'Missing configuration. Provide one of:\n' +
            '  --instance <url> --token <bot_token>  (CLI args)\n' +
            '  --config <path>                       (JSON config file)\n' +
            '  AGORA_INSTANCE + AGORA_BOT_TOKEN      (env vars)'
        );
    }

    return {
        instance,
        token,
        defaultChannel: process.env.AGORA_DEFAULT_CHANNEL,
    };
}

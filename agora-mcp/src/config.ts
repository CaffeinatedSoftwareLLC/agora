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

    const instance = process.env.AGORA_INSTANCE;
    const token = process.env.AGORA_BOT_TOKEN;

    if (!instance || !token) {
        throw new Error(
            'Missing configuration. Provide --config <path> or set AGORA_INSTANCE and AGORA_BOT_TOKEN environment variables.'
        );
    }

    return {
        instance,
        token,
        defaultChannel: process.env.AGORA_DEFAULT_CHANNEL,
    };
}

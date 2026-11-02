import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UploadConfig } from './local-upload.js';

export interface AgoraMcpConfig extends UploadConfig {
    instance: string;
    token: string;
    defaultChannel?: string;
}

export function loadUploadConfig(args: string[], parsed?: Record<string, unknown>): UploadConfig {
    const rootIndex = args.indexOf('--upload-root');
    if (rootIndex !== -1 && (!args[rootIndex + 1] || args[rootIndex + 1].startsWith('--'))) throw new Error('Missing value for --upload-root');
    const uploadRoot = rootIndex !== -1 ? args[rootIndex + 1] : parsed?.uploadRoot ?? process.env.AGORA_UPLOAD_ROOT;
    if (uploadRoot !== undefined && (typeof uploadRoot !== 'string' || !uploadRoot.trim())) throw new Error('uploadRoot must be a non-empty folder path.');
    const rawOutside = args.includes('--allow-outside-workdir') ? true : parsed?.allowOutsideWorkdir ?? process.env.AGORA_ALLOW_OUTSIDE_WORKDIR;
    let allowOutsideWorkdir: boolean | undefined;
    if (rawOutside !== undefined) {
        if (typeof rawOutside === 'boolean') allowOutsideWorkdir = rawOutside;
        else if (parsed?.allowOutsideWorkdir !== undefined) throw new Error('allowOutsideWorkdir must be a boolean.');
        else if (rawOutside === 'true' || rawOutside === '1') allowOutsideWorkdir = true;
        else if (rawOutside === 'false' || rawOutside === '0') allowOutsideWorkdir = false;
        else throw new Error('AGORA_ALLOW_OUTSIDE_WORKDIR must be true, false, 1 or 0.');
    }
    return { ...(uploadRoot !== undefined ? { uploadRoot: resolve(uploadRoot as string) } : {}),
        ...(allowOutsideWorkdir !== undefined ? { allowOutsideWorkdir } : {}) };
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
            ...loadUploadConfig(args, parsed),
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
            ...loadUploadConfig(args),
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
        ...loadUploadConfig(args),
    };
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

// Mock node:fs so we can control readFileSync
vi.mock('node:fs', () => ({
    readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';

const mockedReadFileSync = vi.mocked(readFileSync);

describe('loadConfig', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.resetAllMocks();
        // Clear relevant env vars before each test
        delete process.env.AGORA_INSTANCE;
        delete process.env.AGORA_BOT_TOKEN;
        delete process.env.AGORA_DEFAULT_CHANNEL;
    });

    afterEach(() => {
        // Restore original env
        process.env = { ...originalEnv };
    });

    it('parses --instance and --token CLI args', () => {
        const config = loadConfig(['--instance', 'http://x', '--token', 'tok']);
        expect(config).toEqual({
            instance: 'http://x',
            token: 'tok',
            defaultChannel: undefined,
        });
    });

    it('parses --instance, --token, and --channel CLI args', () => {
        const config = loadConfig(['--instance', 'http://x', '--token', 'tok', '--channel', 'general']);
        expect(config).toEqual({
            instance: 'http://x',
            token: 'tok',
            defaultChannel: 'general',
        });
    });

    it('parses --config file with all fields', () => {
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            instance: 'http://from-file',
            token: 'file-token',
            defaultChannel: 'dev',
        }));

        const config = loadConfig(['--config', '/path/to/config.json']);
        expect(config).toEqual({
            instance: 'http://from-file',
            token: 'file-token',
            defaultChannel: 'dev',
        });
        expect(mockedReadFileSync).toHaveBeenCalledOnce();
    });

    it('throws when config file is missing required fields', () => {
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            instance: 'http://from-file',
            // missing token
        }));

        expect(() => loadConfig(['--config', '/path/to/config.json']))
            .toThrow(/must contain "instance" and "token"/);
    });

    it('falls back to env vars when no CLI args provided', () => {
        process.env.AGORA_INSTANCE = 'http://env-instance';
        process.env.AGORA_BOT_TOKEN = 'env-token';
        process.env.AGORA_DEFAULT_CHANNEL = 'env-channel';

        const config = loadConfig([]);
        expect(config).toEqual({
            instance: 'http://env-instance',
            token: 'env-token',
            defaultChannel: 'env-channel',
        });
    });

    it('falls back to env vars without default channel', () => {
        process.env.AGORA_INSTANCE = 'http://env-instance';
        process.env.AGORA_BOT_TOKEN = 'env-token';

        const config = loadConfig([]);
        expect(config).toEqual({
            instance: 'http://env-instance',
            token: 'env-token',
            defaultChannel: undefined,
        });
    });

    it('throws with helpful message when no config is available', () => {
        expect(() => loadConfig([]))
            .toThrow(/Missing configuration/);
    });

    it('--config takes priority over --instance/--token', () => {
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            instance: 'http://from-file',
            token: 'file-token',
        }));

        const config = loadConfig(['--config', '/path/to/config.json', '--instance', 'http://cli', '--token', 'cli-tok']);
        expect(config.instance).toBe('http://from-file');
        expect(config.token).toBe('file-token');
    });
});

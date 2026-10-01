import { describe, it, expect, afterEach, vi } from 'vitest';

const REAL_KEY = 'a1'.repeat(32);
const saved = { ...process.env };

/** Load src/config.ts fresh with the given environment. */
async function loadConfig(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const [name, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    return import('../../src/config');
}

afterEach(() => {
    for (const name of ['NODE_ENV', 'AGORA_ENCRYPTION_KEY', 'JWT_SECRET']) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
    }
    vi.resetModules();
});

describe('production startup checks', () => {
    it('refuses to load without an encryption key', async () => {
        await expect(loadConfig({ NODE_ENV: 'production', AGORA_ENCRYPTION_KEY: '' })).rejects.toThrow(/AGORA_ENCRYPTION_KEY/);
    });

    it('refuses the all-zero default key', async () => {
        await expect(loadConfig({ NODE_ENV: 'production', AGORA_ENCRYPTION_KEY: '0'.repeat(64) })).rejects.toThrow(/not all zeros/);
    });

    it('refuses a placeholder JWT secret, in the API only', async () => {
        for (const secret of ['change-me-to-a-random-secret', 'dev-secret-do-not-use-in-prod']) {
            // Loading the module is fine (the runner and cap-gateway never set JWT_SECRET)...
            const { assertProductionJwtSecret } = await loadConfig({ NODE_ENV: 'production', AGORA_ENCRYPTION_KEY: REAL_KEY, JWT_SECRET: secret });
            // ...the API's own check is what refuses it
            expect(() => assertProductionJwtSecret()).toThrow(/JWT_SECRET/);
        }
    });

    it('accepts real secrets', async () => {
        const { config, assertProductionJwtSecret } = await loadConfig({ NODE_ENV: 'production', AGORA_ENCRYPTION_KEY: REAL_KEY, JWT_SECRET: 'f'.repeat(64) });
        expect(() => assertProductionJwtSecret()).not.toThrow();
        expect(config.encryptionKey.toString('hex')).toBe(REAL_KEY);
    });

    it('outside production, the defaults still load', async () => {
        const { config, assertProductionJwtSecret } = await loadConfig({ NODE_ENV: 'test', AGORA_ENCRYPTION_KEY: undefined, JWT_SECRET: undefined });
        expect(() => assertProductionJwtSecret()).not.toThrow();
        expect(config.encryptionKey.length).toBe(32);
    });
});

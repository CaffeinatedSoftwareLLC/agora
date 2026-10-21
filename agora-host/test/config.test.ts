import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema, loadConfig } from '../src/config.js';
import { config, tempDir } from './helpers.js';

describe('local JSON configuration', () => {
    it('explains the batch executable rule when loading an old verify command (#142)', async () => {
        const temp = await tempDir();
        try {
            const data = config(temp.dir); const path = join(temp.dir, 'host.local.json');
            data.profiles.builder.verify = { commands: ['npm.cmd test'], timeoutSeconds: 60 };
            await writeFile(path, JSON.stringify(data));
            await expect(loadConfig(path)).rejects.toThrow(
                "verify commands are plain words separated by single spaces, and the first word can't be a .cmd or .bat file");
        } finally { await temp.cleanup(); }
    });
    it('loads trusted absolute paths without accepting server-provided raw flags', async () => {
        const temp = await tempDir();
        try {
            const data = config(temp.dir); const path = join(temp.dir, 'host.local.json');
            await writeFile(data.mcp.entrypoint, ''); await writeFile(path, JSON.stringify(data));
            expect((await loadConfig(path)).profiles.builder.workdir).toBe(temp.dir);
            expect(configSchema.safeParse({ ...data, rawFlags: ['--dangerously-bypass-approvals-and-sandbox'] }).success).toBe(false);
            expect(configSchema.safeParse({ ...data, instance: 'http://user:password@localhost/' }).success).toBe(false);
        } finally { await temp.cleanup(); }
    });
    it('rejects shared CLI state and redacts malformed secret values', async () => {
        const temp = await tempDir();
        try {
            const data = config(temp.dir); const path = join(temp.dir, 'host.local.json');
            await writeFile(data.mcp.entrypoint, ''); data.profiles.other = { ...data.profiles.builder };
            await writeFile(path, JSON.stringify(data)); await expect(loadConfig(path)).rejects.toThrow('own CLI stateDir');
            await writeFile(path, JSON.stringify({ ...data, hostToken: 'DO_NOT_PRINT_THIS' }));
            let message = ''; try { await loadConfig(path); } catch (e) { message = (e as Error).message; }
            expect(message).not.toContain('DO_NOT_PRINT_THIS'); expect(message).toContain('Invalid host config');
        } finally { await temp.cleanup(); }
    });
});

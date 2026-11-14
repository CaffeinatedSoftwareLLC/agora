import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { asAgentEnv, runAsAgentServer } from '../src/box-as-agent.js';
import { boxMode } from '../src/box.js';
import { config, tempDir } from './helpers.js';

const saved = { marker: boxMode.marker, flag: process.env.AGORA_HOST_IN_BOX };
afterEach(() => {
    boxMode.marker = saved.marker;
    if (saved.flag === undefined) delete process.env.AGORA_HOST_IN_BOX; else process.env.AGORA_HOST_IN_BOX = saved.flag;
});

describe('the environment of as-agent commands', () => {
    it('is the agent\'s own CLI environment, with the image\'s CLI directory first and no token', async () => {
        const t = await tempDir();
        try {
            const marker = join(t.dir, 'agora-box');
            await writeFile(marker, 'agora-box 7\n');
            boxMode.marker = marker;
            const cfg = config(t.dir);
            cfg.profiles.builder.adapter = 'claude'; cfg.profiles.builder.proxyEnv = true;
            const env = asAgentEnv(cfg, {
                PATH: '/home/agent/.npm-global/bin:/usr/bin', HOME: '/home/agent', AGORA_HOST_IN_BOX: '1', LANG: 'en_US.UTF-8',
                AGORA_HOST_TOKEN: 'ah_secret.value', AGORA_BOT_TOKEN: 'bot_secret.value', AGORA_RELAY_TOKEN: 'ar_secret.value',
                HTTPS_PROXY: 'http://edge:3128', GITHUB_TOKEN: 'ghp_nope',
            }, () => true);
            expect(env.PATH).toBe('/opt/agora/bin:/home/agent/.npm-global/bin:/usr/bin');
            expect(env).toMatchObject({
                HOME: '/home/agent', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: cfg.profiles.builder.stateDir,
                HTTPS_PROXY: 'http://edge:3128', AGORA_WORKSPACE: cfg.profiles.builder.workdir, AGORA_OPERATOR_UID: '1001',
            });
            const all = JSON.stringify(env);
            for (const secret of ['ah_secret', 'bot_secret', 'ar_secret', 'ghp_nope']) expect(all).not.toContain(secret);
        } finally { await t.cleanup(); }
    });

    it('falls back to the scratch folder, then home, for the workspace', () => {
        const cfg = config('/home/agent/work/o/r');
        const base = { PATH: '/usr/bin', HOME: '/home/agent' };
        expect(asAgentEnv(cfg, base, p => p === '/home/agent/scratch').AGORA_WORKSPACE).toBe('/home/agent/scratch');
        expect(asAgentEnv(cfg, base, () => false).AGORA_WORKSPACE).toBe('/home/agent');
    });
});

describe('the as-agent server\'s supervisor', () => {
    class FakeChild extends EventEmitter { killed: string[] = []; kill(sig: string) { this.killed.push(sig); queueMicrotask(() => this.emit('exit', null)); return true; } }

    it('does nothing outside a box', async () => {
        delete process.env.AGORA_HOST_IN_BOX;
        let started = 0;
        await runAsAgentServer(config(), { signal: new AbortController().signal, log: () => {}, spawnServer: (() => { started++; return new FakeChild(); }) as any });
        expect(started).toBe(0);
    });

    it('in a box: starts the server with the agent\'s environment, starts it again when it ends, and stops it with the host', async () => {
        const t = await tempDir();
        try {
            const marker = join(t.dir, 'agora-box');
            await writeFile(marker, 'agora-box 7\n');
            boxMode.marker = marker; process.env.AGORA_HOST_IN_BOX = '1';
            const ctl = new AbortController();
            const children: FakeChild[] = []; const logs: string[] = [];
            const loop = runAsAgentServer(config(t.dir), {
                signal: ctl.signal, log: c => logs.push(c), retryMinMs: 5, retryMaxMs: 10, server: '/x/as-agent-server',
                spawnServer: ((server: string, env: NodeJS.ProcessEnv) => { expect(server).toBe('/x/as-agent-server'); expect(env.AGORA_OPERATOR_UID).toBe('1001'); const c = new FakeChild(); children.push(c); return c; }) as any,
            });
            const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(r => setTimeout(r, 5)); expect(check()).toBe(true); };
            await until(() => children.length === 1);
            children[0].emit('exit', 1);
            await until(() => children.length === 2);
            expect(logs).toContain('as_agent_server_ended 1');
            ctl.abort();
            await loop;
            expect(children[1].killed).toEqual(['SIGTERM']);
        } finally { await t.cleanup(); }
    });
});

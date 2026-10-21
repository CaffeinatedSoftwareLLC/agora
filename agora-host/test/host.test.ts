import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../src/client.js';
import { Scheduler } from '../src/scheduler.js';
import type { Launch } from '../src/adapters.js';
import { describeAuth, profileReport } from '../src/terms.js';
import { git } from '../src/workspaces.js';
import { claim, config, successful, tempDir } from './helpers.js';

afterEach(() => { vi.unstubAllEnvs(); });

/** Every file under `dir`, read as text (a canary scan of what the host wrote to disk). */
async function allFiles(dir: string): Promise<Array<{ path: string; text: string }>> {
    const out: Array<{ path: string; text: string }> = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await allFiles(path));
        else if (entry.isFile()) out.push({ path, text: await readFile(path, 'latin1') });
    }
    return out;
}

/**
 * beta-test-plan §6.1 "Host CLI keys never leave the host": an api_key run through the real
 * prepare(), the scheduler and the HTTP client against a fake Agora. The key reaches the CLI
 * child's environment and nothing else: no request body, log line, argv, wake prompt (stdin),
 * MCP config or other file the host wrote.
 */
it('keeps an api_key profile\'s CLI key inside the child env only (canary)', async () => {
    const CANARY = 'sk-ant-CANARY-6d1f0e2b9a7c4e55';
    vi.stubEnv('ANTHROPIC_API_KEY', CANARY);
    const t = await tempDir();
    const bodies: string[] = []; const urls: string[] = []; const logs: string[] = [];
    let claimed = false; let launched: Launch | undefined; let onDisk: Array<{ path: string; text: string }> = [];
    const delivery = claim();
    delivery.profile.adapter = 'claude'; delivery.profile.authMode = 'api_key'; delivery.profile.model = 'sonnet';
    delivery.run.heartbeatSeconds = 1;
    delivery.inbox = [{ ...delivery.inbox[0], reason: 'direct', authorBot: false, authority: 'owner', authorName: 'eryk', content: 'Ship it.' }];
    const server = createServer(async (req, res) => {
        let text = ''; for await (const part of req) text += part;
        urls.push(req.url!); if (text) bodies.push(text);
        res.setHeader('Content-Type', 'application/json');
        if (req.url!.includes('/workspace-commands/next') || req.url!.includes('/browser-previews/next') || req.url!.includes('/plan-requests/next')) {
            res.writeHead(204); res.end();
        } else if (req.url!.includes('/next')) {
            if (!claimed) { claimed = true; res.end(JSON.stringify(delivery)); }
            else { res.writeHead(401); res.end('{}'); }
        } else if (req.url!.endsWith('/images/discover')) {
            res.end('{"maxBytes":26214400,"messages":[]}');
        } else if (req.url!.includes('/heartbeat')) {
            res.end('{"cancel":false}');
        } else res.end('{"ok":true}');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
        await git(t.dir, ['init']);
        await git(t.dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
        const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
        const c = config(t.dir); c.maxConcurrent = 1;
        Object.assign(c.profiles.builder, { adapter: 'claude', auth: 'api_key', apiKeyEnv: 'ANTHROPIC_API_KEY' });
        const client = new Client(`http://127.0.0.1:${address.port}`, 'ah_test');
        // What index.ts does at start: the start-up line and the profile report
        logs.push(describeAuth('builder', c.profiles.builder));
        await client.reportProfiles(profileReport(c.profiles));
        const start = vi.fn((launch: Launch) => {
            launched = launch;
            // Snapshot what the host wrote before the run's cleanup removes it, then finish
            // after a heartbeat has gone out
            const result = (async () => {
                onDisk = await allFiles(t.dir);
                await new Promise(r => setTimeout(r, 1300));
                return { ...successful, summary: 'Shipped' };
            })();
            return { result, kill: vi.fn(async () => {}) };
        });
        // Real prepare(): no `prepare` option
        const scheduler = new Scheduler(c, client, { start }, { log: code => logs.push(code) });
        await scheduler.run();
        expect(start).toHaveBeenCalledOnce();
        const launch = launched!;

        // The key is in the child env, under its own variable only
        expect(launch.env.ANTHROPIC_API_KEY).toBe(CANARY);
        expect(Object.entries(launch.env).filter(([, v]) => v?.includes(CANARY)).map(([k]) => k)).toEqual(['ANTHROPIC_API_KEY']);
        // ...and nowhere else
        expect(launch.args.join('\n')).not.toContain(CANARY);
        expect(launch.stdin).toContain('Ship it.');
        expect(launch.stdin).not.toContain(CANARY);
        const mcpConfig = launch.args[launch.args.indexOf('--mcp-config') + 1];
        expect(onDisk.map(f => f.path)).toContain(mcpConfig);
        expect(onDisk.filter(f => f.text.includes(CANARY)).map(f => f.path)).toEqual([]);
        expect(urls.some(u => u.includes('/heartbeat'))).toBe(true);
        expect(urls.some(u => u.endsWith('/complete'))).toBe(true);
        expect(urls.some(u => u.endsWith('/profiles'))).toBe(true);
        expect(bodies.length).toBeGreaterThanOrEqual(3);
        expect(bodies.filter(b => b.includes(CANARY))).toEqual([]);
        expect(bodies.join('\n')).toContain('ANTHROPIC_API_KEY'); // reported by variable name
        expect(urls.join('\n')).not.toContain(CANARY);
        expect(logs.join('\n')).not.toContain(CANARY);
    } finally {
        server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
        await t.cleanup();
    }
});

it('drives one complete delivery through the HTTP client and scheduler with a fake child', async () => {
    let claimed = false; const reports: unknown[] = [];
    const server = createServer(async (req, res) => {
        let text = ''; for await (const part of req) text += part;
        expect(req.headers.authorization).toBe('AgentHost ah_test');
        res.setHeader('Content-Type', 'application/json');
        if (req.url!.includes('/workspace-commands/next') || req.url!.includes('/browser-previews/next')) {
            res.writeHead(204); res.end();
        } else if (req.url!.includes('/next')) {
            if (!claimed) { claimed = true; res.end(JSON.stringify(claim())); }
            else { res.writeHead(401); res.end('{}'); }
        } else if (req.url!.endsWith('/images/discover')) {
            res.end('{"maxBytes":26214400,"messages":[]}');
        } else {
            reports.push(JSON.parse(text)); res.end('{"ok":true}');
        }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
        const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
        const c = config(); c.maxConcurrent = 1;
        const start = vi.fn(() => ({ result: Promise.resolve(successful), kill: vi.fn(async () => {}) }));
        const scheduler = new Scheduler(c, new Client(`http://127.0.0.1:${address.port}`, 'ah_test'), { start }, {
            prepare: async () => ({ executable: 'fake.exe', args: [], cwd: '', env: {}, stdin: '', adapter: 'codex', cleanup: async () => {} }),
        });
        await scheduler.run(); expect(start).toHaveBeenCalledOnce();
        expect(reports).toEqual([{ claimToken: 'rt_test', tokensUsed: 100, nativeSessionId: successful.nativeSessionId, summary: 'Finished' }]);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

it('keeps delivering runs against an older server without the workspace command or preview queues', async () => {
    let claimed = false, commandPolls = 0; const logs: string[] = [];
    const server = createServer(async (req, res) => {
        for await (const _ of req) { /* drain */ }
        res.setHeader('Content-Type', 'application/json');
        if (req.url!.includes('/workspace-commands/next') || req.url!.includes('/browser-previews/next')) { commandPolls++; res.writeHead(404); res.end('{}'); }
        else if (req.url!.includes('/next')) {
            if (!claimed) { claimed = true; res.end(JSON.stringify(claim())); }
            else { res.writeHead(401); res.end('{}'); }
        } else if (req.url!.endsWith('/images/discover')) res.end('{"maxBytes":26214400,"messages":[]}');
        else res.end('{"ok":true}');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
        const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
        const c = config(); c.maxConcurrent = 1;
        const start = vi.fn(() => ({ result: Promise.resolve(successful), kill: vi.fn(async () => {}) }));
        const scheduler = new Scheduler(c, new Client(`http://127.0.0.1:${address.port}`, 'ah_test'), { start }, {
            log: code => logs.push(code),
            prepare: async () => ({ executable: 'fake.exe', args: [], cwd: '', env: {}, stdin: '', adapter: 'codex', cleanup: async () => {} }),
        });
        await scheduler.run();
        expect(start).toHaveBeenCalledOnce(); expect(commandPolls).toBe(2);
        expect(logs).toContain('workspace_commands_unsupported');
        expect(logs).toContain('previews_unsupported');
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

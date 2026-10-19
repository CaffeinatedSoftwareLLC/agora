import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { Client } from '../src/client.js';
import { Scheduler } from '../src/scheduler.js';
import { claim, config, successful } from './helpers.js';

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

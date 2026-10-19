import { access, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedUrl, browserArgs, capture, CdpPipe, runPreview, sessionPorts, type PreviewCommand } from '../src/preview.js';
import { Client } from '../src/client.js';
import { Scheduler } from '../src/scheduler.js';
import type { HostApi } from '../src/types.js';
import { config, id, tempDir } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function previewConfig(extra: object = {}) {
    const t = await tempDir(); cleanups.push(t.cleanup);
    return { browser: process.execPath, stateDir: t.dir, portBase: 42000, portsPerSession: 10, slots: 3, ...extra };
}
const cmd = (url: string): PreviewCommand => ({ id: id(30), claimToken: 'claim-token', sessionId: id(2), profile: 'builder', workdirAlias: 'agora',
    url, options: { width: 800, height: 600, fullPage: false } });

describe('session port ranges', () => {
    it('gives each session its own range, keeps it across calls and restarts, and refuses bad IDs', async () => {
        const p = await previewConfig();
        const a = await sessionPorts(p, id(1)), b = await sessionPorts(p, id(2));
        expect(a).toEqual({ first: 42000, last: 42009 }); expect(b).toEqual({ first: 42010, last: 42019 });
        expect(await sessionPorts(p, id(1))).toEqual(a);
        expect(JSON.parse(await readFile(`${p.stateDir}/preview-ports.json`, 'utf8')).sessions[id(2)].slot).toBe(1);
        await expect(sessionPorts(p, '../etc')).rejects.toThrow('invalid_session');
    });
    it('reuses the least recently used slot of a session that is not running, never an active one', async () => {
        const p = await previewConfig();
        await sessionPorts(p, id(1), new Set(), 1); await sessionPorts(p, id(2), new Set(), 2); await sessionPorts(p, id(3), new Set(), 3);
        expect(await sessionPorts(p, id(4), new Set([id(1)]), 4)).toEqual({ first: 42010, last: 42019 });
        await expect(sessionPorts(p, id(5), new Set([id(1), id(3), id(4)]), 5)).rejects.toThrow('preview_ports_exhausted');
    });
    it('allocates concurrent requests without handing out a slot twice', async () => {
        const p = await previewConfig();
        const ranges = await Promise.all([1, 2, 3].map(n => sessionPorts(p, id(n))));
        expect(new Set(ranges.map(r => r.first)).size).toBe(3);
    });
});

describe('URL allowlist', () => {
    const range = { first: 42010, last: 42019 };
    it.each([
        ['http://localhost:42010/', true], ['http://127.0.0.1:42019/app?x=1', true], ['http://[::1]:42015/', true], ['ws://localhost:42011/hmr', false], ['wss://localhost:42011/hmr', false],
        ['http://localhost:42020/', false], ['http://localhost:3000/', false], ['http://localhost/', false], ['https://example.com:42010/', false],
        ['http://user:pw@localhost:42010/', false], ['file:///etc/passwd', false], ['data:text/html,hi', false], ['http://0.0.0.0:42010/', false],
    ])('%s → %s', (url, ok) => expect(allowedUrl(url, range)).toBe(ok));
    it('blocks everything off this machine at the browser level too', () => {
        const args = browserArgs('/tmp/profile', false);
        expect(args).toContain('--proxy-server=http://127.0.0.1:9');
        // Loopback is not exempt from the dead proxy; only the session's own ports go direct (WebSockets skip Fetch interception)
        const bypass = browserArgs('/tmp/profile', false, { first: 42000, last: 42001 }).find(x => x.startsWith('--proxy-bypass-list='))!;
        expect(bypass.split('=')[1].split(';')).toEqual(['<-loopback>', 'localhost:42000', '127.0.0.1:42000', '[::1]:42000', 'localhost:42001', '127.0.0.1:42001', '[::1]:42001']);
        expect(args.find(x => x.startsWith('--proxy-bypass-list='))).toBe('--proxy-bypass-list=<-loopback>');
        expect(args).toContain('--remote-debugging-pipe');
        expect(args).not.toContain('--no-sandbox');
        expect(browserArgs('/tmp/profile', true)).toContain('--no-sandbox');
    });
});

describe('DevTools pipe', () => {
    it('frames NUL-separated messages split across chunks and routes replies and events', async () => {
        const toBrowser = new PassThrough(), fromBrowser = new PassThrough();
        const cdp = new CdpPipe(toBrowser, fromBrowser);
        const events: string[] = []; cdp.on((method, _p, session) => events.push(`${method}@${session}`));
        const sent: string[] = []; toBrowser.on('data', (c: Buffer) => sent.push(c.toString()));
        const reply = cdp.send('Target.createTarget', { url: 'about:blank' });
        const failed = cdp.send('Page.navigate', {}, 'S1');
        await new Promise(r => setImmediate(r));
        expect(sent.join('')).toBe('{"id":1,"method":"Target.createTarget","params":{"url":"about:blank"}}\0{"id":2,"method":"Page.navigate","params":{},"sessionId":"S1"}\0');
        const wire = '{"method":"Page.loadEventFired","params":{},"sessionId":"S1"}\0{"id":1,"result":{"targetId":"T"}}\0{"id":2,"error":{"message":"bad"}}\0';
        fromBrowser.write(Buffer.from(wire.slice(0, 17))); fromBrowser.write(Buffer.from(wire.slice(17, 70))); fromBrowser.write(Buffer.from(wire.slice(70)));
        await expect(reply).resolves.toEqual({ targetId: 'T' });
        await expect(failed).rejects.toThrow('cdp_bad');
        expect(events).toEqual(['Page.loadEventFired@S1']);
        const pending = cdp.send('Browser.close'); fromBrowser.destroy();
        await expect(pending).rejects.toThrow('browser_closed');
    });
});

describe('running a claimed preview', () => {
    it('reports codes, never loading a URL outside the session range', async () => {
        const capturer = vi.fn();
        expect(await runPreview(config(), cmd('http://localhost:42000/'), new Set(), AbortSignal.timeout(1000), capturer)).toEqual({ success: false, error: 'preview_not_configured' });
        const c = { ...config(), preview: await previewConfig() };
        expect(await runPreview(c, { ...cmd('http://localhost:42000/'), profile: 'missing' }, new Set(), AbortSignal.timeout(1000), capturer)).toEqual({ success: false, error: 'profile_unavailable' });
        expect(await runPreview(c, { ...cmd('http://localhost:42000/'), workdirAlias: 'moved' }, new Set(), AbortSignal.timeout(1000), capturer)).toEqual({ success: false, error: 'profile_unavailable' });
        // Another session holds the first range, so id(2) gets the second; the first is refused
        await sessionPorts(c.preview, id(9));
        expect(await runPreview(c, cmd('http://localhost:42000/'), new Set(), AbortSignal.timeout(1000), capturer)).toEqual({ success: false, error: 'port_not_in_session_range' });
        expect(capturer).not.toHaveBeenCalled();
        capturer.mockRejectedValueOnce(new Error('/home/me/secret path in an error'));
        expect(await runPreview(c, cmd('http://localhost:42011/'), new Set(), AbortSignal.timeout(1000), capturer)).toEqual({ success: false, error: 'preview_failed' });
        capturer.mockResolvedValueOnce({ png: Buffer.from('png'), title: 'T', console: [] });
        expect(await runPreview(c, cmd('http://localhost:42011/'), new Set(), AbortSignal.timeout(1000), capturer)).toMatchObject({ success: true, capture: { title: 'T' } });
        expect(capturer).toHaveBeenLastCalledWith(process.execPath, 'http://localhost:42011/', { width: 800, height: 600, fullPage: false }, { first: 42010, last: 42019 }, expect.anything());
    });

    it('polls on its own loop and reports each outcome', async () => {
        const claimPreview = vi.fn().mockResolvedValueOnce(cmd('http://localhost:42000/')).mockResolvedValue(null);
        let scheduler!: Scheduler;
        const previewResult = vi.fn(async () => { void scheduler.stop(); });
        const api = { claim: vi.fn(async () => { await new Promise(r => setTimeout(r, 5)); return null; }), heartbeat: vi.fn(), complete: vi.fn(), fail: vi.fn(),
            claimPreview, previewResult } as unknown as HostApi;
        scheduler = new Scheduler(config(), api, { start: vi.fn() } as never, { commandPollMs: 5 });
        await scheduler.run();
        expect(previewResult).toHaveBeenCalledWith(expect.objectContaining({ id: id(30) }), { success: false, error: 'preview_not_configured' }, expect.anything());
    });
});

describe('result upload', () => {
    let server: Server | undefined;
    afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined; } });
    it('sends fields before the screenshot and retries a 5xx report', async () => {
        const bodies: { type: string; body: string }[] = [];
        server = createServer(async (req, res) => {
            let body = ''; for await (const chunk of req) body += chunk;
            bodies.push({ type: req.headers['content-type'] ?? '', body });
            res.writeHead(bodies.length === 1 ? 503 : 201, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
        });
        await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
        const port = (server.address() as { port: number }).port;
        const client = new Client(`http://127.0.0.1:${port}`, 'ah_test', fetch, undefined, 1);
        await client.previewResult(cmd('http://localhost:42000/'), { success: true, capture: { png: Buffer.from('PNGDATA'), title: 'Home', console: [{ level: 'error', text: 'boom' }] } });
        expect(bodies).toHaveLength(2);
        expect(bodies[1].type).toMatch(/^multipart\/form-data/);
        const order = ['claimToken', 'success', 'title', 'console', 'screenshot'].map(f => bodies[1].body.indexOf(`name="${f}"`));
        expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true);
        expect(bodies[1].body).toContain('PNGDATA');
        expect(bodies[1].body).toContain('[{"level":"error","text":"boom"}]');
    });
});

// A real headless Chromium, when one is installed (CI images and the dev container have one)
const browser = process.env.AGORA_TEST_BROWSER ?? '/opt/pw-browsers/chromium';
const haveBrowser = await access(browser).then(() => true, () => false);
describe.runIf(haveBrowser)('capture with a real browser', () => {
    let app: Server | undefined, other: Server | undefined;
    afterEach(async () => {
        for (const s of [app, other]) if (s) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
        app = other = undefined;
    });
    it('screenshots the page, collects the console and blocks requests outside the range', async () => {
        let otherHits = 0;
        other = createServer((_req, res) => { otherHits++; res.end('secret'); });
        await new Promise<void>(r => other!.listen(0, '127.0.0.1', r));
        const otherPort = (other.address() as { port: number }).port;
        app = createServer((req, res) => {
            if (req.url === '/data.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<!doctype html><title>Preview test</title><body style="background:#123"><h1>Hello</h1><script>
                console.log('ready', 42); console.error('something broke');
                fetch('/data.json').then(r => r.json()).then(d => console.info('same origin', d.ok));
                fetch('http://127.0.0.1:${otherPort}/').catch(() => console.warn('other port refused'));
                fetch('https://example.com/').catch(() => console.warn('internet refused'));
            </script></body>`);
        });
        await new Promise<void>(r => app!.listen(0, '127.0.0.1', r));
        const port = (app.address() as { port: number }).port;
        const result = await capture(browser, `http://127.0.0.1:${port}/`, { width: 640, height: 480, fullPage: false },
            { first: port, last: port }, AbortSignal.timeout(40000));
        expect(result.png.subarray(1, 4).toString()).toBe('PNG');
        expect(result.png.readUInt32BE(16)).toBe(640);
        expect(result.title).toBe('Preview test');
        const text = result.console.map(l => `${l.level}:${l.text}`);
        expect(text).toContain('log:ready 42');
        expect(text).toContain('error:something broke');
        expect(text).toContain('info:same origin true');
        expect(text).toContain('warning:other port refused');
        expect(text).toContain('warning:internet refused');
        expect(text.some(t => t.startsWith(`warning:Blocked request outside this session's ports: http://127.0.0.1:${otherPort}/`))).toBe(true);
        expect(otherHits).toBe(0);
    }, 60000);
    it('takes a full-page screenshot and reports an unreachable page by code', async () => {
        app = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<body style="margin:0"><div style="height:1500px"></div></body>'); });
        await new Promise<void>(r => app!.listen(0, '127.0.0.1', r));
        const port = (app.address() as { port: number }).port;
        const full = await capture(browser, `http://localhost:${port}/`, { width: 400, height: 300, fullPage: true }, { first: port, last: port }, AbortSignal.timeout(40000));
        expect(full.png.readUInt32BE(20)).toBe(1500);
        await expect(capture(browser, `http://localhost:${port + 1}/`, { width: 400, height: 300, fullPage: false }, { first: port, last: port + 1 }, AbortSignal.timeout(40000)))
            .rejects.toThrow('page_unreachable');
    }, 60000);
});

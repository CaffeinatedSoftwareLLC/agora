import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { Config } from './config.js';

/**
 * Browser preview (docs/canvas-and-preview.md). An agent asks for a screenshot of a page its
 * session serves on localhost; the host renders it in a headless Chromium driven over the
 * DevTools protocol pipe (no extra dependency) and posts the PNG and console log back.
 *
 * The allowlist is a port range per session: the host hands each session its own range
 * (AGORA_PREVIEW_PORTS and the wake prompt) and only loopback URLs on those ports are
 * loaded. Every request the page makes is checked against the same range, and the browser
 * runs behind a dead proxy so nothing off this machine is reachable.
 */
export type PreviewConfig = NonNullable<Config['preview']>;
export interface PortRange { first: number; last: number }
export interface PreviewCommand {
    id: string; claimToken: string; sessionId: string; profile: string; workdirAlias: string; url: string;
    options: { width: number; height: number; fullPage: boolean };
}
export interface ConsoleLine { level: 'error' | 'warning' | 'info' | 'log' | 'debug'; text: string }
export interface Capture { png: Buffer; title: string; console: ConsoleLine[] }
export type PreviewOutcome = { success: true; capture: Capture } | { success: false; error: string; console?: ConsoleLine[] };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_LINES = 100, MAX_TEXT = 500, MAX_FULL_HEIGHT = 8000;

// ─── Port ranges ───

interface Allocation { slot: number; usedAt: number }
let allocationLock: Promise<unknown> = Promise.resolve();

/**
 * The session's port range, allocated once and kept in `preview-ports.json` so it survives
 * host restarts. When every slot is taken, the least recently used session not in `active`
 * gives its slot up.
 */
export function sessionPorts(preview: PreviewConfig, sessionId: string, active: ReadonlySet<string> = new Set(), now = Date.now()): Promise<PortRange> {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId)) return Promise.reject(new Error('invalid_session'));
    const run = allocationLock.then(async () => {
        const file = join(preview.stateDir, 'preview-ports.json');
        let table: Record<string, Allocation> = {};
        try { table = JSON.parse(await readFile(file, 'utf8')).sessions ?? {}; } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('preview_state_unreadable'); }
        let entry = table[sessionId];
        if (!entry || entry.slot >= preview.slots) {
            const taken = new Set(Object.entries(table).filter(([id]) => id !== sessionId).map(([, a]) => a.slot));
            let slot = [...Array(preview.slots).keys()].find(n => !taken.has(n));
            if (slot === undefined) {
                const victim = Object.entries(table).filter(([id]) => !active.has(id) && id !== sessionId).sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
                if (!victim) throw new Error('preview_ports_exhausted');
                slot = victim[1].slot; delete table[victim[0]];
            }
            entry = { slot, usedAt: now };
        }
        table[sessionId] = { ...entry, usedAt: now };
        await mkdir(preview.stateDir, { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify({ sessions: table }), { mode: 0o600 });
        await rename(temp, file);
        const first = preview.portBase + entry.slot * preview.portsPerSession;
        return { first, last: first + preview.portsPerSession - 1 };
    });
    allocationLock = run.catch(() => {});
    return run;
}

/** A loopback http(s) URL on a port in the range, with no credentials. WebSockets are not allowed: the page may not open them. */
export function allowedUrl(raw: string, range: PortRange): boolean {
    let u: URL;
    try { u = new URL(raw); } catch { return false; }
    if (!/^https?:$/.test(u.protocol) || !LOOPBACK.has(u.hostname) || u.username || u.password) return false;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return port >= range.first && port <= range.last;
}

// ─── DevTools protocol over the pipe ───

/** Chromium's --remote-debugging-pipe: JSON messages separated by NUL bytes on fds 3 (in) and 4 (out). */
export class CdpPipe {
    private next = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private handlers = new Set<(method: string, params: any, sessionId?: string) => void>();
    private chunks: Buffer[] = [];
    private closed: Error | null = null;
    constructor(private input: Writable, output: Readable) {
        output.on('data', (chunk: Buffer) => this.receive(chunk));
        const end = () => this.close(new Error('browser_closed'));
        output.on('close', end); output.on('error', end); input.on('error', end);
    }
    private receive(chunk: Buffer) {
        let start = 0, at: number;
        while ((at = chunk.indexOf(0, start)) >= 0) {
            this.chunks.push(chunk.subarray(start, at));
            const raw = Buffer.concat(this.chunks).toString('utf8'); this.chunks = []; start = at + 1;
            let message: any;
            try { message = JSON.parse(raw); } catch { continue; }
            if (typeof message.id === 'number') {
                const p = this.pending.get(message.id); this.pending.delete(message.id);
                if (message.error) p?.reject(new Error(`cdp_${String(message.error.message ?? 'error')}`)); else p?.resolve(message.result ?? {});
            } else if (typeof message.method === 'string') for (const h of this.handlers) h(message.method, message.params ?? {}, message.sessionId);
        }
        if (start < chunk.length) this.chunks.push(chunk.subarray(start));
    }
    close(err: Error) {
        if (this.closed) return;
        this.closed = err;
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
    }
    on(handler: (method: string, params: any, sessionId?: string) => void) { this.handlers.add(handler); }
    send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
        if (this.closed) return Promise.reject(this.closed);
        const id = ++this.next;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
        });
    }
}

const remoteText = (a: any): string => a?.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value))
    : String(a?.unserializableValue ?? a?.description ?? a?.type ?? '');
const LEVELS: Record<string, ConsoleLine['level']> = { error: 'error', assert: 'error', warning: 'warning', warn: 'warning', info: 'info', debug: 'debug', verbose: 'debug' };

/** Text the agent and the channel will read: one line per entry, no control characters, bounded. */
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, MAX_TEXT);

export function browserArgs(userDataDir: string, root = process.getuid?.() === 0, range?: PortRange): string[] {
    // Chromium sends loopback direct by default, WebSockets included (they never reach Fetch interception).
    // <-loopback> turns that off, so only the session's own ports are listed as direct; any other loopback port meets the dead proxy.
    const direct = ['<-loopback>'];
    if (range) for (let port = range.first; port <= range.last; port++) direct.push(`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`);
    return ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps',
        '--disable-features=Translate,MediaRouter,OptimizationHints', '--mute-audio', '--hide-scrollbars',
        '--proxy-server=http://127.0.0.1:9', `--proxy-bypass-list=${direct.join(';')}`, '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--force-webrtc-ip-handling-policy',
        // Chromium refuses to run its own sandbox as root (containers); a normal host keeps it
        ...(root ? ['--no-sandbox'] : []), 'about:blank'];
}

/** Load the URL, wait for it to settle, and take the screenshot and console log. */
export async function capture(browser: string, url: string, options: PreviewCommand['options'], range: PortRange, signal: AbortSignal): Promise<Capture> {
    if (!allowedUrl(url, range)) throw new Error('port_not_in_session_range');
    const profileDir = await mkdtemp(join(tmpdir(), 'agora-preview-'));
    let child: ChildProcess | undefined;
    try {
        child = spawn(browser, browserArgs(profileDir, undefined, range), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
        const spawned = new Promise<never>((_, reject) => { child!.once('error', () => reject(new Error('browser_not_started'))); child!.once('exit', () => reject(new Error('browser_exited'))); });
        spawned.catch(() => {});
        const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
        const aborted = new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new Error('preview_timeout'));
            signal.addEventListener('abort', () => reject(new Error('preview_timeout')), { once: true });
        });
        aborted.catch(() => {});
        const step = <T>(p: Promise<T>) => Promise.race([p, spawned, aborted]);

        const lines: ConsoleLine[] = [];
        const log = (level: ConsoleLine['level'], text: string) => { if (lines.length < MAX_LINES) lines.push({ level, text: clean(text) }); };
        let session = '';
        const events = new Map<string, () => void>();
        cdp.on((method, params, sessionId) => {
            if (sessionId !== session) return;
            if (method === 'Fetch.requestPaused') {
                const ok = allowedUrl(params.request?.url ?? '', range);
                if (!ok) log('warning', `Blocked request outside this session's ports: ${String(params.request?.url ?? '').slice(0, 300)}`);
                void cdp.send(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: 'BlockedByClient' }, session).catch(() => {});
            } else if (method === 'Runtime.consoleAPICalled') {
                log(LEVELS[params.type] ?? 'log', (params.args ?? []).map(remoteText).join(' '));
            } else if (method === 'Runtime.exceptionThrown') {
                const d = params.exceptionDetails ?? {};
                log('error', d.exception?.description ?? d.text ?? 'Uncaught exception');
            } else if (method === 'Log.entryAdded') {
                log(LEVELS[params.entry?.level] ?? 'log', `${params.entry?.text ?? ''}${params.entry?.url ? ` (${params.entry.url})` : ''}`);
            } else if (method === 'Page.loadEventFired') events.get('load')?.();
            else if (method === 'Page.lifecycleEvent' && params.name === 'networkIdle') events.get('idle')?.();
        });
        const waitFor = (name: string, ms: number) => new Promise<void>(resolve => {
            const timer = setTimeout(resolve, ms);
            events.set(name, () => { clearTimeout(timer); resolve(); });
        });

        const { targetId } = await step(cdp.send('Target.createTarget', { url: 'about:blank' }));
        session = (await step(cdp.send('Target.attachToTarget', { targetId, flatten: true }))).sessionId;
        for (const [method, params] of [
            ['Fetch.enable', { patterns: [{ urlPattern: '*' }] }], ['Page.enable', {}], ['Runtime.enable', {}], ['Log.enable', {}],
            ['Page.setLifecycleEventsEnabled', { enabled: true }],
            ['Emulation.setDeviceMetricsOverride', { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: options.width < 600 }],
        ] as const) await step(cdp.send(method, params, session));

        const loaded = waitFor('load', 15000), idle = waitFor('idle', 18000);
        const nav = await step(cdp.send('Page.navigate', { url }, session));
        if (nav.errorText) throw new Error(/BLOCKED/i.test(nav.errorText) ? 'port_not_in_session_range' : 'page_unreachable');
        await step(loaded);
        await step(Promise.race([idle, new Promise(r => setTimeout(r, 3000))]));
        await step(new Promise(r => setTimeout(r, 300)));

        const title = (await step(cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, session))).result?.value;
        let shot: { data: string };
        if (options.fullPage) {
            const metrics = await step(cdp.send('Page.getLayoutMetrics', {}, session));
            const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: options.width, height: options.height };
            shot = await step(cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
                clip: { x: 0, y: 0, width: Math.min(Math.ceil(size.width), 1920), height: Math.min(Math.ceil(size.height), MAX_FULL_HEIGHT), scale: 1 } }, session));
        } else shot = await step(cdp.send('Page.captureScreenshot', { format: 'png' }, session));
        await cdp.send('Browser.close').catch(() => {});
        return { png: Buffer.from(shot.data, 'base64'), title: typeof title === 'string' ? clean(title).slice(0, 200) : '', console: lines };
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(r => child!.once('exit', r));
            await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]);
            if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]); }
        }
        await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
}

/** Run one claimed preview. Errors are codes only: never local paths or browser output. */
export async function runPreview(config: Config, cmd: PreviewCommand, active: ReadonlySet<string>, signal: AbortSignal,
    capturer: typeof capture = capture): Promise<PreviewOutcome> {
    const local = config.profiles[cmd.profile];
    if (!config.preview) return { success: false, error: 'preview_not_configured' };
    if (!local || local.workdirAlias !== cmd.workdirAlias) return { success: false, error: 'profile_unavailable' };
    try {
        const range = await sessionPorts(config.preview, cmd.sessionId, active);
        if (!allowedUrl(cmd.url, range)) return { success: false, error: 'port_not_in_session_range' };
        return { success: true, capture: await capturer(config.preview.browser, cmd.url, cmd.options, range, signal) };
    } catch (err) {
        const code = err instanceof Error ? err.message : '';
        return { success: false, error: /^[a-z][a-z_]{0,100}$/.test(code) ? code : 'preview_failed' };
    }
}

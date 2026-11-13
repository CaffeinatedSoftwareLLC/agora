import { redact } from './workspaces.js';

/**
 * Live output (docs/live-output.md): what a running agent writes and does, as a small event
 * shape every adapter maps to. Two kinds of event:
 *
 *   text  the assistant's visible reply, as deltas of one message (`message` names it)
 *   step  one tool call: `start` with a short human label, later `ok` or `failed`
 *
 * Never in an event: the agent's reasoning, file contents, command output, environment values
 * or tokens. Labels are built here from the tool and its arguments, with paths relative to the
 * workspace and command lines passed through the host's secret redaction.
 */
export interface TextEvent { type: 'text'; message: string; delta: string }
export interface StepEvent { type: 'step'; step: string; state: 'start' | 'ok' | 'failed'; tool?: string; label?: string }
export type StreamEvent = TextEvent | StepEvent;
export type StreamSink = (event: StreamEvent) => void;

/** The batching that protects the server (docs/live-output.md). */
export const STREAM_BATCH = {
    /** A batch is sent at most this often. */
    intervalMs: 400,
    /** Events in one request. */
    maxEvents: 100,
    /** Characters (JSON) in one request. */
    maxChars: 32 * 1024,
    /** Characters in one text delta; longer text is split. */
    maxDelta: 4000,
    /** Events held while the server is slow; beyond it the oldest text is dropped. */
    maxBuffered: 2000,
    /** Failed requests in a row before the host stops sending for this run. */
    maxFailures: 5,
} as const;
const MAX_LABEL = 120;
const MAX_CMD = 100;

/** `p` relative to the workspace, with forward slashes; outside it, only the file's name. */
export function relPath(cwd: string, p: string): string {
    const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '');
    const c = norm(cwd), q = norm(p);
    const ci = /^[A-Za-z]:/.test(c);
    const a = ci ? c.toLowerCase() : c, b = ci ? q.toLowerCase() : q;
    if (b === a) return '.';
    if (b.startsWith(`${a}/`)) return q.slice(c.length + 1);
    if (!/^([A-Za-z]:)?\//.test(q) && !q.startsWith('../') && q !== '..') return q.replace(/^\.\//, '');
    return `…/${q.split('/').pop() ?? ''}`;
}

const SHELL_WRAPPERS = [
    // powershell.exe -NoProfile -Command '...' (what Codex runs on Windows)
    /^(?:"[^"]*(?:powershell|pwsh)(?:\.exe)?"|\S*(?:powershell|pwsh)(?:\.exe)?)\s+(?:-\w+\s+)*-Command\s+([\s\S]*)$/i,
    // bash -lc '...', sh -c "..."
    /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]*)$/,
    /^cmd(?:\.exe)?\s+\/c\s+([\s\S]*)$/i,
];
function unquote(text: string): string {
    const m = /^(["'])([\s\S]*)\1$/.exec(text.trim());
    return m ? m[2] : text.trim();
}

/** A command line as a short label: wrapper dropped, first line, workspace path as ".", env values and secrets redacted. */
export function commandLabel(command: string, cwd: string): string {
    let text = command.trim();
    for (const wrapper of SHELL_WRAPPERS) {
        const m = wrapper.exec(text);
        if (m) { text = unquote(m[1]); break; }
    }
    const root = cwd.replace(/[\\/]+$/, '');
    if (root) text = text.split(root).join('.').split(root.replace(/\\/g, '/')).join('.');
    text = text.split(/\r?\n/)[0];
    // NAME=value assignments: the value is never shown
    text = text.replace(/(^|\s)([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g, '$1$2=…');
    text = redact(text).replace(/\s+/g, ' ').trim();
    if (text.length > MAX_CMD) text = `${text.slice(0, MAX_CMD - 1)}…`;
    return text ? `Ran ${text}` : 'Ran a command';
}

const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

/** The step for a Claude Code tool call. The label never carries file contents or command output. */
export function claudeStep(name: string, input: unknown, cwd: string): { tool: string; label: string } {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const path = (...keys: string[]) => { for (const k of keys) { const v = str(i[k]); if (v) return relPath(cwd, v); } return null; };
    let label: string;
    switch (name) {
        case 'Read': label = `Read ${path('file_path') ?? 'a file'}`; break;
        case 'Edit': case 'MultiEdit': label = `Edited ${path('file_path') ?? 'a file'}`; break;
        case 'Write': label = `Wrote ${path('file_path') ?? 'a file'}`; break;
        case 'NotebookEdit': label = `Edited ${path('notebook_path') ?? 'a notebook'}`; break;
        case 'Bash': case 'PowerShell': label = commandLabel(str(i.command) ?? '', cwd); break;
        case 'Grep': label = 'Searched the code'; break;
        case 'Glob': label = `Listed ${redact(str(i.pattern) ?? 'files').slice(0, 80)}`; break;
        case 'WebFetch': { let host = 'a page'; try { host = new URL(String(i.url)).hostname || host; } catch { /* not a URL */ } label = `Fetched ${host}`; break; }
        case 'WebSearch': label = 'Searched the web'; break;
        case 'Task': case 'Agent': label = 'Ran a subagent'; break;
        case 'TodoWrite': label = 'Updated the plan'; break;
        default: {
            const mcp = /^mcp__([^_].*?)__(.+)$/.exec(name);
            label = mcp ? `Used ${mcp[1]}: ${mcp[2]}` : `Used ${name}`;
        }
    }
    return { tool: name.slice(0, 40), label: clip(label.replace(/[\r\n]+/g, ' ')) };
}

/**
 * Claude Code `--output-format stream-json --verbose --include-partial-messages`, line by line.
 * Text arrives as `text_delta` stream events; the complete `assistant` message that follows is
 * used only when no deltas were seen for it (a run without partial messages). Tool calls come from
 * the complete assistant message (its input is whole there) and end at the matching `tool_result`.
 * Thinking blocks and sub-agent events are ignored.
 */
export function claudeStream(cwd: string) {
    const streamed = new Set<string>();
    let current = 'm';
    return {
        push(line: string): StreamEvent[] {
            let e: any;
            try { e = JSON.parse(line); } catch { return []; }
            if (!e || typeof e !== 'object' || e.parent_tool_use_id) return [];
            if (e.type === 'stream_event') {
                const ev = e.event;
                if (ev?.type === 'message_start' && typeof ev.message?.id === 'string') current = ev.message.id;
                if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string' && ev.delta.text) {
                    streamed.add(current);
                    return [{ type: 'text', message: current, delta: ev.delta.text }];
                }
                return [];
            }
            if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
                const id = typeof e.message.id === 'string' ? e.message.id : current;
                const out: StreamEvent[] = [];
                for (const block of e.message.content) {
                    if (block?.type === 'text' && typeof block.text === 'string' && block.text && !streamed.has(id))
                        out.push({ type: 'text', message: id, delta: block.text });
                    else if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string')
                        out.push({ type: 'step', step: block.id, state: 'start', ...claudeStep(block.name, block.input, cwd) });
                }
                return out;
            }
            if (e.type === 'user' && Array.isArray(e.message?.content)) {
                const out: StreamEvent[] = [];
                for (const block of e.message.content)
                    if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
                        out.push({ type: 'step', step: block.tool_use_id, state: block.is_error ? 'failed' : 'ok' });
                return out;
            }
            return [];
        },
    };
}

/**
 * The step for an ACP tool call (`tool_call` update): by its kind, with the first location (made
 * relative to the workspace) when it has one. `think` calls are reasoning and give no step.
 * The agent's own title is used only for kinds that have no better label, redacted.
 */
export function acpStep(u: any, cwd: string): { tool: string; label: string } | null {
    const kind = str(u?.kind) ?? 'other';
    if (kind === 'think') return null;
    const title = str(u?.title) ?? '';
    const loc = Array.isArray(u?.locations) ? str(u.locations[0]?.path) : null;
    const where = loc ? relPath(cwd, loc) : null;
    const generic = () => {
        const root = cwd.replace(/[\\/]+$/, '');
        let t = redact(title); if (root) t = t.split(root).join('.');
        t = t.replace(/\s+/g, ' ').trim();
        if (!t) t = kind === 'other' ? 'Used a tool' : `Used ${kind}`;
        return t;
    };
    let label: string;
    switch (kind) {
        case 'read': label = where ? `Read ${where}` : generic(); break;
        case 'edit': label = where ? `Edited ${where}` : 'Edited a file'; break;
        case 'delete': label = where ? `Deleted ${where}` : 'Deleted a file'; break;
        case 'move': label = where ? `Moved ${where}` : 'Moved a file'; break;
        case 'search': label = 'Searched'; break;
        case 'fetch': label = 'Fetched a page'; break;
        case 'execute': label = commandLabel(title.replace(/^run\s+/i, '').replace(/^`([\s\S]*)`$/, '$1'), cwd); break;
        default: label = generic();
    }
    return { tool: kind.slice(0, 40), label: clip(label) };
}

/** `Edited path`, or `Edited N files`. */
function editedLabel(paths: string[], cwd: string): string {
    const clean = [...new Set(paths)];
    return clean.length === 1 ? `Edited ${relPath(cwd, clean[0])}` : clean.length > 1 ? `Edited ${clean.length} files` : 'Edited files';
}

/**
 * `codex exec --json`, line by line. Codex reports a whole agent message when it is done (no
 * deltas), so the text arrives in one piece; commands, file changes, MCP calls and web searches
 * are steps. Reasoning items are ignored.
 */
export function codexStream(cwd: string) {
    const started = new Set<string>();
    return {
        push(line: string): StreamEvent[] {
            let e: any;
            try { e = JSON.parse(line); } catch { return []; }
            const item = e?.item;
            if (!item || typeof item !== 'object' || typeof item.id !== 'string') return [];
            if (e.type !== 'item.started' && e.type !== 'item.completed') return [];
            if (item.type === 'agent_message') {
                return e.type === 'item.completed' && typeof item.text === 'string' && item.text ? [{ type: 'text', message: item.id, delta: item.text }] : [];
            }
            let step: { tool: string; label: string } | null = null;
            if (item.type === 'command_execution') step = { tool: 'command', label: clip(commandLabel(str(item.command) ?? '', cwd)) };
            else if (item.type === 'file_change') {
                const paths = Array.isArray(item.changes) ? item.changes.map((c: any) => str(c?.path)).filter((p: string | null): p is string => !!p) : [];
                step = { tool: 'edit', label: clip(editedLabel(paths, cwd)) };
            } else if (item.type === 'mcp_tool_call') step = { tool: 'mcp', label: clip(`Used ${str(item.server) ?? 'tool'}: ${str(item.tool) ?? 'call'}`) };
            else if (item.type === 'web_search') step = { tool: 'web_search', label: 'Searched the web' };
            if (!step) return [];
            const out: StreamEvent[] = [];
            if (!started.has(item.id)) { started.add(item.id); out.push({ type: 'step', step: item.id, state: 'start', ...step }); }
            if (e.type === 'item.completed')
                out.push({ type: 'step', step: item.id, state: item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0) ? 'failed' : 'ok' });
            return out;
        },
    };
}

/**
 * `codex app-server` notifications (the ChatGPT-plan runs, siwc/appserver.ts): `item/agentMessage/delta`
 * carries text as it is written (the completed item is used only when no delta came), and
 * commandExecution, fileChange, mcpToolCall and webSearch items are steps.
 */
export function appServerStream(cwd: string) {
    const deltas = new Set<string>();
    const started = new Set<string>();
    return {
        push(method: string, params: any): StreamEvent[] {
            if (method === 'item/agentMessage/delta') {
                const id = str(params?.itemId); const delta = str(params?.delta);
                if (!id || !delta) return [];
                deltas.add(id);
                return [{ type: 'text', message: id, delta }];
            }
            if (method !== 'item/started' && method !== 'item/completed') return [];
            const item = params?.item; const id = str(item?.id);
            if (!id) return [];
            if (item.type === 'agentMessage') {
                return method === 'item/completed' && !deltas.has(id) && str(item.text) ? [{ type: 'text', message: id, delta: item.text }] : [];
            }
            let step: { tool: string; label: string } | null = null;
            if (item.type === 'commandExecution') step = { tool: 'command', label: clip(commandLabel(str(item.command) ?? '', cwd)) };
            else if (item.type === 'fileChange') {
                const paths = Array.isArray(item.changes) ? item.changes.map((c: any) => str(c?.path)).filter((p: string | null): p is string => !!p) : [];
                step = { tool: 'edit', label: clip(editedLabel(paths, cwd)) };
            } else if (item.type === 'mcpToolCall') step = { tool: 'mcp', label: clip(`Used ${str(item.server) ?? 'tool'}: ${str(item.tool) ?? 'call'}`) };
            else if (item.type === 'webSearch') step = { tool: 'web_search', label: 'Searched the web' };
            if (!step) return [];
            const out: StreamEvent[] = [];
            if (!started.has(id)) { started.add(id); out.push({ type: 'step', step: id, state: 'start', ...step }); }
            if (method === 'item/completed') out.push({ type: 'step', step: id, state: item.status === 'failed' || item.status === 'declined' ? 'failed' : 'ok' });
            return out;
        },
    };
}

/** Feed a child's stdout, which arrives in chunks, to a line parser. */
export function lineSplitter(onLine: (line: string) => void) {
    let rest = '';
    return {
        push(chunk: string) {
            rest += chunk;
            let i: number;
            while ((i = rest.indexOf('\n')) >= 0) { const line = rest.slice(0, i).replace(/\r$/, ''); rest = rest.slice(i + 1); if (line) onLine(line); }
            // A line that never ends is not an event: drop it rather than grow without bound
            if (rest.length > 1024 * 1024) rest = '';
        },
        end() { if (rest.trim()) onLine(rest.trim()); rest = ''; },
    };
}

type Send = (events: StreamEvent[]) => Promise<boolean | void>;
const permanent = (err: unknown) => { const s = (err as { status?: unknown })?.status; return s === 401 || s === 403 || s === 404 || s === 409; };

/**
 * Collects events, merges neighbouring text, and sends them in batches. A batch that fails is
 * dropped (the stream is ephemeral); a refusal (404 from an older server, 409 for a finished
 * run, or the server saying the owner turned it off) or too many failures in a row stops it.
 */
export class Streamer {
    private buffer: StreamEvent[] = [];
    private timer: ReturnType<typeof setInterval> | undefined;
    private inflight: Promise<void> | undefined;
    private failures = 0;
    off = false;
    constructor(private send: Send, private log: (code: string) => void = () => {}, intervalMs: number = STREAM_BATCH.intervalMs) {
        this.timer = setInterval(() => { void this.flush(); }, intervalMs);
        this.timer.unref?.();
    }
    /** Pass this to an adapter as its sink. */
    readonly emit: StreamSink = (event) => {
        if (this.off) return;
        const last = this.buffer[this.buffer.length - 1];
        if (event.type === 'text' && last?.type === 'text' && last.message === event.message && last.delta.length + event.delta.length <= STREAM_BATCH.maxDelta)
            last.delta += event.delta;
        else if (event.type === 'text') {
            for (let i = 0; i < event.delta.length; i += STREAM_BATCH.maxDelta)
                this.buffer.push({ type: 'text', message: event.message, delta: event.delta.slice(i, i + STREAM_BATCH.maxDelta) });
        } else this.buffer.push({ ...event });
        if (this.buffer.length > STREAM_BATCH.maxBuffered) {
            const drop = this.buffer.findIndex(x => x.type === 'text');
            this.buffer.splice(drop >= 0 ? drop : 0, 1);
        }
    };
    /** Send what is buffered (in batches), one request at a time. */
    flush(): Promise<void> {
        if (this.inflight) return this.inflight;
        const run: Promise<void> = this.drain().finally(() => { if (this.inflight === run) this.inflight = undefined; });
        this.inflight = run;
        return run;
    }
    private async drain(): Promise<void> {
        while (!this.off && this.buffer.length) {
            const batch: StreamEvent[] = []; let chars = 0;
            while (this.buffer.length && batch.length < STREAM_BATCH.maxEvents) {
                const size = JSON.stringify(this.buffer[0]).length;
                if (batch.length && chars + size > STREAM_BATCH.maxChars) break;
                batch.push(this.buffer.shift()!); chars += size;
            }
            try {
                const enabled = await this.send(batch);
                this.failures = 0;
                if (enabled === false) { this.stopSending(); this.log('live_output_off'); }
            } catch (err) {
                if (permanent(err)) { this.stopSending(); this.log('live_output_unavailable'); }
                else if (++this.failures >= STREAM_BATCH.maxFailures) { this.stopSending(); this.log('live_output_failing'); }
            }
        }
    }
    private stopSending() { this.off = true; this.buffer = []; }
    /** The run is over: send the rest, then stop. */
    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        await this.inflight;
        await this.flush();
        this.off = true;
    }
}

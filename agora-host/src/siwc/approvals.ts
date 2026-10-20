import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Claim, HostApi } from '../types.js';
import { allowedCall, executableTrust, reportable, ruleForCall, type ToolCallInfo } from '../acp/permissions.js';

/**
 * Codex app-server approvals (#93). With `approvalPolicy: "on-request"` Codex runs inside its
 * sandbox and asks the client before anything the sandbox doesn't allow. Each request is a
 * JSON-RPC server request with its own params and response (codex 0.163, verified with
 * `codex app-server generate-json-schema` and live runs; https://learn.chatgpt.com/docs/app-server#approvals):
 *
 * - `item/commandExecution/requestApproval` {threadId, turnId, itemId, approvalId?, kind?,
 *   command?, cwd?, reason?, networkApprovalContext?: {host, protocol}, availableDecisions?}
 *   → `{ decision: "accept" | "decline" | ... }`. A `networkApprovalContext` is a managed-network
 *   prompt: it asks for one host, so it is judged as a network request.
 * - `item/fileChange/requestApproval` {threadId, turnId, itemId, reason?, grantRoot?}
 *   → `{ decision }`. The changed paths are on the `fileChange` item from `item/started`.
 * - `item/permissions/requestApproval` {threadId, turnId, itemId, cwd, permissions:
 *   {network?, fileSystem?}} → `{ permissions: <granted subset>, scope: "turn" }`.
 * - `mcpServer/elicitation/request` → `{ action: "decline" }`; legacy `execCommandApproval` /
 *   `applyPatchApproval` → `{ decision: "denied" }`; anything else → a JSON-RPC error.
 *
 * The host answers only with one-time decisions (`accept`, a turn-scoped grant). It never
 * sends `acceptForSession`, execpolicy or network-policy amendments: anything remembered goes
 * through Agora's own "Always" (the profile's allow list), outside Codex's control.
 *
 * A request is approved when it matches the claim's rules (the same matching as ACP, incl.
 * #111's trusted-executable check); a file change or permission outside the session worktree
 * is declined without a card. Otherwise the host posts a tool-request card bound to this exact
 * request (thread, turn, item, request id) and holds the request until the card is decided,
 * the wait times out, Codex resolves the request itself or the run stops: all but an
 * approval decline. Every request must belong to the thread and turn the host started.
 */

export type Decision = 'once' | 'always' | 'deny';
export interface CardRequest { tool: string; key: string; detail: string | null }
/** Post a card for one request and wait for its decision. Rejects when no card could be posted. */
export type Ask = (req: CardRequest, signal: AbortSignal) => Promise<Decision>;

export interface ApprovalContext {
    /** The session worktree: every path must stay inside it. */
    cwd: string;
    /** Other directories that are the repository's (executableTrust). */
    roots: string[];
    env: NodeJS.ProcessEnv;
    rules: ReadonlySet<string>;
    ask?: Ask;
    threadId: string | null;
    turnId: string | null;
    /** Items from `item/started`, by id. */
    items: ReadonlyMap<string, any>;
    /** Per app-server process: a card key can't repeat across a restart. */
    nonce: string;
}

export interface Answer {
    response: { result: unknown } | { error: { code: number; message: string } };
    /** A rule the run was denied without a card being answered: reported for an after-run card. */
    denied?: string;
}

const DECLINE = { result: { decision: 'decline' } };
const NO_GRANT = { result: { permissions: {}, scope: 'turn' } };
const ACCEPT = { result: { decision: 'accept' } };
const UNSUPPORTED = { error: { code: -32601, message: 'Not supported by agora-host' } };

const scope = { threadId: z.string().min(1).max(200), turnId: z.string().min(1).max(200), itemId: z.string().min(1).max(200) };
const commandSchema = z.object({
    ...scope, approvalId: z.string().max(200).nullish(), kind: z.string().max(40).nullish(),
    command: z.string().max(32768).nullish(), cwd: z.string().max(4096).nullish(), reason: z.string().nullish(),
    networkApprovalContext: z.object({ host: z.string().max(253), protocol: z.string().max(20) }).passthrough().nullish(),
    availableDecisions: z.array(z.unknown()).nullish(),
}).passthrough();
const fileChangeSchema = z.object({ ...scope, grantRoot: z.string().max(4096).nullish() }).passthrough();
const fsSchema = z.object({
    read: z.array(z.string().max(4096)).nullish(), write: z.array(z.string().max(4096)).nullish(),
    entries: z.array(z.object({ access: z.string(), path: z.object({ type: z.string(), path: z.string().max(4096).optional() }).passthrough() }).passthrough()).nullish(),
}).passthrough();
const permissionsSchema = z.object({
    ...scope, cwd: z.string().max(4096).nullish(),
    permissions: z.object({ network: z.object({ enabled: z.boolean().nullish() }).passthrough().nullish(), fileSystem: fsSchema.nullish() }).passthrough(),
}).passthrough();

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
function within(root: string, target: string): boolean {
    const rel = path.relative(norm(root), norm(target));
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
/** Resolve links of the deepest existing ancestor (acp/permissions.ts does the same). */
async function realTarget(target: string): Promise<string> {
    let head = target; const tail: string[] = [];
    for (;;) {
        try { return path.join(await realpath(head), ...tail.reverse()); } catch {
            const parent = path.dirname(head);
            if (parent === head) return target;
            tail.push(path.basename(head)); head = parent;
        }
    }
}
/** Whether every path stays inside the worktree, links resolved. A missing or odd path is outside. */
export async function insideWorktree(cwd: string, paths: unknown[]): Promise<boolean> {
    if (!paths.length) return false;
    const root = await realTarget(path.resolve(cwd));
    for (const p of paths) {
        if (typeof p !== 'string' || !p || p.includes('\0')) return false;
        const abs = path.resolve(root, p);
        if (!within(root, abs) || !within(root, await realTarget(abs))) return false;
    }
    return true;
}

/**
 * Split Codex's display form of a command (shlex-joined argv, e.g.
 * `"C:\\Windows\\System32\\cmd.exe" /c 'curl -sI https://example.com'`) back into argv.
 * Null when the quoting doesn't parse.
 */
export function splitCommand(line: string): string[] | null {
    const out: string[] = [];
    let cur = '', has = false, i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === "'") {
            const end = line.indexOf("'", i + 1);
            if (end < 0) return null;
            cur += line.slice(i + 1, end); has = true; i = end + 1;
        } else if (ch === '"') {
            i++;
            for (;;) {
                if (i >= line.length) return null;
                const c = line[i];
                if (c === '"') { i++; break; }
                if (c === '\\' && i + 1 < line.length && '\\"$`\n'.includes(line[i + 1])) { cur += line[i + 1]; i += 2; continue; }
                cur += c; i++;
            }
            has = true;
        } else if (ch === '\\' && i + 1 < line.length) {
            cur += line[i + 1]; has = true; i += 2;
        } else if (/\s/.test(ch)) {
            if (has) { out.push(cur); cur = ''; has = false; }
            i++;
        } else { cur += ch; has = true; i++; }
    }
    if (has) out.push(cur);
    return out.length ? out : null;
}

export function requestKey(nonce: string, method: string, rpcId: unknown, p: { threadId: string; turnId: string; itemId: string; approvalId?: string | null }, part = ''): string {
    return createHash('sha256').update(JSON.stringify([nonce, method, rpcId, p.threadId, p.turnId, p.itemId, p.approvalId ?? null, part])).digest('hex');
}

/** One request's decision: allowed by the rules, else the card's. Unknown or failed → deny. */
async function decide(rule: string, allowed: boolean, key: string, detail: string | null, ctx: ApprovalContext, signal: AbortSignal): Promise<{ allow: boolean; denied?: string }> {
    if (allowed) return { allow: true };
    if (!reportable(rule)) return { allow: false };
    // Older server or no card flow: deny now, report the rule for the usual after-run card
    if (!ctx.ask || signal.aborted) return { allow: false, denied: rule };
    try {
        const d = await ctx.ask({ tool: rule, key, detail }, signal);
        return { allow: d === 'once' || d === 'always' };
    } catch {
        return { allow: false, denied: rule };
    }
}

const bound = (p: { threadId: string; turnId: string }, ctx: ApprovalContext) => !!ctx.threadId && !!ctx.turnId && p.threadId === ctx.threadId && p.turnId === ctx.turnId;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);

async function commandApproval(rpcId: unknown, params: unknown, ctx: ApprovalContext, signal: AbortSignal): Promise<Answer> {
    const parsed = commandSchema.safeParse(params);
    if (!parsed.success || !bound(parsed.data, ctx)) return { response: DECLINE };
    const p = parsed.data;
    // Only a command: writing to a running process's stdin isn't something a rule describes
    if (p.kind && p.kind !== 'command') return { response: DECLINE };
    // The host only ever accepts once; a prompt that doesn't offer that is declined
    if (p.availableDecisions && !p.availableDecisions.includes('accept')) return { response: DECLINE };
    const key = requestKey(ctx.nonce, 'item/commandExecution/requestApproval', rpcId, p);
    if (p.networkApprovalContext) {
        const host = p.networkApprovalContext.host;
        if (!/^[A-Za-z0-9.-]{1,200}$/.test(host)) return { response: DECLINE };
        const call: ToolCallInfo = { kind: 'fetch', rawInput: { url: `https://${host}/` } };
        const rule = ruleForCall(call) ?? 'network';
        const d = await decide(rule, allowedCall(call, ctx.rules), key, `network access to ${host}`, ctx, signal);
        return { response: d.allow ? ACCEPT : DECLINE, denied: d.denied };
    }
    const argv = typeof p.command === 'string' ? splitCommand(p.command) : null;
    if (!argv) return { response: DECLINE };
    // The command runs outside the sandbox once accepted: it must start in the worktree
    const cwd = p.cwd ?? ctx.cwd;
    if (!await insideWorktree(ctx.cwd, [cwd])) return { response: DECLINE };
    const call: ToolCallInfo = { kind: 'execute', rawInput: { command: argv, cwd } };
    const trust = await executableTrust(call, { cwd: ctx.cwd, roots: ctx.roots, rules: ctx.rules, env: ctx.env });
    const detail = oneLine(p.command!);
    // A program that isn't a trusted executable (a PowerShell cmdlet, a file in the repository)
    // can't be allowed by a narrow rule; only the whole shell, and the owner sees the command
    const rule = trust === 'ok' ? ruleForCall(call) : 'Bash';
    if (!rule) return { response: DECLINE };
    const d = await decide(rule, trust === 'ok' && allowedCall(call, ctx.rules), key, detail, ctx, signal);
    return { response: d.allow ? ACCEPT : DECLINE, denied: d.denied };
}

/** Paths a fileChange item touches: each change's path and any move destination. */
function changePaths(item: any): unknown[] | null {
    if (item?.type !== 'fileChange' || !Array.isArray(item.changes) || item.changes.length === 0) return null;
    const out: unknown[] = [];
    for (const c of item.changes) {
        out.push(c?.path);
        for (const k of ['move_path', 'movePath']) if (c?.kind && c.kind[k] != null) out.push(c.kind[k]);
    }
    return out;
}

async function fileChangeApproval(rpcId: unknown, params: unknown, ctx: ApprovalContext, signal: AbortSignal): Promise<Answer> {
    const parsed = fileChangeSchema.safeParse(params);
    if (!parsed.success || !bound(parsed.data, ctx)) return { response: DECLINE };
    const p = parsed.data;
    const paths = changePaths(ctx.items.get(p.itemId));
    if (!paths) return { response: DECLINE };
    // A session-wide root outside the worktree is never granted; one inside changes nothing,
    // since the host answers for this change only
    if (p.grantRoot && !await insideWorktree(ctx.cwd, [p.grantRoot])) return { response: DECLINE };
    if (!await insideWorktree(ctx.cwd, paths)) return { response: DECLINE };
    const key = requestKey(ctx.nonce, 'item/fileChange/requestApproval', rpcId, p);
    const allowed = allowedCall({ kind: 'edit' }, ctx.rules);
    const detail = paths.length === 1 ? `edit ${path.relative(ctx.cwd, path.resolve(ctx.cwd, String(paths[0])))}` : `edit ${paths.length} files`;
    const d = await decide('write', allowed, key, detail, ctx, signal);
    return { response: d.allow ? ACCEPT : DECLINE, denied: d.denied };
}

async function permissionsApproval(rpcId: unknown, params: unknown, ctx: ApprovalContext, signal: AbortSignal): Promise<Answer> {
    const parsed = permissionsSchema.safeParse(params);
    if (!parsed.success || !bound(parsed.data, ctx)) return { response: NO_GRANT };
    const p = parsed.data;
    const granted: Record<string, unknown> = {};
    let denied: string | undefined;
    if (p.permissions.network?.enabled) {
        const d = await decide('network', ctx.rules.has('network'), requestKey(ctx.nonce, 'item/permissions/requestApproval', rpcId, p, 'network'), 'network access', ctx, signal);
        if (d.allow) granted.network = { enabled: true }; else denied ??= d.denied;
    }
    const fs = p.permissions.fileSystem;
    if (fs && !signal.aborted) {
        // Only plain paths inside the worktree: no globs, special paths or anything outside
        const entries = fs.entries ?? [];
        const plain = entries.every(e => e.path.type === 'path' && typeof e.path.path === 'string' && ['read', 'write'].includes(e.access));
        const paths = [...(fs.read ?? []), ...(fs.write ?? []), ...entries.map(e => e.path.path)];
        if (plain && await insideWorktree(ctx.cwd, paths)) {
            const write = (fs.write?.length ?? 0) > 0 || entries.some(e => e.access === 'write');
            const d = write
                ? await decide('write', allowedCall({ kind: 'edit' }, ctx.rules), requestKey(ctx.nonce, 'item/permissions/requestApproval', rpcId, p, 'write'), 'write files in the worktree', ctx, signal)
                : { allow: true };
            if (d.allow) granted.fileSystem = { ...(fs.read ? { read: fs.read } : {}), ...(fs.write ? { write: fs.write } : {}), ...(fs.entries ? { entries: fs.entries } : {}) };
            else denied ??= d.denied;
        }
    }
    return { response: { result: { permissions: granted, scope: 'turn' } }, denied };
}

/** The answer to one app-server server request. Never throws; anything unexpected is denied. */
export async function answerServerRequest(rpcId: unknown, method: string, params: unknown, ctx: ApprovalContext, signal: AbortSignal): Promise<Answer> {
    try {
        switch (method) {
            case 'item/commandExecution/requestApproval': return await commandApproval(rpcId, params, ctx, signal);
            case 'item/fileChange/requestApproval': return await fileChangeApproval(rpcId, params, ctx, signal);
            case 'item/permissions/requestApproval': return await permissionsApproval(rpcId, params, ctx, signal);
            case 'mcpServer/elicitation/request': return { response: { result: { action: 'decline' } } };
            case 'execCommandApproval': case 'applyPatchApproval': return { response: { result: { decision: 'denied' } } };
            default: return { response: UNSUPPORTED };
        }
    } catch {
        return { response: method === 'item/permissions/requestApproval' ? NO_GRANT : /requestApproval$/.test(method) ? DECLINE : UNSUPPORTED };
    }
}

/** Why a held request stopped waiting; the card is closed with it. */
export type CloseReason = 'timeout' | 'resolved' | 'stopped';

/**
 * The card flow over the host API: post the card, poll its decision until the wait runs out or
 * the request is aborted, then close it. A decision made by then wins; otherwise deny.
 * Undefined when the server has no live tool requests (the after-run card is used instead).
 */
export function cardAsker(api: HostApi, claim: Claim, o: { waitMs: number; pollMs?: number; now?: () => number }): Ask | undefined {
    if (!api.openToolRequest || !api.toolRequest) return undefined;
    const open = api.openToolRequest.bind(api), poll = api.toolRequest.bind(api);
    const now = o.now ?? Date.now;
    const pollMs = o.pollMs ?? 2000;
    const decided = (status: string | undefined): Decision | null => status === 'once' || status === 'always' ? status : status === 'pending' ? null : 'deny';
    return async (req, signal) => {
        const waitSeconds = Math.min(3600, Math.max(10, Math.ceil(o.waitMs / 1000)));
        const deadline = now() + o.waitMs;
        // Not aborted mid-request: a card posted without the host knowing its id couldn't be closed
        const opened = await open(claim, { tool: req.tool, requestKey: req.key, waitSeconds, detail: req.detail });
        const first = decided(opened.status);
        if (first || !opened.id) return first ?? 'deny';
        const id = opened.id;
        for (;;) {
            if (signal.aborted || now() >= deadline) {
                const reason: CloseReason = signal.aborted ? (signal.reason === 'resolved' ? 'resolved' : 'stopped') : 'timeout';
                const closed = await poll(claim, id, reason).catch(() => null);
                return decided(closed?.status) ?? 'deny';
            }
            await new Promise<void>(resolve => {
                const timer = setTimeout(done, Math.max(1, Math.min(pollMs, deadline - now())));
                function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
                signal.addEventListener('abort', done, { once: true });
            });
            if (signal.aborted || now() >= deadline) continue;
            const r = await poll(claim, id).catch(() => null);
            const d = decided(r?.status);
            if (d) return d;
        }
    };
}

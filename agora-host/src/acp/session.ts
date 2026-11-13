import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import type { Launch } from '../adapters.js';
import { killTree, type RunningChild } from '../process.js';
import { oneLine } from '../envelope.js';
import { acpStep } from '../stream.js';
import { parseReset, RATE_LIMIT_TEXT } from '../signals.js';
import type { Progress, RateLimit, Result } from '../types.js';
import { allowedCall, locationsInside, outcome, reportable, ruleForCall, type ToolCallInfo } from './permissions.js';
import { approveChoice, ompApproval, ompRuleName, type OmpCall } from './omp.js';
import { AUTH_REQUIRED, Connection, METHOD_NOT_FOUND, RpcError } from './rpc.js';

/**
 * One Agora turn with an Agent Client Protocol agent (agentclientprotocol.com):
 * `gemini --acp`, claude-code-acp, codex-acp, `opencode acp`, `devin acp` or any other agent that speaks ACP v1.
 *
 * `initialize` → (`authenticate`, API-key profiles only) → `session/new`, or
 * `session/resume` / `session/load` with the stored session ID → the session mode, model and
 * effort through `session/set_config_option` (or legacy `session/set_mode` / `session/set_model`)
 * → one `session/prompt`.
 * The host advertises no file system or terminal capability, so the agent uses its own
 * tools in the session worktree, and every
 * tool call it may not run alone comes back as `session/request_permission`
 * (permissions.ts). `session/update`s give the progress line, plan and diff paths.
 *
 * Provider terms (terms.ts): the host never calls a login method. An API-key profile calls
 * only the `authenticate` method that reads its key variable and refuses to run if the agent
 * doesn't offer it, so it can't fall back to an account login in the profile's state.
 */

export const PROTOCOL_VERSION = 1;
const HOST_VERSION = '0.1.0';
const RPC_TIMEOUT_MS = 60000;
const MAX_TEXT = 64 * 1024;
/** Tool calls the host keeps track of in one turn. */
const MAX_CALLS = 5000;

export interface AcpServer { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
export interface AcpPlan {
    prompt: string;
    nativeSessionId: string | null;
    mcpServers: AcpServer[];
    model: string | null;
    effort: string | null;
    /** Allowed tool rules for this run: presets, "always" rules and one-time grants. */
    rules: string[];
    /** The API-key `authenticate` method to call first; null: never authenticate. */
    authMethod: string | null;
    /**
     * Yeet mode in an agent box (box-adapters.ts `yeet.acpAllowAll`): every permission request is
     * allowed, as the boxed CLIs run without prompts. Never set on a machine.
     */
    allowAll?: boolean;
    /** Under allowAll, the requests still refused: tool names (or titles) and ACP tool kinds. */
    allowAllExcept?: { names: string[]; kinds: string[] };
    /**
     * The session mode the turn runs in (Devin: "accept-edits" on a machine, "bypass" in a box),
     * set before the prompt, also on a resumed session, whose saved mode could be another one. An
     * agent that offers modes but not this one fails the run; one with no modes runs as it is.
     */
    sessionMode?: string;
    /** Bound for setup requests; the prompt itself is bounded by the run timeout. */
    rpcTimeoutMs?: number;
    /**
     * Approval prompts that come as ACP form elicitations (`elicitation/create`) rather than
     * permission requests: "omp" (acp/omp.ts). The host then advertises form elicitation and
     * answers those prompts from the rules; any other elicitation is declined.
     */
    elicitation?: 'omp';
    /** Where the agent process starts, when not the worktree (omp: its own home folder, acp/omp.ts). */
    spawnCwd?: string;
}

/** Errors a retry can't fix: configuration, login, agent support or a key out of credit. */
export const ACP_FATAL = new Set(['acp_protocol_unsupported', 'acp_auth_required', 'acp_api_key_auth_unavailable', 'native_resume_unsupported', 'acp_model_unavailable',
    'acp_mode_unavailable', 'credit_exhausted']);

/**
 * The provider refused the request because the API key has no credit left. opencode passes only
 * the provider's message (`Internal error: <message>`, errorName "APIError"), not the HTTP status,
 * so these are OpenRouter's texts for a 402 (no credits, key credit limit used up, a request
 * bigger than what is left) and a 403 budget stop. A 402 for credit held by requests still in
 * flight says "exceed available credits" and stays a plain, retryable failure.
 */
export const CREDIT_TEXT = /insufficient credits|requires more credits|can only afford|key limit exceeded|budget limit exceeded|credit limit (?:exceeded|reached)|out of credits?/i;
export const CREDIT_MESSAGE = 'The provider refused the run: its API key is out of credit or has used up its credit limit.';

class AcpFailure extends Error {
    constructor(public readonly code: string, public readonly rateLimit?: RateLimit, public readonly detail?: string) { super(code); }
}

export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const initSchema = z.object({
    protocolVersion: z.number().int(),
    agentCapabilities: z.object({
        loadSession: z.boolean().catch(false).default(false),
        sessionCapabilities: z.object({ resume: z.unknown().optional() }).passthrough().catch({}).default({}),
    }).passthrough().catch({ loadSession: false, sessionCapabilities: {} }).prefault({}),
    authMethods: z.array(z.object({ id: z.string(), type: z.string().optional() }).passthrough()).catch([]).default([]),
    agentInfo: z.object({ version: z.string().max(100).optional() }).passthrough().nullish().catch(null),
}).passthrough();
const optionSchema = z.object({ id: z.string(), type: z.string().optional(), category: z.string().nullish(), currentValue: z.unknown().optional(),
    options: z.array(z.unknown()).catch([]).default([]) }).passthrough();
const modesSchema = z.object({
    availableModes: z.array(z.object({ id: z.string().min(1).max(100) }).passthrough()).catch([]).default([]),
    currentModeId: z.string().nullish(),
}).nullish().catch(null);
const modelsSchema = z.object({
    availableModels: z.array(z.object({ modelId: z.string().min(1).max(200), name: z.string().optional() }).passthrough()).catch([]).default([]),
    currentModelId: z.string().nullish(),
}).catch({ availableModels: [] });
const permissionSchema = z.object({ sessionId: z.string(), toolCall: z.object({ toolCallId: z.string() }).passthrough(),
    options: z.array(z.object({ optionId: z.string(), kind: z.string() }).passthrough()) });

const initParams = (elicitation = false) => ({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...(elicitation ? { elicitation: { form: {} } } : {}) },
    clientInfo: { name: 'agora-host', title: 'Agora host', version: HOST_VERSION },
});

interface Agent { child: ChildProcessWithoutNullStreams; conn: Connection; closed(): boolean; failed(): boolean; closedEvent: Promise<void> }
function spawnAgent(launch: Pick<Launch, 'executable' | 'args' | 'cwd' | 'env'>, handlers: ConstructorParameters<typeof Connection>[2], spawnCwd?: string): Agent {
    const child = spawn(launch.executable, launch.args, {
        cwd: spawnCwd ?? launch.cwd, env: launch.env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let closed = false, failed = false, notifyClose!: () => void;
    const closedEvent = new Promise<void>(resolve => { notifyClose = resolve; });
    const conn = new Connection(child.stdout, child.stdin, handlers);
    // Drain stderr, but never forward it: an agent may echo secrets or user content.
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { failed = true; conn.close(new Error('spawn_failed')); notifyClose(); });
    child.on('close', () => { closed = true; conn.close(new Error('acp_agent_exited')); notifyClose(); });
    return { child, conn, closed: () => closed, failed: () => failed, closedEvent };
}

/** Values of a select config option, flattening groups. */
function values(option: z.infer<typeof optionSchema>): Array<{ value: string; name: string }> {
    const flat: Array<{ value: string; name: string }> = [];
    for (const item of option.options as any[]) {
        for (const o of Array.isArray(item?.options) ? item.options : [item])
            if (typeof o?.value === 'string') flat.push({ value: o.value, name: typeof o.name === 'string' ? o.name : o.value });
    }
    return flat;
}
function pick(option: z.infer<typeof optionSchema> | undefined, wanted: string): string | null {
    if (!option || option.type !== 'select') return null;
    const all = values(option), lower = wanted.toLowerCase();
    return (all.find(o => o.value === wanted) ?? all.find(o => o.value.toLowerCase() === lower || o.name.toLowerCase() === lower))?.value ?? null;
}

/** Only model IDs, never the agent's descriptions or raw RPC errors; bounded for the server. */
function modelUnavailable(wanted: string, option: z.infer<typeof optionSchema>): AcpFailure {
    const ids = [...new Set(values(option).map(o => o.value))];
    const list = ids.slice(0, 8).map(id => oneLine(id).slice(0, 200)).join(', ') || '(none advertised)';
    const more = ids.length > 8 ? ` (and ${ids.length - 8} more)` : '';
    return new AcpFailure('acp_model_unavailable', undefined,
        `Requested model "${oneLine(wanted).slice(0, 200)}" is unavailable. Available model IDs: ${list}${more}.`);
}

/** The run summary from the agent's final message: its JSON summary, else the text itself. */
export function summaryOf(text: string): string | null {
    const t = text.trim();
    if (!t) return null;
    // Without message IDs, earlier text of the same turn may come before the final [pass]
    if (/(?:^|\s)\[pass\]$/.test(t)) return '[pass]';
    const unfenced = t.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    const start = unfenced.lastIndexOf('{"summary"');
    for (const candidate of [unfenced, ...(start > 0 ? [unfenced.slice(start)] : [])]) {
        try {
            const v = JSON.parse(candidate);
            if (v && typeof v === 'object' && typeof v.summary === 'string') return v.summary.slice(0, 16000);
        } catch { /* not JSON */ }
    }
    return t.slice(0, 16000);
}

const numeric = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function usageTokens(usage: any): number | null {
    if (!usage || typeof usage !== 'object') return null;
    if (numeric(usage.totalTokens)) return usage.totalTokens;
    return numeric(usage.inputTokens) && numeric(usage.outputTokens) ? usage.inputTokens + usage.outputTokens : null;
}

function classify(err: unknown): AcpFailure {
    if (err instanceof AcpFailure) return err;
    if (err instanceof RpcError) {
        if (err.code === AUTH_REQUIRED) return new AcpFailure('acp_auth_required');
        let data = '';
        try { data = typeof err.data === 'string' ? err.data : JSON.stringify(err.data ?? '') ?? ''; } catch { /* unserialisable */ }
        const text = `${err.message} ${data.slice(0, 2000)}`;
        if (CREDIT_TEXT.test(text)) return new AcpFailure('credit_exhausted', undefined, CREDIT_MESSAGE);
        return new AcpFailure('acp_request_failed', RATE_LIMIT_TEXT.test(text) ? { resetAt: parseReset(text) } : undefined);
    }
    if (err instanceof z.ZodError) return new AcpFailure('acp_invalid_output');
    const code = err instanceof Error ? err.message : '';
    return new AcpFailure(/^(?:acp_[a-z_]+|spawn_failed)$/.test(code) ? code : 'acp_request_failed');
}

/**
 * Under allowAll (a box), whether the adapter still refuses this request (box-adapters.ts
 * acpDeny): a tool named in its list, a call of a listed ACP kind, or anything that reads as a
 * web search or fetch.
 */
export function refusedInBox(call: ToolCallInfo, except: AcpPlan['allowAllExcept']): boolean {
    if (!except) return false;
    const names = [call.name, call.title].filter((n): n is string => typeof n === 'string').map(n => n.trim().toLowerCase());
    return (!!call.kind && except.kinds.includes(call.kind)) || names.some(n => except.names.includes(n))
        || ['WebSearch', 'WebFetch'].includes((ruleForCall(call) ?? '').replace(/\(.*$/, ''));
}

export function startAcp(launch: Launch & { acp: AcpPlan }): RunningChild {
    const plan = launch.acp;
    const timeout = plan.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
    const rules = new Set(plan.rules);
    const calls = new Map<string, OmpCall & { diffs?: string[] }>();
    /** Calls an elicitation was matched to (plan.elicitation): never matched again. */
    const answered = new Set<string>();
    const denied: string[] = [];
    const changed = new Set<string>();
    /** Tool calls whose live-output step has started and not ended (stream.ts). */
    const streaming = new Set<string>();
    let sessionId: string | null = null, stopping = false;
    let text = '', messageId: unknown, toolCalls = 0, step: string | null = null;
    let planDone: number | null = null, planTotal: number | null = null;

    const inside = (path: unknown) => {
        if (typeof path !== 'string' || !isAbsolute(path)) return null;
        const rel = relative(launch.cwd, path);
        return !rel || rel.startsWith('..') || isAbsolute(rel) || rel.length > 4096 ? null : rel.split(sep).join('/');
    };
    /** Fold an ACP tool call or update into what the host knows about it. */
    const track = (u: any) => {
        if (typeof u?.toolCallId !== 'string') return null;
        const call = calls.get(u.toolCallId) ?? {};
        for (const key of ['kind', 'title', 'name', 'status'] as const) if (typeof u[key] === 'string') call[key] = u[key];
        // omp names its tools in lowercase (`bash`, `write`, `mcp__agora_chat_send`): rules use Bash, Edit, mcp__agora__chat_send (omp.ts)
        if (plan.elicitation === 'omp' && typeof u.name === 'string') { call.agentName = u.name; call.name = ompRuleName(u.name); }
        // opencode's permission request repeats the call with empty locations and raw input; what
        // an earlier update of the same call said stays (and an absent path still fails closed)
        if (Array.isArray(u.locations) && u.locations.length) call.locations = u.locations.map((l: any) => l?.path).filter((x: unknown): x is string => typeof x === 'string').slice(0, 50);
        const emptyObject = typeof u.rawInput === 'object' && u.rawInput !== null && !Array.isArray(u.rawInput) && !Object.keys(u.rawInput).length;
        if (u.rawInput !== undefined && u.rawInput !== null && !emptyObject) call.rawInput = u.rawInput;
        if (Array.isArray(u.content)) call.diffs = u.content.filter((c: any) => c?.type === 'diff').map((c: any) => inside(c.path)).filter(Boolean);
        if (calls.size < MAX_CALLS) calls.set(u.toolCallId, call);
        if (typeof u.title === 'string') step = u.title;
        return call;
    };
    const update = (params: any) => {
        if (!params || sessionId === null || params.sessionId !== sessionId) return;
        const u = params.update;
        switch (u?.sessionUpdate) {
            case 'agent_message_chunk':
                if (u.content?.type !== 'text' || typeof u.content.text !== 'string') return;
                if (u.messageId != null && u.messageId !== messageId) { messageId = u.messageId; text = ''; }
                if (text.length < MAX_TEXT) text += u.content.text.slice(0, MAX_TEXT - text.length);
                // Live output: the visible reply as it arrives (never agent_thought_chunk)
                launch.stream?.({ type: 'text', message: `m${messageId ?? toolCalls}`, delta: u.content.text });
                return;
            case 'tool_call':
                // The final message is what the agent says after its last tool call
                toolCalls++; text = ''; messageId = undefined; track(u);
                if (launch.stream && typeof u.toolCallId === 'string') {
                    const step = acpStep(u, launch.cwd);
                    if (step) {
                        launch.stream({ type: 'step', step: u.toolCallId, state: 'start', ...step }); streaming.add(u.toolCallId);
                        if (u.status === 'completed' || u.status === 'failed') { launch.stream({ type: 'step', step: u.toolCallId, state: u.status === 'failed' ? 'failed' : 'ok' }); streaming.delete(u.toolCallId); }
                    }
                }
                return;
            case 'tool_call_update': {
                const call = track(u);
                if (launch.stream && streaming.has(u.toolCallId) && (u.status === 'completed' || u.status === 'failed')) {
                    launch.stream({ type: 'step', step: u.toolCallId, state: u.status === 'failed' ? 'failed' : 'ok' }); streaming.delete(u.toolCallId);
                }
                if (call?.status === 'completed') for (const p of call.diffs ?? []) if (changed.size < 1000) changed.add(p);
                return;
            }
            case 'plan':
                if (!Array.isArray(u.entries)) return;
                planTotal = u.entries.length; planDone = u.entries.filter((e: any) => e?.status === 'completed').length;
                return;
        }
    };
    /** Whether the claim's rules allow this call; a denial sets the progress line and the denied rule. */
    const judge = async (call: ToolCallInfo): Promise<boolean> => {
        const place = await locationsInside(call, launch.cwd, { rules, env: launch.env, roots: launch.workspace ? [launch.workspace.workdir] : [] });
        const allow = place === 'ok' && allowedCall(call, rules);
        if (!allow) {
            if (place !== 'ok') {
                // No card for a path problem: approving the tool would not change the answer
                step = place === 'untrusted' ? 'Denied a command that is not a trusted executable on PATH'
                    : place === 'outside' ? 'Denied file access outside the workspace' : 'Denied file access without a known path';
            } else {
                const rule = ruleForCall(call);
                if (reportable(rule) && !denied.includes(rule) && denied.length < 10) denied.push(rule);
                // Never the agent's own text: the rule is built by the host, anything else is generic
                step = `Denied ${reportable(rule) ? rule.slice(0, 80) : 'a tool call'}`;
            }
        }
        return allow;
    };
    const permission = async (params: unknown) => {
        const p = permissionSchema.safeParse(params);
        if (!p.success) throw new RpcError(-32602, 'Invalid params');
        if (stopping || p.data.sessionId !== sessionId) return { outcome: { outcome: 'cancelled' } };
        const call = track(p.data.toolCall) ?? {};
        // In a box the box is the sandbox: nothing is denied (adapters.ts prepare sets it only there)
        // but the adapter's exceptions, tools that would reach the open web around the edge
        if (plan.allowAll) {
            const refused = refusedInBox(call, plan.allowAllExcept);
            if (refused) step = 'Denied a web tool: a box reaches the web only through its edge';
            return { outcome: outcome(p.data.options, !refused) };
        }
        return { outcome: outcome(p.data.options, await judge(call)) };
    };
    /**
     * An approval prompt as a form elicitation (plan.elicitation): a select whose choices include
     * Approve and Deny. Only the one-time Approve is ever picked, as for permission requests;
     * any other form (a question, a confirmation) is declined.
     */
    const elicit = async (params: any) => {
        const choices = params?.requestedSchema?.properties?.value?.enum;
        if (!plan.elicitation || stopping || params?.sessionId !== sessionId || params?.mode !== 'form' || typeof params?.message !== 'string'
            || !Array.isArray(choices) || !choices.includes('Deny')) return { action: 'decline' };
        const answer = (value: string) => ({ action: 'accept', content: { value } });
        const approve = approveChoice(choices);
        if (!approve) return answer('Deny');
        if (plan.allowAll) return answer(approve);
        // Past the tracking bound the host no longer knows every waiting call: nothing is approved
        if (calls.size >= MAX_CALLS) { step = 'Denied a tool call'; return answer('Deny'); }
        const pending = [...calls].filter(([id, c]) => c.status === 'pending' && !answered.has(id)).map(([id, c]) => ({ ...c, id }));
        const verdict = ompApproval(params.message.slice(0, 64 * 1024), pending);
        // A call is answered once: a later prompt can never be matched to it again
        if (verdict.id) answered.add(verdict.id);
        if ('deny' in verdict) { step = verdict.deny; return answer('Deny'); }
        return answer(await judge(verdict.call) ? approve : 'Deny');
    };

    const agent = spawnAgent(launch, {
        request: async (method, params) => {
            if (method === 'session/request_permission') return permission(params);
            if (method === 'elicitation/create') return elicit(params);
            throw new RpcError(METHOD_NOT_FOUND, 'Method not found');
        },
        notification: (method, params) => { if (method === 'session/update') update(params); },
    }, plan.spawnCwd);
    const { child, conn } = agent;
    let killed: Promise<void> | undefined;
    const kill = (): Promise<void> => {
        if (agent.closed() || agent.failed() || !child.pid) return Promise.resolve();
        if (!killed) {
            stopping = true;
            if (sessionId) conn.notify('session/cancel', { sessionId });
            killed = killTree(child, agent.closed, agent.closedEvent);
        }
        return killed;
    };

    const result = (async (): Promise<Result> => {
        let failure: AcpFailure | null = null, stopReason: string | null = null, tokensUsed: number | null = null;
        try {
            const init = initSchema.parse(await conn.request('initialize', initParams(!!plan.elicitation), timeout));
            if (init.protocolVersion !== PROTOCOL_VERSION) throw new AcpFailure('acp_protocol_unsupported');
            if (plan.authMethod) {
                // codex-acp types its key methods "env_var"; a "terminal" method is an interactive login
                if (!init.authMethods.some(m => m.id === plan.authMethod && ['agent', 'env_var'].includes(m.type ?? 'agent'))) throw new AcpFailure('acp_api_key_auth_unavailable');
                await conn.request('authenticate', { methodId: plan.authMethod }, timeout);
            }
            const setup = { cwd: launch.cwd, mcpServers: plan.mcpServers };
            let opened: any;
            if (plan.nativeSessionId) {
                // No fallback to a fresh session: a failed resume is a failure (README)
                const caps = init.agentCapabilities;
                if (caps.sessionCapabilities.resume != null) opened = await conn.request('session/resume', { sessionId: plan.nativeSessionId, ...setup }, timeout);
                else if (caps.loadSession) opened = await conn.request('session/load', { sessionId: plan.nativeSessionId, ...setup }, timeout);
                else throw new AcpFailure('native_resume_unsupported');
                sessionId = plan.nativeSessionId;
            } else {
                opened = await conn.request('session/new', setup, timeout);
                sessionId = z.string().regex(SESSION_ID).parse(opened?.sessionId);
            }
            const options = z.array(optionSchema).catch([]).parse(opened?.configOptions ?? []);
            if (plan.sessionMode) {
                // A mode configOption (Devin 3000.11 sends both shapes) takes precedence over legacy modes
                const option = options.find(o => o.category === 'mode');
                const legacy = modesSchema.parse(opened?.modes);
                if (option) {
                    const value = pick(option, plan.sessionMode);
                    if (!value) throw new AcpFailure('acp_mode_unavailable');
                    if (value !== option.currentValue) await conn.request('session/set_config_option', { sessionId, configId: option.id, value }, timeout);
                } else if (legacy?.availableModes.length) {
                    if (!legacy.availableModes.some(m => m.id === plan.sessionMode)) throw new AcpFailure('acp_mode_unavailable');
                    if (legacy.currentModeId !== plan.sessionMode) await conn.request('session/set_mode', { sessionId, modeId: plan.sessionMode }, timeout);
                }
            }
            if (plan.model) {
                const option = options.find(o => o.category === 'model');
                // Gemini 0.62 advertises the ACP session-model API, without configOptions.
                // A model configOption takes precedence when an agent supports both shapes.
                const legacy = modelsSchema.parse(opened?.models ?? {});
                const selection = option ?? { id: 'model', type: 'select', currentValue: legacy.currentModelId,
                    options: legacy.availableModels.map(m => ({ value: m.modelId, name: m.name ?? m.modelId })) };
                const value = pick(selection, plan.model);
                if (!value) throw modelUnavailable(plan.model, selection);
                if (value !== selection.currentValue) {
                    if (option) await conn.request('session/set_config_option', { sessionId, configId: option.id, value }, timeout);
                    else await conn.request('session/set_model', { sessionId, modelId: value }, timeout);
                }
            }
            if (plan.effort) {
                // Effort is a hint: an agent without a reasoning level option runs at its default
                const option = options.find(o => o.category === 'thought_level');
                const value = pick(option, plan.effort);
                if (option && value && value !== option.currentValue) await conn.request('session/set_config_option', { sessionId, configId: option.id, value }, timeout);
            }
            const response = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: plan.prompt }] });
            stopReason = typeof response?.stopReason === 'string' && /^[a-z_]{1,40}$/.test(response.stopReason) ? response.stopReason : 'invalid';
            tokensUsed = usageTokens(response?.usage);
        } catch (err) { failure = classify(err); }
        try {
            // Most agents exit when stdin closes; otherwise stop the tree as for a cancelled run
            if (!agent.failed() && !agent.closed() && !killed) {
                child.stdin.end();
                let timer: ReturnType<typeof setTimeout>;
                const exited = await Promise.race([agent.closedEvent.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), 3000); })]);
                clearTimeout(timer!);
                if (!exited) await kill();
            } else await killed;
        } catch { throw new Error('process_tree_kill_failed'); }
        const final = summaryOf(text);
        const success = !failure && stopReason === 'end_turn' && (final !== null || !!launch.lurk);
        const error = failure?.code ?? (stopReason && stopReason !== 'end_turn' ? `acp_${stopReason}` : 'cli_failed_or_invalid_output');
        return { success, nativeSessionId: sessionId, tokensUsed, summary: final === '[pass]' ? null : final, changedPaths: [...changed],
            ...(success ? {} : { error }), ...(failure?.detail ? { errorMessage: failure.detail } : {}),
            ...(denied.length ? { deniedTools: denied } : {}), ...(failure?.rateLimit ? { rateLimit: failure.rateLimit } : {}) };
    })();

    return {
        result, kill, tokensUsed: () => null,
        progress: (): Progress => ({ step: step ? oneLine(step).slice(0, 200) || null : null, toolCalls, planDone, planTotal }),
    };
}

/** Start the agent, check it speaks ACP v1, and stop it. No session, no model call. */
export async function probeAcp(launch: Pick<Launch, 'executable' | 'args' | 'cwd' | 'env'> & { spawnCwd?: string }, timeoutMs = 15000): Promise<string> {
    const agent = spawnAgent(launch, {
        request: async () => { throw new RpcError(METHOD_NOT_FOUND, 'Method not found'); },
        notification: () => {},
    }, launch.spawnCwd);
    try {
        const init = initSchema.parse(await agent.conn.request('initialize', initParams(), timeoutMs));
        if (init.protocolVersion !== PROTOCOL_VERSION) throw new Error('unsupported_acp_version');
        return init.agentInfo?.version ? `acp/${PROTOCOL_VERSION} ${oneLine(init.agentInfo.version)}` : `acp/${PROTOCOL_VERSION}`;
    } catch (err) {
        throw new Error(err instanceof Error && err.message === 'unsupported_acp_version' ? err.message : 'acp_probe_failed');
    } finally {
        agent.conn.close(new Error('acp_probe_done'));
        if (!agent.closed() && !agent.failed() && agent.child.pid) await killTree(agent.child, agent.closed, agent.closedEvent).catch(() => {});
    }
}

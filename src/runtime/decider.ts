import type { Capability } from '../ai/adapters';
import type { RunLimits } from './limits';

/**
 * Decision gate (sandbox-isolation-spec §10). Every run passes a Decider before it
 * can be queued. `RulesDecider` is the default and the floor: external deciders
 * (webhook / Jev, WBS 2.2–2.3) may only make a decision stricter or upgrade
 * `needs_approval` to `auto_run` for bots with `auto` access — never loosen limits.
 */

export type GateDecision = 'auto_run' | 'needs_approval' | 'deny';

export interface DecisionRequest {
    runId: string;
    serverId: string;
    submitterId: string;
    submitterIsBot: boolean;
    runtimeAccess: 'none' | 'approval' | 'auto';
    submitterPaused: boolean;
    code: string;
    codeSha256: string;
    requestedCapabilities: Capability[];
    /** Capabilities with an enabled route on this server. */
    enabledCapabilities: Capability[];
    limits: RunLimits;
    queuedForServer: number;
}

export interface Decision {
    decision: GateDecision;
    reason: string;
    source: 'rules' | 'webhook' | 'jev';
    confidence?: number;
}

export interface Decider {
    decideExecution(req: DecisionRequest): Promise<Decision>;
}

export const MAX_CODE_BYTES_DEFAULT = 64 * 1024;
export const MAX_QUEUED_PER_SERVER = 20;

export class RulesDecider implements Decider {
    constructor(private opts: { maxCodeBytes?: number; maxQueuedPerServer?: number } = {}) {}

    async decideExecution(req: DecisionRequest): Promise<Decision> {
        const deny = (reason: string): Decision => ({ decision: 'deny', reason, source: 'rules' });
        const maxCode = this.opts.maxCodeBytes ?? MAX_CODE_BYTES_DEFAULT;
        const maxQueued = this.opts.maxQueuedPerServer ?? MAX_QUEUED_PER_SERVER;

        if (!req.submitterIsBot) return deny('Only bots can submit code in this version');
        if (req.runtimeAccess === 'none') return deny('This bot is not allowed to run code (an admin can enable it in Bot Management)');
        if (req.submitterPaused) return deny('This bot is paused');
        if (Buffer.byteLength(req.code, 'utf8') > maxCode) return deny(`Code exceeds ${maxCode} bytes`);
        if (req.code.trim().length === 0) return deny('Code is empty');

        const unavailable = req.requestedCapabilities.filter(c => !req.enabledCapabilities.includes(c));
        if (unavailable.length > 0) return deny(`Capabilities not enabled on this server: ${unavailable.join(', ')}`);
        if (req.queuedForServer >= maxQueued) return deny(`Too many queued runs for this server (${maxQueued})`);

        return req.runtimeAccess === 'auto'
            ? { decision: 'auto_run', reason: 'Bot has auto-run access', source: 'rules' }
            : { decision: 'needs_approval', reason: 'Runs from this bot need human approval', source: 'rules' };
    }
}

/**
 * Remove comments before code is shown to a model-based decider, so comments like
 * "// this is safe" can't steer the classification (T11). Conservative: may leave
 * comment-like text inside strings intact or strip `//` inside strings; the output is
 * only for classification, never executed.
 */
export function stripComments(code: string): string {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

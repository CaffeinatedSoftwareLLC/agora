import { z } from 'zod';
import type { Checkpoint, ReviewCommand } from './review.js';
import type { PreviewCommand, PreviewOutcome } from './preview.js';

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const seconds = z.number().finite().positive().max(86400);
/**
 * A tool rule: Claude permission-rule syntax (`Bash(gh:*)`, `WebFetch(domain:example.com)`,
 * `mcp__agora__chat_send`) or a Codex capability word (`write`, `network`, `web_search`).
 * No commas: Claude's --allowedTools list is comma separated.
 */
export const TOOL_RULE = /^[A-Za-z][A-Za-z0-9_]{0,99}(\([^(),\r\n]{1,200}\))?$/;
const rule = z.string().regex(TOOL_RULE);
export const claimSchema = z.object({
    run: z.object({
        id, claimToken: z.string().min(1), attempt: z.number().int().min(1).max(3),
        deliveryKey: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), leaseSeconds: seconds,
        leaseUntil: z.string().datetime(), heartbeatSeconds: seconds, timeoutSeconds: seconds,
        // Tools the owner approved once for this run after a denial (#73)
        grantedTools: z.array(rule).max(50).default([]),
        // The owner approved this run on its card (profiles with run approval)
        ownerApproved: z.boolean().default(false),
    }),
    session: z.object({
        id, channelId: id, channelName: z.string(), nativeSessionId: z.string().min(1).nullable(),
        summary: z.string().nullable(), wakesUsed: z.number().nonnegative(), wakeBudget: z.number().nonnegative(),
        tokensUsed: z.number().nonnegative(), tokenBudget: z.number().nonnegative(),
        // The session slept through a rate limit; the batch holds what arrived meanwhile (#87)
        wokeFromSleep: z.boolean().default(false),
        lurkMode: z.enum(['quiet', 'balanced', 'vocal']).nullable().default(null),
        // The server owner started or last resumed this session (terms.ts)
        startedByOwner: z.boolean().default(false),
        // A task card's or subtask's session works only in this thread (docs/task-board.md)
        threadId: id.nullable().default(null),
        // A subtask: its summary is posted back to this parent session
        parentSessionId: id.nullable().default(null),
        scope: z.object({ kind: z.enum(['task', 'subtask']), title: z.string().max(200) }).nullable().default(null),
    }),
    profile: z.object({ id, name: z.string().min(1), botId: id, adapter: z.enum(['codex', 'claude']),
        // null: leave the model or effort to the CLI's own default
        model: z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).nullable(),
        effort: z.string().min(1).max(30).nullable(), workdirAlias: z.string().min(1),
        // Edited in Settings → Agents and read at every claim, so no host restart (#73)
        toolPresets: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).max(10).default([]),
        allowedTools: z.array(rule).max(100).default([]),
        // The server's view of the auth mode; the local profile's `auth` is what the host enforces
        authMode: z.enum(['subscription', 'api_key', 'siwc']).default('subscription'),
        // Whose plan a subscription or siwc profile runs on; `startedByOwner` means started by them
        planOwnerId: id.nullable().default(null),
        runApproval: z.boolean().default(false) }),
    // The channel's pinned instructions and files (docs/project-context.md). `docs` holds the
    // files' text only when `changed`: a fresh conversation, or a version this session hasn't had.
    // The server counts characters, zod UTF-16 units: limits are twice the server's.
    project: z.object({
        version: z.number().int().nonnegative(), instructions: z.string().max(16000), changed: z.boolean(),
        files: z.array(z.object({ id, name: z.string().max(510), mime: z.string().max(254), size: z.number().nonnegative() })).max(10),
        docs: z.array(z.object({ id, name: z.string().max(510), text: z.string().max(12000), truncated: z.boolean(),
            error: z.string().max(400).nullable() })).max(10).default([]),
    }).nullable().default(null),
    // The owner's verify command; run only if this host's profile lists it (verify.ts)
    verify: z.object({ command: z.string().min(1).max(300), maxRetries: z.number().int().min(0).max(5) }).nullable().default(null),
    inbox: z.array(z.object({
        // 'command': the session notice a /start or /resume posts, so the agent says hello
        // 'delegate': a subtask's brief (to the child) or its summary (back to the parent)
        messageId: id, threadId: id.nullable(), reason: z.enum(['direct', 'handoff', 'protocol', 'command', 'lurk', 'delegate']),
        authorId: id.nullable(), authorName: z.string().nullable(), authorBot: z.boolean(),
        authority: z.enum(['owner', 'director']).nullable(), content: z.string().max(4000).nullable(),
        createdAt: z.string().datetime(),
    })).min(1).max(20),
}).refine(c => c.run.heartbeatSeconds < c.run.leaseSeconds - 10, 'heartbeat must precede lease safety margin');
export type Claim = z.infer<typeof claimSchema>;
export interface Result {
    success: boolean;
    nativeSessionId: string | null;
    tokensUsed: number | null;
    summary: string | null;
    error?: string;
    changedPaths?: string[];
    /** Tool rules the CLI denied during the run, for the owner to approve (#73). */
    deniedTools?: string[];
    /** The CLI hit its account's rate limit; resetAt when the CLI said (#87). */
    rateLimit?: RateLimit;
    /** What the verify step found, when the claim asked for one (verify.ts). */
    verification?: Verification;
}
export interface Verification {
    command: string; status: 'passed' | 'failed' | 'skipped';
    /** Follow-up turns the agent was given to fix a failure. */
    attempts: number;
    exitCode?: number | null;
    /** not_allowed, timeout, no_session, fix_turn_failed, spawn_failed */
    reason?: string;
    /** The end of the output of a failed command. */
    output?: string;
}
export interface RateLimit { resetAt: string | null }
export interface Completion { checkpoint?: Checkpoint; claimToken: string; nativeSessionId: string | null; tokensUsed: number | null; summary: string | null; changedPaths?: string[]; branch?: string; baseSha?: string; headSha?: string; deniedTools?: string[]; verification?: Verification }
export interface Failure { checkpoint?: Checkpoint; claimToken: string; error: string; message: string; tokensUsed: number | null; retryable: boolean; changedPaths?: string[]; deniedTools?: string[]; rateLimit?: RateLimit; verification?: Verification }
export type Heartbeat = { cancel: false; leaseUntil: string } | { cancel: true; reason: string };
export interface HostApi {
    claimWorkspaceCommand?(signal?: AbortSignal): Promise<ReviewCommand | null>;
    workspaceCommandResult?(cmd: ReviewCommand, success: boolean, result: object, signal?: AbortSignal): Promise<void>;
    claimPreview?(signal?: AbortSignal): Promise<PreviewCommand | null>;
    previewResult?(cmd: PreviewCommand, outcome: PreviewOutcome, signal?: AbortSignal): Promise<void>;
    imageMessages?(claim: Claim, signal?: AbortSignal): Promise<{ maxBytes: number; messages: Array<{ id: string; content: string }> }>;
    uploadImage?(claim: Claim, image: { messageId: string; reference: string; filename: string; buffer: Buffer }, signal?: AbortSignal): Promise<void>;
    workspaceStates?(sessionIds: string[]): Promise<string[]>;
    workspaceWarning?(sessionId: string, paths: string[]): Promise<void>;
    claim(signal?: AbortSignal): Promise<{ claim: Claim; sentAt: number } | null>;
    heartbeat(claim: Claim, signal?: AbortSignal, tokensUsed?: number | null): Promise<Heartbeat>;
    complete(claim: Claim, body: Completion, signal?: AbortSignal): Promise<void>;
    fail(claim: Claim, body: Failure, signal?: AbortSignal): Promise<void>;
    reportProfiles?(profiles: ProfileReport[]): Promise<void>;
    claimPlanRequest?(signal?: AbortSignal): Promise<PlanRequest | null>;
    reportPlan?(profile: string, body: { status: PlanStatus; error?: string | null; accountLabel?: string | null }, signal?: AbortSignal): Promise<{ planOwnerId: string | null }>;
}
export interface ProfileReport { name: string; adapter: string; authMode: 'subscription' | 'api_key' | 'siwc'; apiKeyEnv: string | null; runApproval: boolean }
/** A Settings → Agents request for this host to connect or disconnect a ChatGPT plan. */
export interface PlanRequest { profile: string; action: 'connect' | 'disconnect'; requestedBy: string | null }
export type PlanStatus = 'in_progress' | 'connected' | 'scope_missing' | 'failed' | 'disconnected';

import { z } from 'zod';

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
    }),
    session: z.object({
        id, channelId: id, channelName: z.string(), nativeSessionId: z.string().min(1).nullable(),
        summary: z.string().nullable(), wakesUsed: z.number().nonnegative(), wakeBudget: z.number().nonnegative(),
        tokensUsed: z.number().nonnegative(), tokenBudget: z.number().nonnegative(),
        // The session slept through a rate limit; the batch holds what arrived meanwhile (#87)
        wokeFromSleep: z.boolean().default(false),
        lurkMode: z.enum(['quiet', 'balanced', 'vocal']).nullable().default(null),
    }),
    profile: z.object({ id, name: z.string().min(1), botId: id, adapter: z.enum(['codex', 'claude']),
        // null: leave the model or effort to the CLI's own default
        model: z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).nullable(),
        effort: z.string().min(1).max(30).nullable(), workdirAlias: z.string().min(1),
        // Edited in Settings → Agents and read at every claim, so no host restart (#73)
        toolPresets: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).max(10).default([]),
        allowedTools: z.array(rule).max(100).default([]) }),
    inbox: z.array(z.object({
        // 'command': the session notice a /start or /resume posts, so the agent says hello
        messageId: id, threadId: id.nullable(), reason: z.enum(['direct', 'handoff', 'protocol', 'command', 'lurk']),
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
}
export interface RateLimit { resetAt: string | null }
export interface Completion { claimToken: string; nativeSessionId: string | null; tokensUsed: number | null; summary: string | null; changedPaths?: string[]; branch?: string; baseSha?: string; headSha?: string; deniedTools?: string[] }
export interface Failure { claimToken: string; error: string; message: string; tokensUsed: number | null; retryable: boolean; changedPaths?: string[]; deniedTools?: string[]; rateLimit?: RateLimit }
export type Heartbeat = { cancel: false; leaseUntil: string } | { cancel: true; reason: string };
export interface HostApi {
    imageMessages?(claim: Claim, signal?: AbortSignal): Promise<{ maxBytes: number; messages: Array<{ id: string; content: string }> }>;
    uploadImage?(claim: Claim, image: { messageId: string; reference: string; filename: string; buffer: Buffer }, signal?: AbortSignal): Promise<void>;
    workspaceStates?(sessionIds: string[]): Promise<string[]>;
    workspaceWarning?(sessionId: string, paths: string[]): Promise<void>;
    claim(signal?: AbortSignal): Promise<{ claim: Claim; sentAt: number } | null>;
    heartbeat(claim: Claim, signal?: AbortSignal, tokensUsed?: number | null): Promise<Heartbeat>;
    complete(claim: Claim, body: Completion, signal?: AbortSignal): Promise<void>;
    fail(claim: Claim, body: Failure, signal?: AbortSignal): Promise<void>;
}

import { z } from 'zod';

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const seconds = z.number().finite().positive().max(86400);
export const claimSchema = z.object({
    run: z.object({
        id, claimToken: z.string().min(1), attempt: z.number().int().min(1).max(3),
        deliveryKey: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), leaseSeconds: seconds,
        leaseUntil: z.string().datetime(), heartbeatSeconds: seconds, timeoutSeconds: seconds,
    }),
    session: z.object({
        id, channelId: id, channelName: z.string(), nativeSessionId: z.string().min(1).nullable(),
        summary: z.string().nullable(), wakesUsed: z.number().nonnegative(), wakeBudget: z.number().nonnegative(),
        tokensUsed: z.number().nonnegative(), tokenBudget: z.number().nonnegative(),
    }),
    profile: z.object({ id, name: z.string().min(1), botId: id, adapter: z.enum(['codex', 'claude']),
        model: z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/), effort: z.string().min(1).max(30), workdirAlias: z.string().min(1) }),
    inbox: z.array(z.object({
        messageId: id, threadId: id.nullable(), reason: z.enum(['direct', 'handoff', 'protocol']),
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
}
export interface Completion { claimToken: string; nativeSessionId: string | null; tokensUsed: number | null; summary: string | null }
export interface Failure { claimToken: string; error: string; message: string; tokensUsed: number | null; retryable: boolean }
export type Heartbeat = { cancel: false; leaseUntil: string } | { cancel: true; reason: string };
export interface HostApi {
    claim(signal?: AbortSignal): Promise<{ claim: Claim; sentAt: number } | null>;
    heartbeat(claim: Claim, signal?: AbortSignal): Promise<Heartbeat>;
    complete(claim: Claim, body: Completion, signal?: AbortSignal): Promise<void>;
    fail(claim: Claim, body: Failure, signal?: AbortSignal): Promise<void>;
}

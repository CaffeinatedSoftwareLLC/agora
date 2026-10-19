import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { configSchema, type Config } from '../src/config.js';
import type { Claim, Result } from '../src/types.js';

export const id = (n: number) => `01J${String(n).padStart(23, '0')}`;
export const successful: Result = { success: true, nativeSessionId: '12345678-1234-1234-1234-123456789abc', tokensUsed: 100, summary: 'Finished' };
export function claim(): Claim {
    return {
        run: { id: id(1), claimToken: 'rt_test', attempt: 1, deliveryKey: 'dk_batch', leaseSeconds: 120,
            leaseUntil: '2026-10-17T21:02:00.000Z', heartbeatSeconds: 30, timeoutSeconds: 900, grantedTools: [], ownerApproved: false },
        session: { id: id(2), channelId: id(3), channelName: 'general', nativeSessionId: null, summary: 'Previous decision',
            wakesUsed: 1, wakeBudget: 50, tokensUsed: 0, tokenBudget: 2000000, wokeFromSleep: false, lurkMode: null, startedByOwner: true,
            threadId: null, parentSessionId: null, scope: null },
        profile: { id: id(4), name: 'builder', botId: id(5), adapter: 'codex', model: 'gpt-6.1-sol', effort: 'high', workdirAlias: 'agora', toolPresets: [], allowedTools: [], authMode: 'subscription', runApproval: false },
        inbox: [{ messageId: id(6), threadId: id(7), reason: 'handoff', authorId: id(8), authorName: 'Claude',
            authorBot: true, authority: null, content: 'Review the changes.', createdAt: '2026-10-17T21:00:00.000Z' }],
    };
}
export function config(dir = process.cwd()): Config {
    return configSchema.parse({ instance: 'http://127.0.0.1:3000', hostToken: 'ah_host.secret',
        mcp: { executable: process.execPath, entrypoint: join(dir, 'mcp.js') },
        profiles: { builder: { adapter: 'codex', executable: process.execPath, workdir: dir, workdirAlias: 'agora',
            stateDir: join(dir, 'state'), approvedTools: ['chat_history', 'chat_send', 'thread_start'] } },
        botTokens: { [id(5)]: 'bot_selected.secret', [id(9)]: 'bot_sibling.secret' } });
}
export async function tempDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
    const root = resolve('.cache'); await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, 'host-test-'));
    return { dir, cleanup: async () => {
        const rel = relative(root, resolve(dir));
        if (!rel || rel.startsWith('..')) throw new Error('unsafe test cleanup path');
        await rm(dir, { recursive: true, force: true });
    } };
}
export function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

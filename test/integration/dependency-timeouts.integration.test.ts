import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { buildApp } from '../../src/app';

// Claude runs this suite. No data cleanup is needed: tests only read or SET LOCAL.
let ctx: Awaited<ReturnType<typeof buildApp>>;
let originalStatementTimeout: string;
beforeAll(async () => {
    ctx = await buildApp({ logger: false, rateLimit: false,
        dbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
            ?? 'postgres://accord:accord@localhost:5432/accord_test' });
    originalStatementTimeout = (await ctx.db.query('SHOW statement_timeout')).rows[0].statement_timeout;
    ctx.app.get('/instance/_test/deadline', async request =>
        (await request.dbClient!.query('SHOW statement_timeout')).rows[0]);
    ctx.app.get('/instance/_test/cancel', async request => {
        await request.dbClient!.query("SET LOCAL statement_timeout = '25ms'");
        await request.dbClient!.query('SELECT pg_sleep(1)');
        return { unexpected: true };
    });
    ctx.app.get('/instance/_test/commit', async () => ({ success: true }));
    await ctx.app.ready();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

it('sets a local request deadline without changing background clients or leaking it through the pool', async () => {
    const res = await ctx.app.inject('/instance/_test/deadline');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ statement_timeout: '15s' });
    expect((await ctx.db.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe(originalStatementTimeout);
});

it('rolls back a server-side query timeout and returns 503 with Retry-After', async () => {
    const res = await ctx.app.inject('/instance/_test/cancel');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'service_unavailable' });
    expect(res.headers['retry-after']).toBe('5');
    expect((await ctx.db.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
    expect(ctx.db.waitingCount).toBe(0);
});

it('returns 503 when COMMIT loses its connection instead of reporting success or commit_failed', async () => {
    const original = Client.prototype.query;
    let failCommit = true;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: any[]) {
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        if (text === 'COMMIT' && failCommit) {
            failCommit = false;
            return Promise.reject(new Error('Connection terminated unexpectedly'));
        }
        return (original as any).apply(this, args);
    } as Client['query']);
    const res = await ctx.app.inject('/instance/_test/commit');
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json()).toEqual({ error: 'service_unavailable' });
});

it('health returns 503 on pool acquisition failure and 200 after recovery', async () => {
    const connect = vi.spyOn(ctx.db, 'connect').mockRejectedValueOnce(new Error('timeout exceeded when trying to connect') as never);
    const res = await ctx.app.inject('/health');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'service_unavailable' });
    expect(res.headers['retry-after']).toBe('5');
    connect.mockRestore();
    expect((await ctx.app.inject('/health')).statusCode).toBe(200);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { Client } from 'pg';
import { createServer, type Socket } from 'node:net';
import { DB_CONTROL_TIMEOUT_MS, DB_QUERY_TIMEOUT_MS, DB_STATEMENT_TIMEOUT_MS, RequestClient,
    enterRequestDbScope, leaveRequestDbScope } from '../../src/db/request-timeouts';
import { installDependencyErrorHandler, ServiceUnavailableError } from '../../src/lib/service-unavailable';

afterEach(() => vi.restoreAllMocks());
const ok = { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
function inRequest<T>(run: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => enterRequestDbScope(() => { void run().then(resolve, reject); }));
}

describe('request-only PostgreSQL deadlines', () => {
    it('sets LOCAL only after BEGIN, gives controls 5s and ordinary queries 17s', async () => {
        const query = vi.spyOn(Client.prototype, 'query').mockResolvedValue(ok as never);
        const client = new RequestClient();
        await inRequest(async () => {
            await client.query('BEGIN');
            await client.query('SELECT $1', [1]);
            await client.query('COMMIT');
        });
        expect(query.mock.calls).toEqual([
            [{ text: 'BEGIN', values: undefined, query_timeout: DB_CONTROL_TIMEOUT_MS }],
            [{ text: `SET LOCAL statement_timeout = '${DB_STATEMENT_TIMEOUT_MS}ms'`, query_timeout: DB_CONTROL_TIMEOUT_MS }],
            [{ text: 'SELECT $1', values: [1], query_timeout: DB_QUERY_TIMEOUT_MS }],
            [{ text: 'COMMIT', values: undefined, query_timeout: DB_CONTROL_TIMEOUT_MS }],
        ]);
    });

    it('keeps worker queries unchanged, including descendants after the response finishes', async () => {
        const query = vi.spyOn(Client.prototype, 'query').mockResolvedValue(ok as never);
        const client = new RequestClient();
        await client.query('BEGIN');
        await inRequest(async () => {
            leaveRequestDbScope();
            await new Promise(resolve => setTimeout(resolve, 0));
            await client.query('BEGIN');
        });
        expect(query.mock.calls).toEqual([['BEGIN'], ['BEGIN']]);
    });

    it('destroys a client on its read deadline instead of queuing rollback on a hung socket', async () => {
        vi.spyOn(Client.prototype, 'query').mockRejectedValue(new Error('Query read timeout') as never);
        const end = vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined as never);
        await expect(inRequest(() => new RequestClient().query('SELECT 1'))).rejects.toBeInstanceOf(ServiceUnavailableError);
        expect(end).toHaveBeenCalledOnce();
    });

    it('preserves callback queries used internally by Pool.query', async () => {
        vi.spyOn(Client.prototype, 'query').mockResolvedValue(ok as never);
        const result = await inRequest(() => new Promise((resolve, reject) => {
            new RequestClient().query('SELECT 1', (err, rows) => err ? reject(err) : resolve(rows));
        }));
        expect(result).toEqual(ok);
    });

    it('propagates scope through Fastify hooks without affecting a concurrent background query', async () => {
        const query = vi.spyOn(Client.prototype, 'query').mockResolvedValue(ok as never);
        const app = Fastify();
        app.addHook('onRequest', (_req, _reply, done) => enterRequestDbScope(done));
        app.get('/', async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new RequestClient().query('SELECT 1'); return {}; });
        try {
            await Promise.all([app.inject('/'), new RequestClient().query('SELECT 2')]);
            expect(query.mock.calls).toContainEqual(['SELECT 2']);
            expect(query.mock.calls).toContainEqual([{ text: 'SELECT 1', values: undefined, query_timeout: DB_QUERY_TIMEOUT_MS }]);
        } finally { await app.close(); }
    });

    it('a real pg read deadline closes a silent socket and rollback rejects promptly', async () => {
        // In-process wire stub only: accepts startup, then never answers a query. No database.
        const sockets = new Set<Socket>();
        const server = createServer(socket => {
            sockets.add(socket); socket.on('close', () => sockets.delete(socket));
            socket.once('data', () => socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73])));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const client = new RequestClient({ host: '127.0.0.1', port: (server.address() as { port: number }).port,
            user: 'fixture', database: 'fixture', ssl: false, connectionTimeoutMillis: 1000 });
        try {
            await client.connect();
            await expect(inRequest(() => client.query('BEGIN'))).rejects.toBeInstanceOf(ServiceUnavailableError);
            const started = Date.now();
            await expect(inRequest(() => client.query('ROLLBACK'))).rejects.toThrow();
            expect(Date.now() - started).toBeLessThan(1000);
        } finally {
            await client.end();
            for (const socket of sockets) socket.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }, 10000);
});

describe('dependency error responses', () => {
    it.each([
        new ServiceUnavailableError(),
        new Error('timeout exceeded when trying to connect'),
        new Error('Connection terminated due to connection timeout'),
        Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
        new Error('Command timed out'),
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('retry limit'), { name: 'MaxRetriesPerRequestError' }),
    ])('returns a retryable 503 for %s', async error => {
        const app = Fastify(); installDependencyErrorHandler(app);
        app.get('/', async () => { throw error; });
        try {
            const res = await app.inject('/');
            expect(res.statusCode).toBe(503);
            expect(res.headers['retry-after']).toBe('5');
            expect(res.json()).toEqual({ error: 'service_unavailable' });
        } finally { await app.close(); }
    });

    it('preserves validation and unexpected error responses', async () => {
        const app = Fastify(); installDependencyErrorHandler(app);
        app.get('/bad', async () => { throw Object.assign(new Error('bad input'), { statusCode: 400 }); });
        app.get('/bug', async () => { throw new Error('unexpected'); });
        try {
            expect((await app.inject('/bad')).statusCode).toBe(400);
            expect((await app.inject('/bug')).statusCode).toBe(500);
        } finally { await app.close(); }
    });
});

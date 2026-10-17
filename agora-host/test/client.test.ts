import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, HttpError } from '../src/client.js';
import { claim } from './helpers.js';

let server: Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined; } });
async function fake(handler: (path: string, body: string, auth: string | undefined) => { status: number; body?: unknown }) {
    server = createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        const response = handler(req.url!, body, req.headers.authorization);
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(response.body === undefined ? '' : JSON.stringify(response.body));
    });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('bad address');
    return `http://127.0.0.1:${address.port}`;
}
describe('HTTP contract against a fake local server', () => {
    it('claims once, records send time and sends only AgentHost credentials', async () => {
        let calls = 0;
        const url = await fake((path, body, auth) => {
            calls++; expect(path).toBe('/agent-hosts/@me/runs/next?wait=25');
            expect(body).toBe(''); expect(auth).toBe('AgentHost ah_test.secret');
            return { status: 200, body: claim() };
        });
        const client = new Client(url, 'ah_test.secret', fetch, () => 123);
        expect(await client.claim()).toMatchObject({ sentAt: 123, claim: { run: { claimToken: 'rt_test' } } });
        expect(calls).toBe(1);
    });
    it('returns null on 204 and does not retry failed claims', async () => {
        let status = 204; let calls = 0;
        const url = await fake(() => { calls++; return { status }; });
        const client = new Client(url, 'ah_test'); expect(await client.claim()).toBeNull();
        status = 503; await expect(client.claim()).rejects.toMatchObject({ status: 503 }); expect(calls).toBe(2);
    });
    it('retries lost/transient terminal reports with identical bodies; stops on fencing/auth', async () => {
        const bodies: string[] = []; let status = 503;
        const url = await fake((path, body) => {
            bodies.push(body);
            expect(path).toContain('/complete');
            return { status: bodies.length === 2 ? 200 : status, body: { ok: true } };
        });
        const client = new Client(url, 'ah_test', fetch, undefined, 1);
        const body = { claimToken: 'rt_test', nativeSessionId: null, tokensUsed: 10, summary: 'Done' };
        await client.complete(claim(), body); expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
        status = 409; await expect(client.complete(claim(), body)).rejects.toBeInstanceOf(HttpError); expect(bodies).toHaveLength(3);
        status = 401; await expect(client.complete(claim(), body)).rejects.toMatchObject({ status: 401 }); expect(bodies).toHaveLength(4);
    });
    it('heartbeats are parsed, invalid responses cannot extend a lease', async () => {
        let body: unknown = { cancel: false, leaseUntil: '2026-10-17T21:03:00.000Z' };
        const url = await fake(() => ({ status: 200, body })); const client = new Client(url, 'ah_test');
        expect(await client.heartbeat(claim())).toMatchObject({ cancel: false });
        body = { cancel: true, reason: 'paused' }; expect(await client.heartbeat(claim())).toMatchObject({ cancel: true });
        body = { cancel: false }; await expect(client.heartbeat(claim())).rejects.toThrow();
    });
    it('aborts pending calls and never follows an authorization-bearing redirect', async () => {
        const fetcher = async (_url: unknown, options: RequestInit) => {
            expect(options.redirect).toBe('error'); options.signal!.throwIfAborted(); throw new Error('network');
        };
        const client = new Client('http://localhost:1', 'ah_test', fetcher as typeof fetch);
        const controller = new AbortController(); controller.abort();
        await expect(client.claim(controller.signal)).rejects.toThrow();
    });
});

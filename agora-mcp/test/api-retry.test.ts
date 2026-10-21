import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgoraApi, AgoraApiError } from '../src/api.js';

const api = () => new AgoraApi('http://agora.test', 'fixture');
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const unavailable = (retryAfter = '5') => json({ error: 'service_unavailable' }, 503, { 'retry-after': retryAfter });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('503 then 201 stores one post, preserving the same client_key and content across attempts', async () => {
    let posts = 0;
    let attempts = 0;
    const fetcher = vi.fn(async () => {
        if (++attempts === 1) return unavailable();
        posts++; return json({ id: 'message-1' }, 201);
    });
    vi.stubGlobal('fetch', fetcher);
    const done = expect(api().sendMessage('channel', 'reply', undefined, 'delivery:1')).resolves.toEqual({ id: 'message-1' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(posts).toBe(1);
    const inits = fetcher.mock.calls.map(call => (call as unknown as [string, RequestInit])[1]);
    expect(inits.map(init => init.body)).toEqual([
        JSON.stringify({ content: 'reply', client_key: 'delivery:1' }),
        JSON.stringify({ content: 'reply', client_key: 'delivery:1' }),
    ]);
});

it('uses the same client_key for a thread post retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(json({ id: 'reply' }, 201));
    vi.stubGlobal('fetch', fetcher);
    const done = expect(api().sendReply('channel', 'thread', 'text', undefined, 'delivery:2')).resolves.toEqual({ id: 'reply' });
    await vi.advanceTimersByTimeAsync(5000); await done;
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.body])).toEqual([
        ['http://agora.test/channels/channel/messages/thread/replies', JSON.stringify({ content: 'text', client_key: 'delivery:2' })],
        ['http://agora.test/channels/channel/messages/thread/replies', JSON.stringify({ content: 'text', client_key: 'delivery:2' })],
    ]);
});

it('honors a header idempotency key without requiring a body client_key', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(unavailable('1')).mockResolvedValueOnce(json({ id: 'message' }, 201));
    vi.stubGlobal('fetch', fetcher);
    const done = expect(api().sendMessage('channel', 'text', 'request-id')).resolves.toEqual({ id: 'message' });
    await vi.advanceTimersByTimeAsync(1000); await done;
    expect(fetcher.mock.calls.map(([, init]) => init.headers['idempotency-key'])).toEqual(['request-id', 'request-id']);
});

it.each(['ECONNREFUSED', 'ECONNRESET'])('retries safe GET connection errors (%s)', async code => {
    const fetcher = vi.fn().mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code } }))
        .mockResolvedValueOnce(json({ id: 'bot' }));
    vi.stubGlobal('fetch', fetcher);
    const done = expect(api().getMe()).resolves.toEqual({ id: 'bot' });
    await vi.advanceTimersByTimeAsync(1000); await done;
    expect(fetcher).toHaveBeenCalledTimes(2);
});

it('a reset after a committed keyed post can return that same post without a duplicate', async () => {
    const posts = new Map<string, { id: string }>();
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
        const { client_key } = JSON.parse(init.body as string);
        if (!posts.has(client_key)) {
            posts.set(client_key, { id: 'once' });
            throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        }
        return json(posts.get(client_key), 201);
    });
    vi.stubGlobal('fetch', fetcher);
    const done = expect(api().sendMessage('channel', 'text', undefined, 'delivery:3')).resolves.toEqual({ id: 'once' });
    await vi.advanceTimersByTimeAsync(1000); await done;
    expect(posts.size).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
});

it('caps Retry-After at 10 seconds and gives up after a total 45-second budget', async () => {
    const fetcher = vi.fn(async () => unavailable('120'));
    vi.stubGlobal('fetch', fetcher);
    const start = Date.now();
    const result = api().sendMessage('channel', 'text', undefined, 'delivery:4').catch(error => error);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await result).toBeInstanceOf(AgoraApiError);
    expect(await result).toMatchObject({ status: 503, code: 'service_unavailable' });
    expect(Date.now() - start).toBe(45_000);
    expect(fetcher).toHaveBeenCalledTimes(5); // 0, 10, 20, 30, 40 seconds; no attempt at expiry.
});

it('honors an HTTP-date Retry-After', async () => {
    const date = new Date(Date.now() + 3000).toUTCString();
    const fetcher = vi.fn().mockResolvedValueOnce(unavailable(date)).mockResolvedValueOnce(json({ id: 'bot' }));
    vi.stubGlobal('fetch', fetcher);
    const done = expect(api().getMe()).resolves.toEqual({ id: 'bot' });
    await vi.advanceTimersByTimeAsync(2999); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await done;
});

it('does not retry a keyless write', async () => {
    const fetcher = vi.fn(async () => unavailable());
    vi.stubGlobal('fetch', fetcher);
    await expect(api().sendMessage('channel', 'unsafe')).rejects.toMatchObject({ status: 503, code: 'service_unavailable' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

it('does not retry a keyless write after a connection reset either', async () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetcher = vi.fn(async () => { throw error; });
    vi.stubGlobal('fetch', fetcher);
    await expect(api().sendMessage('channel', 'unsafe')).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledOnce();
});

it('preserves other 503 codes and paused/validation failures without retrying', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: 'instance_not_initialized' }, 503))
        .mockResolvedValueOnce(json({ reason: 'owner paused it' }, 423))
        .mockResolvedValueOnce(json({ error: 'invalid_body' }, 400));
    vi.stubGlobal('fetch', fetcher);
    await expect(api().getMe()).rejects.toMatchObject({ status: 503, code: 'instance_not_initialized' });
    await expect(api().sendMessage('channel', 'text', undefined, 'key')).rejects.toThrow('This bot is paused');
    await expect(api().sendMessage('channel', 'text', undefined, 'key')).rejects.toMatchObject({ status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
});

it('puts the same overall deadline on each safe attempt, including response-body reads', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn().mockResolvedValueOnce(unavailable('1')).mockResolvedValueOnce(json({ id: 'bot' }));
    vi.stubGlobal('fetch', fetcher);
    const done = expect(api().getMe()).resolves.toEqual({ id: 'bot' });
    await vi.advanceTimersByTimeAsync(1000); await done;
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(45_000);
    expect(fetcher.mock.calls[0][1].signal).toBe(fetcher.mock.calls[1][1].signal);
});

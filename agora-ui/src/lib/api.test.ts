import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

it.each([502, 503, 504])('shows a readable message for a non-JSON %s gateway error', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>upstream failed</html>', { status })));
    await expect(api.post('/servers/fixture/ai/providers/fixture/test', {})).rejects.toMatchObject({
        name: 'ApiError', status,
        message: status === 504 ? 'The server did not answer in time. Try again.'
            : 'The server is temporarily unavailable. Try again in a few seconds.',
    });
});

it.each([502, 503, 504])('also handles an empty %s gateway error', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    await expect(api.get('/health')).rejects.toMatchObject({ status, message: expect.not.stringContaining('unknown_error') });
});

it('preserves a structured API error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'service_unavailable' }), { status: 503 })));
    await expect(api.get('/health')).rejects.toMatchObject({ status: 503, code: 'service_unavailable', message: 'service_unavailable' });
});

it('handles JSON null from a broken gateway without throwing a TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 504 })));
    await expect(api.get('/health')).rejects.toMatchObject({ name: 'ApiError', status: 504, message: 'The server did not answer in time. Try again.' });
});

it('keeps the fallback for other unstructured errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 500 })));
    await expect(api.get('/health')).rejects.toMatchObject({ status: 500, code: 'unknown_error' });
});

it('returns successful JSON unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'timed out after 15 s' }))));
    expect(await api.post('/provider/test', {})).toEqual({ ok: false, error: 'timed out after 15 s' });
});

import { describe, it, expect } from 'vitest';
import { Client, errorCode, HttpError } from '../src/client.js';

/** The host's logs say why a call failed in a short fixed code, never a URL, message or body. */
describe('errorCode', () => {
    it('names the HTTP status and the server code, and drops anything that is not a code', async () => {
        const reply = (status: number, body: string) => async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });
        const call = (fetcher: () => Promise<Response>) => new Client('http://edge:8080/', 'ah_x.y', fetcher as typeof fetch, undefined, 1).claimBoxLogin();
        const err1 = await call(reply(403, '{"error":"box_token_outside_box"}')).catch(e => e);
        expect(err1).toBeInstanceOf(HttpError);
        expect(errorCode(err1)).toBe('http_403_box_token_outside_box');
        const err2 = await call(reply(400, '{"error":"Login failed for https://evil.example/?code=SECRET"}')).catch(e => e);
        expect(errorCode(err2)).toBe('http_400');
        const err3 = await call(reply(502, 'not json')).catch(e => e);
        expect(errorCode(err3)).toBe('http_502');
    });

    it('names timeouts and network errors by their code only', () => {
        expect(errorCode(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
        expect(errorCode(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.2:8080' } }))).toBe('network_econnrefused');
        expect(errorCode(Object.assign(new TypeError('fetch failed'), { cause: { code: 'weird code with spaces' } }))).toBe('error');
        expect(errorCode(new Error('something with https://a.example/?token=abc'))).toBe('error');
    });
});

import { afterEach, expect, it, vi } from 'vitest';
import { AgoraApi } from '../src/api.js';

// What Node's fetch throws when it refuses a certificate: a bare "fetch failed", the reason in cause.code.
const refused = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
afterEach(() => { vi.unstubAllGlobals(); });

it('names an untrusted local certificate and points at the API port (#22)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused('DEPTH_ZERO_SELF_SIGNED_CERT')));
    const error = await new AgoraApi('https://localhost', 'fixture').getMe().catch(e => e);
    expect(error.message).toBe('Node does not trust the TLS certificate of https://localhost (DEPTH_ZERO_SELF_SIGNED_CERT). '
        + 'For a local instance, point agora-mcp at the API port instead: --instance http://localhost:3000.');
    expect(error.cause.message).toBe('fetch failed');
});

it('suggests a trusted certificate for a remote instance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused('UNABLE_TO_VERIFY_LEAF_SIGNATURE')));
    const error = await new AgoraApi('https://agora.example.com', 'fixture').getMe().catch(e => e);
    expect(error.message).toContain('(UNABLE_TO_VERIFY_LEAF_SIGNATURE)');
    expect(error.message).toContain('NODE_EXTRA_CA_CERTS');
});

it('leaves other network errors as they are', async () => {
    const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(dns));
    await expect(new AgoraApi('https://agora.example.com', 'fixture').getMe()).rejects.toBe(dns);
});

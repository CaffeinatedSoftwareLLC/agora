import http2 from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApnsSender, buildApnsPayload, loadApnsKey } from '../src/senders/apns.js';
import { IOS_TOKEN, makeRelay, push, register } from './helpers.js';

// A throwaway P-256 key generated per run, the same kind as an APNs .p8. No Apple credentials.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CFG = { keyPem: KEY_PEM, keyId: 'ABC123DEFG', teamId: 'TEAM123456', bundleId: 'com.caffeinatedsoftware.agora', production: true };
const MSG = { type: 'approval', title: 'Approval waiting', body: 'In #general', url: '/channels/1', instance: 'https://agora.example.com' };

interface Seen {
    headers: http2.IncomingHttpHeaders;
    body: string;
}

/** An h2c server standing in for api.push.apple.com. */
let server: http2.Http2Server;
let origin: string;
let seen: Seen[];
let reply: { status: number; body?: unknown };

beforeAll(async () => {
    server = http2.createServer();
    server.on('stream', (stream, headers) => {
        let body = '';
        stream.on('data', (c) => (body += c));
        stream.on('end', () => {
            seen.push({ headers, body });
            stream.respond({ ':status': reply.status, 'apns-id': 'test-id' });
            stream.end(reply.body ? JSON.stringify(reply.body) : undefined);
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
    seen = [];
    reply = { status: 200 };
});

let senders: ApnsSender[] = [];
afterEach(async () => {
    await Promise.all(senders.map((s) => s.close()));
    senders = [];
});
function sender(now?: () => number) {
    const s = new ApnsSender(CFG, { origin, now });
    senders.push(s);
    return s;
}

describe('APNs sender', () => {
    it('POSTs /3/device/<token> with token auth and the alert headers', async () => {
        const t0 = Date.UTC(2026, 9, 24, 12);
        expect(await sender(() => t0).send(IOS_TOKEN, MSG)).toEqual({ ok: true });
        const { headers, body } = seen[0];
        expect(headers[':method']).toBe('POST');
        expect(headers[':path']).toBe(`/3/device/${IOS_TOKEN}`);
        expect(headers['apns-topic']).toBe('com.caffeinatedsoftware.agora');
        expect(headers['apns-push-type']).toBe('alert');
        expect(headers['apns-priority']).toBe('10');
        expect(headers['apns-expiration']).toBe(String(t0 / 1000 + 86_400));
        expect(headers['content-type']).toBe('application/json');

        const auth = String(headers.authorization);
        expect(auth.startsWith('bearer ')).toBe(true);
        const [h, c, sig] = auth.slice(7).split('.');
        expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
        expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({ iss: 'TEAM123456', iat: t0 / 1000 });
        expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);

        expect(JSON.parse(body)).toEqual({
            aps: { alert: { title: 'Approval waiting', body: 'In #general' }, sound: 'default', category: 'AGORA_APPROVAL' },
            type: 'approval',
            url: '/channels/1',
            instance: 'https://agora.example.com',
        });
    });

    it('sets the approval category only for approvals', () => {
        expect(buildApnsPayload({ ...MSG, type: 'mention' }).aps).toEqual({ alert: { title: 'Approval waiting', body: 'In #general' }, sound: 'default' });
    });

    it('reuses the provider JWT for 50 minutes, then signs a new one', async () => {
        let now = Date.UTC(2026, 9, 24, 12);
        const s = sender(() => now);
        await s.send(IOS_TOKEN, MSG);
        now += 49 * 60_000;
        await s.send(IOS_TOKEN, MSG);
        now += 2 * 60_000;
        await s.send(IOS_TOKEN, MSG);
        const auths = seen.map((x) => x.headers.authorization);
        expect(auths[1]).toBe(auths[0]);
        expect(auths[2]).not.toBe(auths[0]);
    });

    it('signs a new JWT after ExpiredProviderToken', async () => {
        let now = Date.UTC(2026, 9, 24, 12);
        const s = sender(() => now);
        reply = { status: 403, body: { reason: 'ExpiredProviderToken' } };
        expect(await s.send(IOS_TOKEN, MSG)).toEqual({ ok: false, gone: false, reason: 'apns_403_ExpiredProviderToken' });
        now += 1000;
        reply = { status: 200 };
        await s.send(IOS_TOKEN, MSG);
        expect(seen[1].headers.authorization).not.toBe(seen[0].headers.authorization);
    });

    it.each([
        ['410 Unregistered', { status: 410, body: { reason: 'Unregistered', timestamp: 1 } }, true, 'apns_410_Unregistered'],
        ['400 BadDeviceToken', { status: 400, body: { reason: 'BadDeviceToken' } }, true, 'apns_400_BadDeviceToken'],
        ['400 DeviceTokenNotForTopic (misconfiguration)', { status: 400, body: { reason: 'DeviceTokenNotForTopic' } }, false, 'apns_400_DeviceTokenNotForTopic'],
        ['403 InvalidProviderToken', { status: 403, body: { reason: 'InvalidProviderToken' } }, false, 'apns_403_InvalidProviderToken'],
        ['429 TooManyRequests', { status: 429, body: { reason: 'TooManyRequests' } }, false, 'apns_429_TooManyRequests'],
        ['503 without a body', { status: 503 }, false, 'apns_503_Unknown'],
    ])('maps %s', async (_name, r, gone, reason) => {
        reply = r;
        expect(await sender().send(IOS_TOKEN, MSG)).toEqual({ ok: false, gone, reason });
    });

    it('reports a connection failure without deleting anything', async () => {
        const s = new ApnsSender(CFG, { origin: 'http://127.0.0.1:1' });
        senders.push(s);
        expect(await s.send(IOS_TOKEN, MSG)).toEqual({ ok: false, gone: false, reason: 'apns_network' });
    });

    it('uses Apple’s production or sandbox host by default', async () => {
        const prod = new ApnsSender(CFG) as unknown as { origin: string };
        const sandbox = new ApnsSender({ ...CFG, production: false }) as unknown as { origin: string };
        expect(prod.origin).toBe('https://api.push.apple.com');
        expect(sandbox.origin).toBe('https://api.sandbox.push.apple.com');
    });

    it('end to end: provider Unregistered -> relay 410 and the handle is deleted', async () => {
        const relay = await makeRelay({ senders: { ios: sender() } });
        try {
            const handle = (await register(relay, { platform: 'ios', token: IOS_TOKEN })).json().handle as string;
            expect((await push(relay, handle)).statusCode).toBe(202);
            reply = { status: 410, body: { reason: 'Unregistered', timestamp: 1 } };
            expect((await push(relay, handle)).statusCode).toBe(410);
            expect(relay.store.count()).toBe(0);
        } finally {
            await relay.close();
        }
    });
});

describe('loadApnsKey', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'relay-p8-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('reads a .p8 key', () => {
        const p = join(dir, 'AuthKey_ABC123DEFG.p8');
        writeFileSync(p, KEY_PEM);
        expect(loadApnsKey(p)).toBe(KEY_PEM);
    });

    it('rejects a file that is not a key', () => {
        const p = join(dir, 'bad.p8');
        writeFileSync(p, 'not a key');
        expect(() => loadApnsKey(p)).toThrow(/not a PEM private key/);
    });
});

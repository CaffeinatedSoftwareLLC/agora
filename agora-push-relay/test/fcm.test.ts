import http from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FcmSender, buildFcmMessage, loadServiceAccount, type ServiceAccount } from '../src/senders/fcm.js';
import { makeRelay, push, pushBody, register } from './helpers.js';

// A throwaway key generated per run. No real Google credentials are used.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA: ServiceAccount = {
    project_id: 'agora-test',
    client_email: 'relay@agora-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth2.googleapis.com/token',
};
const MSG = { type: 'approval', title: 'Approval waiting', body: 'In #general', url: '/channels/1', instance: 'https://agora.example.com' };

interface Seen {
    method: string;
    path: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

/** One local server stands in for both oauth2.googleapis.com and fcm.googleapis.com. */
let server: http.Server;
let base: string;
let seen: Seen[];
let fcmReply: { status: number; body: unknown };
let tokenCounter = 0;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            seen.push({ method: req.method!, path: req.url!, headers: req.headers, body });
            res.setHeader('content-type', 'application/json');
            if (req.url === '/token') {
                tokenCounter += 1;
                res.end(JSON.stringify({ access_token: `ya29.test-${tokenCounter}`, expires_in: 3599, token_type: 'Bearer' }));
                return;
            }
            res.statusCode = fcmReply.status;
            res.end(JSON.stringify(fcmReply.body));
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
    seen = [];
    tokenCounter = 0;
    fcmReply = { status: 200, body: { name: 'projects/agora-test/messages/0:1' } };
});

const sender = (now?: () => number) => new FcmSender(SA, { endpoint: base, tokenUri: `${base}/token`, now });

function fcmError(status: number, grpc: string, errorCode?: string, message = 'error') {
    return {
        status,
        body: { error: { code: status, message, status: grpc, details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [] } },
    };
}

describe('FCM HTTP v1 sender', () => {
    it('mints an access token with a signed RS256 JWT bearer grant', async () => {
        expect(await sender().send('device-token', MSG)).toEqual({ ok: true });
        const tokenReq = seen.find((s) => s.path === '/token')!;
        expect(tokenReq.method).toBe('POST');
        expect(tokenReq.headers['content-type']).toBe('application/x-www-form-urlencoded');
        const form = new URLSearchParams(tokenReq.body);
        expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        const [h, c, sig] = form.get('assertion')!.split('.');
        expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
        const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
        expect(claims).toMatchObject({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: `${base}/token` });
        expect(claims.exp - claims.iat).toBe(3600);
        expect(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    });

    it('POSTs the message to projects/<id>/messages:send with the bearer token', async () => {
        await sender().send('device-token', MSG);
        const send = seen.find((s) => s.path !== '/token')!;
        expect(send.method).toBe('POST');
        expect(send.path).toBe('/v1/projects/agora-test/messages:send');
        expect(send.headers.authorization).toBe('Bearer ya29.test-1');
        expect(send.headers['content-type']).toBe('application/json');
        expect(JSON.parse(send.body)).toEqual({
            message: {
                token: 'device-token',
                notification: { title: 'Approval waiting', body: 'In #general' },
                data: { type: 'approval', url: '/channels/1', instance: 'https://agora.example.com' },
                android: { priority: 'HIGH', ttl: '86400s', notification: { channel_id: 'agora' } },
            },
        });
        expect(JSON.parse(send.body)).toEqual(buildFcmMessage('device-token', MSG));
    });

    it('caches the access token until a minute before expiry', async () => {
        let now = 1_000_000;
        const s = sender(() => now);
        await s.send('t', MSG);
        await s.send('t', MSG);
        expect(tokenCounter).toBe(1);
        now += 3539_000 + 1;
        await s.send('t', MSG);
        expect(tokenCounter).toBe(2);
    });

    it('fetches one token for concurrent sends', async () => {
        const s = sender();
        await Promise.all([s.send('a', MSG), s.send('b', MSG), s.send('c', MSG)]);
        expect(tokenCounter).toBe(1);
    });

    it('drops the cached token after a 401', async () => {
        const s = sender();
        fcmReply = fcmError(401, 'UNAUTHENTICATED', 'THIRD_PARTY_AUTH_ERROR');
        expect(await s.send('t', MSG)).toEqual({ ok: false, gone: false, reason: 'fcm_401_THIRD_PARTY_AUTH_ERROR' });
        fcmReply = { status: 200, body: {} };
        await s.send('t', MSG);
        expect(tokenCounter).toBe(2);
    });

    it.each([
        ['404 UNREGISTERED', fcmError(404, 'NOT_FOUND', 'UNREGISTERED'), true, 'fcm_404_UNREGISTERED'],
        ['400 invalid registration token', fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token'), true, 'fcm_400_INVALID_ARGUMENT'],
        ['400 other invalid argument', fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'Invalid value at message.data'), false, 'fcm_400_INVALID_ARGUMENT'],
        ['403 SENDER_ID_MISMATCH (misconfiguration)', fcmError(403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH'), false, 'fcm_403_SENDER_ID_MISMATCH'],
        ['404 without FCM details (wrong project)', fcmError(404, 'NOT_FOUND'), false, 'fcm_404_NOT_FOUND'],
        ['429 QUOTA_EXCEEDED', fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED'), false, 'fcm_429_QUOTA_EXCEEDED'],
        ['503 UNAVAILABLE', fcmError(503, 'UNAVAILABLE', 'UNAVAILABLE'), false, 'fcm_503_UNAVAILABLE'],
    ])('maps %s', async (_name, reply, gone, reason) => {
        fcmReply = reply;
        expect(await sender().send('t', MSG)).toEqual({ ok: false, gone, reason });
    });

    it('reports a network failure without deleting anything', async () => {
        const s = new FcmSender(SA, { endpoint: 'http://127.0.0.1:1', tokenUri: `${base}/token` });
        expect(await s.send('t', MSG)).toEqual({ ok: false, gone: false, reason: 'fcm_network' });
    });

    it('reports a token endpoint failure', async () => {
        const s = new FcmSender(SA, { endpoint: base, tokenUri: `${base}/token-missing` });
        fcmReply = { status: 400, body: { error: 'invalid_grant' } };
        // The stub answers every non-/token path with fcmReply.
        expect(await s.send('t', MSG)).toEqual({ ok: false, gone: false, reason: 'fcm_oauth_400' });
    });

    it('refuses a non-https token_uri from the service-account file', () => {
        expect(() => new FcmSender({ ...SA, token_uri: 'http://evil.example.com/token' })).toThrow(/https/);
    });

    it('end to end: provider UNREGISTERED -> relay 410 and the handle is deleted', async () => {
        const relay = await makeRelay({ senders: { android: sender() } });
        try {
            const handle = (await register(relay)).json().handle as string;
            expect((await push(relay, handle)).statusCode).toBe(202);
            fcmReply = fcmError(404, 'NOT_FOUND', 'UNREGISTERED');
            expect((await push(relay, handle, pushBody())).statusCode).toBe(410);
            expect(relay.store.count()).toBe(0);
        } finally {
            await relay.close();
        }
    });
});

describe('loadServiceAccount', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'relay-sa-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('reads a service-account JSON', () => {
        const p = join(dir, 'sa.json');
        writeFileSync(p, JSON.stringify({ type: 'service_account', ...SA }));
        expect(loadServiceAccount(p)).toEqual(SA);
    });

    it('rejects other JSON without echoing it', () => {
        const p = join(dir, 'sa.json');
        writeFileSync(p, JSON.stringify({ type: 'authorized_user', secret: 'DO-NOT-ECHO' }));
        expect(() => loadServiceAccount(p)).toThrow(/not a service-account key/);
        try {
            loadServiceAccount(p);
        } catch (err) {
            expect(String(err)).not.toContain('DO-NOT-ECHO');
        }
    });

    it('rejects a missing file', () => {
        expect(() => loadServiceAccount(join(dir, 'nope.json'))).toThrow(/cannot read/);
    });
});

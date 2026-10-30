import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSender, makeRelay, push, pushBody, register, type TestRelay } from './helpers.js';

const TITLE = 'TITLE-CANARY-7f3a';
const BODY = 'BODY-CANARY-91c2';
const URL_PATH = '/channels/URL-CANARY-5d1e';
const TOKEN = 'TOKEN-CANARY-c0ffee-' + 'z'.repeat(100);
const INSTANCE = 'https://instance-canary.example.com';

let relay: TestRelay;
beforeEach(async () => {
    relay = await makeRelay();
});
afterEach(async () => {
    await relay.close();
});

async function exercise(): Promise<string> {
    const handle = (await register(relay, { token: TOKEN, instance: INSTANCE })).json().handle as string;
    const body = pushBody({ instance: INSTANCE, title: TITLE, body: BODY, url: URL_PATH });
    expect((await push(relay, handle, body)).statusCode).toBe(202);
    expect((await register(relay, { token: TOKEN, instance: INSTANCE, previous: handle })).statusCode).toBe(200);
    // Every failure path logs too.
    await push(relay, handle, { ...body, instance: 'https://other.example.com' });
    await push(relay, handle, { ...body, title: TITLE + 'x'.repeat(200) });
    await push(relay, 'B'.repeat(43), body);
    (relay.senders.android as FakeSender).next = { ok: false, gone: false, reason: 'fcm_500_INTERNAL' };
    await push(relay, handle, body);
    (relay.senders.android as FakeSender).next = { ok: false, gone: true, reason: 'fcm_404_UNREGISTERED' };
    await push(relay, handle, body);
    await relay.app.inject({ method: 'POST', url: '/v1/push', headers: { authorization: `Bearer ${handle}`, 'content-type': 'application/json' }, payload: `{"title":"${TITLE}` });
    return handle;
}

describe('privacy', () => {
    it('logs contain no title, body, url, token, instance or handle, only outcome codes', async () => {
        const handle = await exercise();
        const logs = relay.logs.join('');
        expect(relay.logs.length).toBeGreaterThan(5);
        for (const secret of [TITLE, BODY, URL_PATH, 'URL-CANARY', TOKEN, 'TOKEN-CANARY', 'instance-canary', handle]) {
            expect(logs).not.toContain(secret);
        }
        const outcomes = relay.logs.map((l) => JSON.parse(l)).filter((l) => l.msg === 'request').map((l) => l.outcome);
        expect(outcomes).toEqual(
            expect.arrayContaining(['registered_android', 'renewed_android', 'sent_android', 'instance_mismatch', 'invalid_body', 'unknown_handle', 'fcm_500_INTERNAL', 'gone_fcm_404_UNREGISTERED']),
        );
    });

    it('the database file holds neither the handle nor the token, instance or payload', async () => {
        const handle = (await register(relay, { token: TOKEN, instance: INSTANCE })).json().handle as string;
        await push(relay, handle, pushBody({ instance: INSTANCE, title: TITLE, body: BODY, url: URL_PATH }));
        const bytes = Buffer.concat(
            [relay.dbPath, `${relay.dbPath}-wal`].flatMap((p) => {
                try {
                    return [readFileSync(p)];
                } catch {
                    return [];
                }
            }),
        ).toString('latin1');
        expect(bytes.length).toBeGreaterThan(0);
        for (const secret of [handle, TOKEN, 'TOKEN-CANARY', 'instance-canary', TITLE, BODY, 'URL-CANARY']) expect(bytes).not.toContain(secret);
    });

    it('keeps counts per outcome', async () => {
        await exercise();
        expect(relay.app.counters).toMatchObject({ registered_android: 1, renewed_android: 1, sent_android: 1, instance_mismatch: 1 });
    });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp, type AppOptions } from '../src/app.js';
import { deriveKeys } from '../src/crypto.js';
import { HandleStore, type Platform } from '../src/store.js';
import type { PushMessage, Sender, SendResult } from '../src/senders/types.js';

export const INSTANCE = 'https://agora.example.com';
export const ANDROID_TOKEN = 'fcm-token:APA91b' + 'x'.repeat(140);
export const IOS_TOKEN = 'ab'.repeat(32);

/** Records what it was asked to send and answers with `next`. */
export class FakeSender implements Sender {
    calls: Array<{ token: string; message: PushMessage }> = [];
    next: SendResult = { ok: true };
    async send(token: string, message: PushMessage): Promise<SendResult> {
        this.calls.push({ token, message });
        return this.next;
    }
}

export interface TestRelay {
    app: ReturnType<typeof buildApp>;
    store: HandleStore;
    senders: Partial<Record<Platform, Sender>>;
    logs: string[];
    dbPath: string;
    clock: { now: number };
    close(): Promise<void>;
}

export async function makeRelay(opts: Partial<AppOptions> = {}): Promise<TestRelay> {
    const dir = mkdtempSync(join(tmpdir(), 'agora-push-relay-'));
    const dbPath = join(dir, 'relay.db');
    const store = new HandleStore(dbPath, deriveKeys(randomBytes(32)));
    const logs: string[] = [];
    const clock = { now: Date.UTC(2026, 9, 24, 12) };
    const senders = opts.senders ?? { android: new FakeSender(), ios: new FakeSender() };
    const app = buildApp({
        store,
        senders,
        now: () => clock.now,
        logger: { level: 'debug', stream: { write: (line: string) => logs.push(line) } },
        ...opts,
    });
    await app.ready();
    return {
        app,
        store,
        senders,
        logs,
        dbPath,
        clock,
        async close() {
            await app.close();
            store.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

export async function register(relay: TestRelay, body: Record<string, unknown> = {}, ip = '203.0.113.1') {
    return relay.app.inject({
        method: 'POST',
        url: '/v1/register',
        remoteAddress: ip,
        payload: { platform: 'android', token: ANDROID_TOKEN, instance: INSTANCE, ...body },
    });
}

export function pushBody(over: Record<string, unknown> = {}) {
    return { instance: INSTANCE, type: 'approval', title: 'Approval waiting', body: 'In #general', url: '/channels/01ABC/threads/01DEF', ...over };
}

export async function push(relay: TestRelay, handle: string | null, body: Record<string, unknown> = pushBody()) {
    return relay.app.inject({
        method: 'POST',
        url: '/v1/push',
        headers: handle === null ? {} : { authorization: `Bearer ${handle}` },
        payload: body,
    });
}

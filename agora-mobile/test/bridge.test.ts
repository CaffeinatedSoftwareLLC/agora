import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, createAgoraNative, type BridgeDeps, type PushPlugin } from '../src/lib/bridge';
import type { HttpRequest } from '../src/lib/http';
import { handleKey } from '../src/lib/servers';
import { fakeHttp, memoryKv } from './helpers';

const RELAY = 'https://push.agora.host';
const INSTANCE = 'https://agora.example.com';
const HANDLE = 'A'.repeat(21) + '_' + 'b'.repeat(20) + '-';
const OTHER_HANDLE = 'Z'.repeat(43);

type Listener = (value: never) => void;

/** A fake @capacitor/push-notifications that answers register() through its listeners, like the real one. */
function fakePush(opts: {
    permission?: string;
    afterRequest?: string;
    token?: string | null;
    error?: string;
} = {}) {
    const listeners = new Map<string, Set<Listener>>();
    const push = {
        listeners,
        checkPermissions: vi.fn(async () => ({ receive: opts.permission ?? 'granted' })),
        requestPermissions: vi.fn(async () => ({ receive: opts.afterRequest ?? 'granted' })),
        register: vi.fn(async () => {
            queueMicrotask(() => {
                if (opts.error) listeners.get('registrationError')?.forEach((cb) => cb({ error: opts.error } as never));
                else if (opts.token !== null) listeners.get('registration')?.forEach((cb) => cb({ value: opts.token ?? 'device-token' } as never));
            });
        }),
        addListener: vi.fn(async (event: string, cb: Listener) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(cb);
            return { remove: async () => { listeners.get(event)!.delete(cb); } };
        }),
    };
    return push;
}

function relay(status = 201, body: unknown = { handle: HANDLE }) {
    return fakeHttp({
        [`${RELAY}/v1/register`]: () => ({ status, data: body }),
        [`${RELAY}/v1/handles`]: () => ({ status: 204, data: '' }),
    });
}

function setup(overrides: Omit<Partial<BridgeDeps>, 'push'> & { push?: ReturnType<typeof fakePush> } = {}) {
    const push = overrides.push ?? fakePush();
    const http = (overrides.http as ReturnType<typeof relay>) ?? relay();
    const kv = (overrides.kv as ReturnType<typeof memoryKv>) ?? memoryKv();
    const deps: BridgeDeps = {
        platform: 'android',
        version: '0.1.0',
        relayUrl: RELAY,
        origin: INSTANCE,
        deviceInfo: async () => ({ model: 'Pixel 8', manufacturer: 'Google' }),
        tokenTimeoutMs: 200,
        ...overrides,
        push: push as unknown as PushPlugin,
        http,
        kv,
    };
    return { native: createAgoraNative(deps), push, http, kv };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('AgoraNative', () => {
    it('exposes platform and version and cannot be changed', () => {
        const { native } = setup({ platform: 'ios' });
        expect(native.platform).toBe('ios');
        expect(native.version).toBe('0.1.0');
        expect(Object.isFrozen(native)).toBe(true);
    });

    it('refuses a relay URL that is not https', () => {
        expect(() => setup({ relayUrl: 'http://push.agora.host' })).toThrow(BridgeError);
    });
});

describe('registerPush', () => {
    it('registers the device token with the relay for this instance', async () => {
        const { native, http, kv, push } = setup();
        await expect(native.registerPush()).resolves.toEqual({
            relay: RELAY,
            handle: HANDLE,
            platform: 'android',
            label: 'Pixel 8 (Android)',
        });
        expect(push.requestPermissions).not.toHaveBeenCalled();
        const [req] = http.request.mock.calls[0] as [HttpRequest];
        expect(req).toMatchObject({
            url: `${RELAY}/v1/register`,
            method: 'POST',
            data: { platform: 'android', token: 'device-token', instance: INSTANCE },
        });
        expect(kv.data.get(handleKey(INSTANCE))).toBe(HANDLE);
        // Listeners are cleaned up.
        expect([...push.listeners.values()].every((s) => s.size === 0)).toBe(true);
    });

    it('asks for permission when needed', async () => {
        const push = fakePush({ permission: 'prompt' });
        const { native } = setup({ push });
        await expect(native.registerPush()).resolves.not.toBeNull();
        expect(push.requestPermissions).toHaveBeenCalledOnce();
    });

    it.each(['denied', 'prompt'])('resolves null when permission ends up %s', async (afterRequest) => {
        const push = fakePush({ permission: 'prompt', afterRequest });
        const { native, http } = setup({ push });
        await expect(native.registerPush()).resolves.toBeNull();
        expect(push.register).not.toHaveBeenCalled();
        expect(http.request).not.toHaveBeenCalled();
    });

    it('resolves null without prompting when permission was denied before', async () => {
        const push = fakePush({ permission: 'denied' });
        const { native } = setup({ push });
        await expect(native.registerPush()).resolves.toBeNull();
        expect(push.requestPermissions).not.toHaveBeenCalled();
    });

    it('rejects when the platform cannot give a token', async () => {
        const { native, http } = setup({ push: fakePush({ error: 'MISSING_INSTANCEID_SERVICE' }) });
        await expect(native.registerPush()).rejects.toThrow(/push_registration_failed: MISSING_INSTANCEID_SERVICE/);
        expect(http.request).not.toHaveBeenCalled();
    });

    it('rejects when no token arrives', async () => {
        const { native } = setup({ push: fakePush({ token: null }) });
        await expect(native.registerPush()).rejects.toThrow('push_token_timeout');
    });

    it.each([
        [500, { error: 'boom' }],
        [201, { handle: 'short' }],
        [201, {}],
        [200, { handle: HANDLE }],
        [429, { error: 'rate_limited' }],
    ])('rejects a relay answer of %s %j and stores nothing', async (status, body) => {
        const { native, kv } = setup({ http: relay(status, body) });
        await expect(native.registerPush()).rejects.toThrow(/relay_register_failed/);
        expect(kv.data.size).toBe(0);
    });

    it('shares one registration between overlapping calls', async () => {
        const { native, push } = setup();
        const [a, b] = await Promise.all([native.registerPush(), native.registerPush()]);
        expect(a).toEqual(b);
        expect(push.register).toHaveBeenCalledOnce();
        await native.registerPush();
        expect(push.register).toHaveBeenCalledTimes(2);
    });

    it('still registers when the device info is unavailable', async () => {
        const { native } = setup({ deviceInfo: async () => { throw new Error('nope'); } });
        await expect(native.registerPush()).resolves.toMatchObject({ label: 'Phone (Android)' });
    });

    it('refuses to run on a page that is not an https instance origin', async () => {
        for (const origin of ['https://localhost', 'capacitor://localhost', 'http://agora.example.com']) {
            const { native, push } = setup({ origin });
            await expect(native.registerPush()).rejects.toThrow('instance_origin_invalid');
            expect(push.checkPermissions).not.toHaveBeenCalled();
        }
    });
});

describe('unregisterPush', () => {
    it('deletes the handle at the relay and forgets it', async () => {
        const { native, http, kv } = setup({ kv: memoryKv({ [handleKey(INSTANCE)]: HANDLE }) });
        await native.unregisterPush(HANDLE);
        const [req] = http.request.mock.calls[0] as [HttpRequest];
        expect(req).toMatchObject({ url: `${RELAY}/v1/handles`, method: 'DELETE', headers: { Authorization: `Bearer ${HANDLE}` } });
        expect(kv.data.has(handleKey(INSTANCE))).toBe(false);
    });

    it('keeps a newer stored handle', async () => {
        const { native, kv } = setup({ kv: memoryKv({ [handleKey(INSTANCE)]: OTHER_HANDLE }) });
        await native.unregisterPush(HANDLE);
        expect(kv.data.get(handleKey(INSTANCE))).toBe(OTHER_HANDLE);
    });

    it('treats an unknown handle (401) as already gone', async () => {
        const http = fakeHttp({ [`${RELAY}/v1/handles`]: { status: 401, data: '' } });
        const { native } = setup({ http });
        await expect(native.unregisterPush(HANDLE)).resolves.toBeUndefined();
    });

    it('rejects other relay failures', async () => {
        const http = fakeHttp({ [`${RELAY}/v1/handles`]: { status: 503, data: '' } });
        const { native } = setup({ http });
        await expect(native.unregisterPush(HANDLE)).rejects.toThrow(/relay_unregister_failed: 503/);
    });

    it.each(['', 'short', `${HANDLE}x`, 'A'.repeat(42) + '=', 42])('refuses the handle %j without calling the relay', async (handle) => {
        const { native, http } = setup();
        await expect(native.unregisterPush(handle as string)).rejects.toThrow('handle_invalid');
        expect(http.request).not.toHaveBeenCalled();
    });

    it('never unregisters the device token itself', async () => {
        const push = fakePush();
        const { native } = setup({ push });
        await native.unregisterPush(HANDLE);
        expect(Object.keys(push)).not.toContain('unregister');
    });
});

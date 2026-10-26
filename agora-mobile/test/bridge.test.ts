import { describe, expect, it, vi } from 'vitest';
import { BridgeError, createAgoraNative, deleteRelayHandle, type BridgeDeps } from '../src/lib/bridge';
import type { HttpRequest } from '../src/lib/http';
import type { AgoraShellPush, NativeRegistration } from '../src/lib/shell';
import { fakeHttp } from './helpers';

const RELAY = 'https://push.agora.host';
const HANDLE = 'A'.repeat(21) + '_' + 'b'.repeat(20) + '-';

/**
 * A stand-in for the native AgoraShell push methods. Like the real ones, it keeps one
 * handle per (origin, token) and only calls the relay when the token changes.
 */
function fakeShell(opts: { answer?: NativeRegistration | (() => NativeRegistration); fail?: string } = {}) {
    let relayCalls = 0;
    let stored: { handle: string; tokenHash: string } | null = null;
    let token = 'device-token';
    const shell = {
        get relayCalls() { return relayCalls; },
        setToken(t: string) { token = t; },
        registerPush: vi.fn(async (...args: unknown[]): Promise<NativeRegistration> => {
            expect(args).toEqual([]);
            if (opts.fail) throw new Error(opts.fail);
            if (opts.answer) return typeof opts.answer === 'function' ? opts.answer() : opts.answer;
            if (stored && stored.tokenHash === `sha256(${token})`) return { registered: true, relay: RELAY, handle: stored.handle, platform: 'android' };
            relayCalls += 1;
            stored = { handle: String.fromCharCode(64 + relayCalls).repeat(43), tokenHash: `sha256(${token})` };
            return { registered: true, relay: RELAY, handle: stored.handle, platform: 'android' };
        }),
        unregisterPush: vi.fn(async (_o: { handle: string }) => undefined),
        hasPushHandle: vi.fn(async () => ({ value: stored !== null })),
    };
    return shell;
}

function setup(overrides: Partial<BridgeDeps> & { shell?: ReturnType<typeof fakeShell> } = {}) {
    const shell = overrides.shell ?? fakeShell();
    const deps: BridgeDeps = {
        platform: 'android',
        version: '0.1.0',
        relayUrl: RELAY,
        deviceInfo: async () => ({ model: 'Pixel 8', manufacturer: 'Google' }),
        ...overrides,
        shell: shell as unknown as AgoraShellPush,
    };
    return { native: createAgoraNative(deps), shell };
}

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
    it('asks native code, with no token or origin from the page, and adds the label', async () => {
        const { native, shell } = setup();
        await expect(native.registerPush()).resolves.toEqual({
            relay: RELAY,
            handle: 'A'.repeat(43),
            platform: 'android',
            label: 'Pixel 8 (Android)',
        });
        expect(shell.registerPush).toHaveBeenCalledWith();
    });

    it('returns the same handle for a second call with the same token, with no new relay registration', async () => {
        const { native, shell } = setup();
        const first = await native.registerPush();
        const second = await native.registerPush();
        expect(second).toEqual(first);
        expect(shell.relayCalls).toBe(1);
        // A new device token gets a new handle.
        shell.setToken('rotated-token');
        const third = await native.registerPush();
        expect(third?.handle).not.toBe(first?.handle);
        expect(shell.relayCalls).toBe(2);
    });

    it('resolves null when permission is denied', async () => {
        const { native } = setup({ shell: fakeShell({ answer: { registered: false } }) });
        await expect(native.registerPush()).resolves.toBeNull();
    });

    it('passes native failures on', async () => {
        const { native } = setup({ shell: fakeShell({ fail: 'relay_register_failed: 500' }) });
        await expect(native.registerPush()).rejects.toThrow('relay_register_failed: 500');
    });

    it.each([
        { registered: true, relay: 'https://evil.example.com', handle: HANDLE, platform: 'android' },
        { registered: true, relay: RELAY, handle: 'short', platform: 'android' },
        { registered: true, relay: RELAY, handle: HANDLE, platform: 'ios' },
    ] as NativeRegistration[])('rejects an unexpected native answer %j', async (answer) => {
        const { native } = setup({ shell: fakeShell({ answer }) });
        await expect(native.registerPush()).rejects.toThrow('native_register_invalid');
    });

    it('shares one registration between overlapping calls', async () => {
        const { native, shell } = setup();
        const [a, b] = await Promise.all([native.registerPush(), native.registerPush()]);
        expect(a).toEqual(b);
        expect(shell.registerPush).toHaveBeenCalledOnce();
        await native.registerPush();
        expect(shell.registerPush).toHaveBeenCalledTimes(2);
    });

    it('still registers when the device info is unavailable', async () => {
        const { native } = setup({ deviceInfo: async () => { throw new Error('nope'); } });
        await expect(native.registerPush()).resolves.toMatchObject({ label: 'Phone (Android)' });
    });
});

describe('unregisterPush', () => {
    it('hands the handle to native code, which checks it belongs to this origin', async () => {
        const { native, shell } = setup();
        await native.unregisterPush(HANDLE);
        expect(shell.unregisterPush).toHaveBeenCalledWith({ handle: HANDLE });
    });

    it('passes a native refusal on', async () => {
        const shell = fakeShell();
        shell.unregisterPush.mockRejectedValueOnce(new Error('handle_not_registered'));
        const { native } = setup({ shell });
        await expect(native.unregisterPush(HANDLE)).rejects.toThrow('handle_not_registered');
    });

    it.each(['', 'short', `${HANDLE}x`, 'A'.repeat(42) + '=', 42])('refuses the handle %j without calling native code', async (handle) => {
        const { native, shell } = setup();
        await expect(native.unregisterPush(handle as string)).rejects.toThrow('handle_invalid');
        expect(shell.unregisterPush).not.toHaveBeenCalled();
    });
});

describe('deleteRelayHandle (picker, when a server is removed)', () => {
    it('deletes the handle at the relay', async () => {
        const http = fakeHttp({ [`${RELAY}/v1/handles`]: { status: 204, data: '' } });
        await deleteRelayHandle(http, RELAY, HANDLE);
        const [req] = http.request.mock.calls[0] as [HttpRequest];
        expect(req).toMatchObject({ url: `${RELAY}/v1/handles`, method: 'DELETE', headers: { Authorization: `Bearer ${HANDLE}` } });
    });

    it('treats an unknown handle (401) as already gone and rejects other failures', async () => {
        await expect(deleteRelayHandle(fakeHttp({ [`${RELAY}/v1/handles`]: { status: 401, data: '' } }), RELAY, HANDLE)).resolves.toBeUndefined();
        await expect(deleteRelayHandle(fakeHttp({ [`${RELAY}/v1/handles`]: { status: 503, data: '' } }), RELAY, HANDLE))
            .rejects.toThrow(/relay_unregister_failed: 503/);
    });

    it('refuses a malformed handle', async () => {
        const http = fakeHttp({});
        await expect(deleteRelayHandle(http, RELAY, 'short')).rejects.toThrow('handle_invalid');
        expect(http.request).not.toHaveBeenCalled();
    });
});

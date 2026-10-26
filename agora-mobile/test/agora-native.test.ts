import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgoraNative } from '../src/lib/bridge';

/**
 * The injected script as built: which Capacitor plugins it wires to window.AgoraNative.
 * The plugins are mocked; the native side is covered by the JVM tests and
 * test/consistency.test.ts.
 */
const HANDLE = 'H'.repeat(43);

const shell = vi.hoisted(() => ({
    registerPush: vi.fn(),
    unregisterPush: vi.fn(),
    hasPushHandle: vi.fn(),
    getLaunchState: vi.fn(),
    serversChanged: vi.fn(),
}));
const push = vi.hoisted(() => ({ addListener: vi.fn(async () => ({ remove: async () => undefined })) }));

vi.mock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => 'android' },
    registerPlugin: (name: string) => {
        if (name !== 'AgoraShell') throw new Error(`unexpected plugin ${name}`);
        return shell;
    },
    CapacitorHttp: { request: () => { throw new Error('instance pages must not use CapacitorHttp'); } },
}));
vi.mock('@capacitor/device', () => ({ Device: { getInfo: async () => ({ model: 'Pixel 8', manufacturer: 'Google' }) } }));
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: push }));
vi.mock('@capacitor/preferences', () => ({ Preferences: new Proxy({}, { get: () => { throw new Error('instance pages must not use Preferences'); } }) }));

afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
});

async function load(origin: string) {
    vi.resetModules();
    const win = { location: { origin, href: `${origin}/app/01Z`, assign: vi.fn() }, WEBVIEW_SERVER_URL: 'https://localhost' } as {
        location: { origin: string; href: string; assign: ReturnType<typeof vi.fn> };
        WEBVIEW_SERVER_URL: string;
        AgoraNative?: AgoraNative;
    };
    (globalThis as { window?: unknown }).window = win;
    await import('../src/inject/agora-native');
    return win;
}

describe('agora-native.js', () => {
    it('registers through AgoraShell.registerPush with no arguments from the page', async () => {
        shell.registerPush.mockResolvedValueOnce({ registered: true, relay: 'https://push.agora.host', handle: HANDLE, platform: 'android' });
        const win = await load('https://a.example.com');
        await expect(win.AgoraNative!.registerPush()).resolves.toEqual({
            relay: 'https://push.agora.host',
            handle: HANDLE,
            platform: 'android',
            label: 'Pixel 8 (Android)',
        });
        expect(shell.registerPush).toHaveBeenCalledWith();
    });

    it('unregisters through AgoraShell.unregisterPush', async () => {
        const win = await load('https://a.example.com');
        await win.AgoraNative!.unregisterPush(HANDLE);
        expect(shell.unregisterPush).toHaveBeenCalledWith({ handle: HANDLE });
    });

    it('listens only for taps', async () => {
        push.addListener.mockClear();
        await load('https://a.example.com');
        expect(push.addListener.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['pushNotificationActionPerformed']);
    });

    it('does not install on the picker', async () => {
        const win = await load('https://localhost');
        expect(win.AgoraNative).toBeUndefined();
    });

    it('imports neither CapacitorHttp nor Preferences', () => {
        const source = readFileSync(new URL('../src/inject/agora-native.ts', import.meta.url), 'utf8');
        const imports = source.split(/\r?\n/).filter((line) => line.startsWith('import ')).join('\n');
        expect(imports).not.toMatch(/CapacitorHttp|@capacitor\/preferences/);
        expect(source).not.toMatch(/\.register\(|'registration'/);
    });
});

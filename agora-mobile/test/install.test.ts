import { describe, expect, it, vi } from 'vitest';
import { install, type InstallDeps, type InstanceWindow } from '../src/inject/install';
import { handleKey } from '../src/lib/servers';
import { fakeHttp, memoryKv } from './helpers';

const ORIGIN = 'https://a.example.com';
const HANDLE = 'H'.repeat(43);

function fakeWindow(origin: string, localUrl = 'https://localhost'): InstanceWindow & { assign: ReturnType<typeof vi.fn> } {
    const assign = vi.fn();
    return { location: { origin, href: `${origin}/app/01Z`, assign }, WEBVIEW_SERVER_URL: localUrl, assign };
}

function deps(overrides: Partial<InstallDeps> = {}) {
    let tap: ((action: unknown) => Promise<void>) | undefined;
    const kv = memoryKv({ [handleKey(ORIGIN)]: HANDLE });
    const d: InstallDeps = {
        platform: 'android',
        version: '0.1.0',
        relayUrl: 'https://push.agora.host',
        push: {
            checkPermissions: vi.fn(),
            requestPermissions: vi.fn(),
            register: vi.fn(),
            addListener: vi.fn(async (event: string, cb: (a: unknown) => Promise<void>) => {
                if (event === 'pushNotificationActionPerformed') tap = cb;
                return { remove: async () => undefined };
            }),
        } as unknown as InstallDeps['push'],
        http: fakeHttp({}),
        kv,
        deviceInfo: async () => ({}),
        ...overrides,
    };
    return { d, kv, tap: (action: unknown) => tap!(action) };
}

describe('install', () => {
    it('defines a read-only window.AgoraNative on an instance page', () => {
        const win = fakeWindow(ORIGIN);
        expect(install(win, deps().d)).toBe(true);
        const native = win.AgoraNative!;
        expect(native).toMatchObject({ platform: 'android', version: '0.1.0' });
        expect(() => { 'use strict'; (win as { AgoraNative?: unknown }).AgoraNative = {}; }).toThrow(TypeError);
        expect(win.AgoraNative).toBe(native);
        expect(install(win, deps().d)).toBe(false);
    });

    it.each([
        ['the Android picker', 'https://localhost'],
        ['the iOS picker', 'capacitor://localhost'],
        ['an http page', 'http://a.example.com'],
    ])('does nothing on %s', (_name, origin) => {
        const win = fakeWindow(origin);
        expect(install(win, deps().d)).toBe(false);
        expect(win.AgoraNative).toBeUndefined();
    });

    it('does nothing outside the app', () => {
        const win = fakeWindow(ORIGIN);
        expect(install(win, deps({ platform: 'web' }).d)).toBe(false);
        expect(win.AgoraNative).toBeUndefined();
    });

    it('opens a tapped notification for this instance in place', async () => {
        const win = fakeWindow(ORIGIN);
        const { d, tap } = deps();
        install(win, d);
        await tap({ actionId: 'tap', notification: { data: { instance: ORIGIN, url: '/app/01A?thread=01B', type: 'mention' } } });
        expect(win.assign).toHaveBeenCalledWith('https://a.example.com/app/01A?thread=01B');
    });

    it('hands a notification for another server to the picker', async () => {
        const win = fakeWindow(ORIGIN, 'https://localhost');
        const { d, tap } = deps();
        install(win, d);
        await tap({ actionId: 'APPROVE', notification: { data: { instance: 'https://b.example.com', url: '/app/01A' } } });
        expect(win.assign).toHaveBeenCalledOnce();
        const target = win.assign.mock.calls[0][0] as string;
        expect(target).toMatch(/^https:\/\/localhost\/#open=/);
        // The picker can send the user back to where they were if it refuses the link.
        expect(decodeURIComponent(target)).toContain('"from":"https://a.example.com/app/01Z"');
    });

    it('ignores a tap with an off-origin url or no handle', async () => {
        const win = fakeWindow(ORIGIN);
        const { d, kv, tap } = deps();
        install(win, d);
        await tap({ notification: { data: { instance: ORIGIN, url: 'https://evil.com/' } } });
        kv.data.clear();
        await tap({ notification: { data: { instance: ORIGIN, url: '/app/01A' } } });
        expect(win.assign).not.toHaveBeenCalled();
    });
});

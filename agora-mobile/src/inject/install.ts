import { createAgoraNative, type AgoraNative, type PushPlugin } from '../lib/bridge';
import type { HttpClient } from '../lib/http';
import type { DeviceInfoLike, NativePlatform } from '../lib/label';
import { normalizeOrigin } from '../lib/origin';
import { handleKey, type KeyValueStore } from '../lib/servers';
import { pushData, routeTapOnInstance, type TapAction } from '../lib/taps';

/** The window properties the injected script reads and writes. */
export interface InstanceWindow {
    location: { origin: string; href: string; assign(url: string): void };
    AgoraNative?: AgoraNative;
    /** The app's own local origin, set by Capacitor's injected globals. */
    WEBVIEW_SERVER_URL?: string;
}

export interface InstallDeps {
    platform: string;
    version: string;
    relayUrl: string;
    push: PushPlugin & {
        addListener(event: 'pushNotificationActionPerformed', cb: (action: TapAction) => void): Promise<unknown>;
    };
    http: HttpClient;
    kv: KeyValueStore;
    deviceInfo(): Promise<DeviceInfoLike>;
}

/**
 * Define window.AgoraNative and route notification taps, on an https instance page
 * inside the app only. Returns whether it installed.
 */
export function install(win: InstanceWindow, deps: InstallDeps): boolean {
    if (deps.platform !== 'android' && deps.platform !== 'ios') return false;
    const origin = win.location.origin;
    // Never on the bundled picker (https://localhost, capacitor://localhost), only on an https origin.
    if (normalizeOrigin(origin) !== origin) return false;
    if (win.AgoraNative) return false;

    const agoraNative = createAgoraNative({
        platform: deps.platform as NativePlatform,
        version: deps.version,
        relayUrl: deps.relayUrl,
        origin,
        push: deps.push,
        http: deps.http,
        kv: deps.kv,
        deviceInfo: deps.deviceInfo,
    });
    Object.defineProperty(win, 'AgoraNative', { value: agoraNative, writable: false, configurable: false, enumerable: true });

    void deps.push.addListener('pushNotificationActionPerformed', async (action) => {
        const localUrl = win.WEBVIEW_SERVER_URL;
        if (!localUrl) return;
        const hasHandle = Boolean((await deps.kv.get({ key: handleKey(origin) })).value);
        const target = routeTapOnInstance(pushData(action), { origin, hasHandle, href: win.location.href }, localUrl);
        if (target) win.location.assign(target);
    });
    return true;
}

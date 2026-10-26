import { createAgoraNative, type AgoraNative } from '../lib/bridge';
import type { DeviceInfoLike, NativePlatform } from '../lib/label';
import { normalizeOrigin } from '../lib/origin';
import type { AgoraShellPush } from '../lib/shell';
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
    /** AgoraShell's push methods (native, bound to this page's origin). */
    shell: AgoraShellPush;
    /** Only the tap listener: instance pages cannot register or see the device token. */
    push: {
        addListener(event: 'pushNotificationActionPerformed', cb: (action: TapAction) => void): Promise<unknown>;
    };
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
        shell: deps.shell,
        deviceInfo: deps.deviceInfo,
    });
    Object.defineProperty(win, 'AgoraNative', { value: agoraNative, writable: false, configurable: false, enumerable: true });

    void deps.push.addListener('pushNotificationActionPerformed', async (action) => {
        const localUrl = win.WEBVIEW_SERVER_URL;
        if (!localUrl) return;
        let hasHandle = false;
        try {
            hasHandle = (await deps.shell.hasPushHandle()).value === true;
        } catch {
            // Treated as no handle: the tap is ignored here.
        }
        const target = routeTapOnInstance(pushData(action), { origin, hasHandle, href: win.location.href }, localUrl);
        if (target) win.location.assign(target);
    });
    return true;
}

/**
 * Injected by the native shell into saved Agora instance pages only (Android:
 * a document-start script scoped to those origins; iOS: a main-frame user
 * script, refused by the bridge filter anywhere else). Defines
 * `window.AgoraNative` (docs/planning/mobile-apps.md section 8) and opens
 * tapped notifications.
 *
 * Push registration is native (AgoraShell.registerPush): this page never sees
 * the device token, cannot talk to the relay and cannot read Preferences.
 */
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { PushNotifications } from '@capacitor/push-notifications';
import { APP_VERSION, RELAY_URL } from '../config';
import { AgoraShell } from '../lib/shell';
import { install, type InstallDeps, type InstanceWindow } from './install';

try {
    install(window as unknown as InstanceWindow, {
        platform: Capacitor.getPlatform(),
        version: APP_VERSION,
        relayUrl: RELAY_URL,
        shell: {
            registerPush: () => AgoraShell.registerPush(),
            unregisterPush: (options) => AgoraShell.unregisterPush(options),
            hasPushHandle: () => AgoraShell.hasPushHandle(),
        },
        push: PushNotifications as unknown as InstallDeps['push'],
        deviceInfo: () => Device.getInfo(),
    });
} catch (err) {
    console.error('AgoraNative: not installed', err);
}

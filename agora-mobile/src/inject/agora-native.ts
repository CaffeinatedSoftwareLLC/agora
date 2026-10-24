/**
 * Injected by the native shell into saved Agora instance pages only (Android:
 * a document-start script scoped to those origins; iOS: a main-frame user
 * script, refused by the bridge filter anywhere else). Defines
 * `window.AgoraNative` (docs/planning/mobile-apps.md section 8) and opens
 * tapped notifications.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { APP_VERSION, RELAY_URL } from '../config';
import { install, type InstallDeps, type InstanceWindow } from './install';

try {
    install(window as unknown as InstanceWindow, {
        platform: Capacitor.getPlatform(),
        version: APP_VERSION,
        relayUrl: RELAY_URL,
        push: PushNotifications as unknown as InstallDeps['push'],
        http: { request: (o) => CapacitorHttp.request(o) },
        kv: Preferences,
        deviceInfo: () => Device.getInfo(),
    });
} catch (err) {
    console.error('AgoraNative: not installed', err);
}

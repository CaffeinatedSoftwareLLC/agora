import { deviceLabel, type DeviceInfoLike, type NativePlatform } from './label';
import type { HttpClient } from './http';
import { normalizeOrigin } from './origin';
import type { AgoraShellPush } from './shell';

/** `window.AgoraNative`, as fixed by docs/planning/mobile-apps.md section 8. */
export interface AgoraNative {
    platform: NativePlatform;
    version: string;
    registerPush(): Promise<PushRegistration | null>;
    unregisterPush(handle: string): Promise<void>;
}

export interface PushRegistration {
    relay: string;
    handle: string;
    platform: NativePlatform;
    label: string;
}

export interface BridgeDeps {
    platform: NativePlatform;
    version: string;
    /** The relay's base URL from app.config.json; native must answer with the same origin. */
    relayUrl: string;
    /**
     * AgoraShell's push methods. Registration happens in native code: the device token
     * and the instance origin sent to the relay never pass through this page.
     */
    shell: AgoraShellPush;
    deviceInfo(): Promise<DeviceInfoLike>;
}

/** 32 random bytes, base64url, no padding (section 8). */
export const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class BridgeError extends Error {}

export function relayOrigin(relayUrl: string): string {
    const origin = normalizeOrigin(relayUrl);
    if (!origin) throw new BridgeError('relay_url_invalid');
    return origin;
}

/**
 * `DELETE /v1/handles` on the relay, for the bundled picker when a server is removed
 * (instance pages cannot reach the relay). A 401 means the relay no longer knows the
 * handle, which is the goal.
 */
export async function deleteRelayHandle(http: HttpClient, relayUrl: string, handle: string): Promise<void> {
    if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) throw new BridgeError('handle_invalid');
    const res = await http.request({
        url: `${relayOrigin(relayUrl)}/v1/handles`,
        method: 'DELETE',
        headers: { Authorization: `Bearer ${handle}` },
        connectTimeout: 10_000,
        readTimeout: 10_000,
    });
    if (res.status !== 204 && res.status !== 401) throw new BridgeError(`relay_unregister_failed: ${res.status}`);
}

export function createAgoraNative(deps: BridgeDeps): AgoraNative {
    const relay = relayOrigin(deps.relayUrl);
    let inFlight: Promise<PushRegistration | null> | null = null;

    async function register(): Promise<PushRegistration | null> {
        // No arguments: native decides the token and the instance origin.
        const res = await deps.shell.registerPush();
        if (!res || res.registered !== true) return null;
        if (res.relay !== relay || res.platform !== deps.platform || typeof res.handle !== 'string' || !HANDLE_PATTERN.test(res.handle)) {
            throw new BridgeError('native_register_invalid');
        }
        let info: DeviceInfoLike = {};
        try {
            info = await deps.deviceInfo();
        } catch {
            // The label is cosmetic.
        }
        return { relay, handle: res.handle, platform: deps.platform, label: deviceLabel(info, deps.platform) };
    }

    return Object.freeze({
        platform: deps.platform,
        version: deps.version,
        registerPush(): Promise<PushRegistration | null> {
            // The UI calls this once per session; a double call shares one registration.
            if (!inFlight) inFlight = register().finally(() => { inFlight = null; });
            return inFlight;
        },
        async unregisterPush(handle: string): Promise<void> {
            if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) throw new BridgeError('handle_invalid');
            // Native deletes it only if it is this origin's handle. The device token itself
            // stays registered: other saved servers may use it.
            await deps.shell.unregisterPush({ handle });
        },
    });
}

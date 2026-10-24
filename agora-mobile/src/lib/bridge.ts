import { deviceLabel, type DeviceInfoLike, type NativePlatform } from './label';
import { jsonBody, type HttpClient } from './http';
import { handleKey, type KeyValueStore } from './servers';
import { normalizeOrigin } from './origin';

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

type PermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';

interface ListenerHandle {
    remove(): Promise<void>;
}

/** The subset of @capacitor/push-notifications the bridge uses. */
export interface PushPlugin {
    checkPermissions(): Promise<{ receive: PermissionState }>;
    requestPermissions(): Promise<{ receive: PermissionState }>;
    register(): Promise<void>;
    addListener(event: 'registration', cb: (token: { value: string }) => void): Promise<ListenerHandle>;
    addListener(event: 'registrationError', cb: (error: { error: string }) => void): Promise<ListenerHandle>;
}

export interface BridgeDeps {
    platform: NativePlatform;
    version: string;
    /** The relay's base URL from app.config.json. */
    relayUrl: string;
    /** The page's own origin: the instance the handle is registered for. */
    origin: string;
    push: PushPlugin;
    http: HttpClient;
    kv: KeyValueStore;
    deviceInfo(): Promise<DeviceInfoLike>;
    /** Milliseconds to wait for the FCM/APNs token. */
    tokenTimeoutMs?: number;
}

/** 32 random bytes, base64url, no padding (section 8). */
export const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class BridgeError extends Error {}

export function relayOrigin(relayUrl: string): string {
    const origin = normalizeOrigin(relayUrl);
    if (!origin) throw new BridgeError('relay_url_invalid');
    return origin;
}

/** Wait for the device token after `register()`. Listeners go on before the call so no event is missed. */
async function obtainToken(push: PushPlugin, timeoutMs: number): Promise<string> {
    let resolve!: (token: string) => void;
    let reject!: (error: Error) => void;
    const token = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => reject(new BridgeError('push_token_timeout')), timeoutMs);
    const handles = await Promise.all([
        push.addListener('registration', (t) => {
            if (t && typeof t.value === 'string' && t.value) resolve(t.value);
            else reject(new BridgeError('push_token_empty'));
        }),
        push.addListener('registrationError', (e) => reject(new BridgeError(`push_registration_failed: ${e?.error ?? 'unknown'}`))),
    ]);
    try {
        await push.register();
        return await token;
    } finally {
        clearTimeout(timer);
        await Promise.all(handles.map((h) => h.remove().catch(() => undefined)));
    }
}

/** `DELETE /v1/handles` on the relay. A 401 means the relay no longer knows the handle, which is the goal. */
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
    const instance = normalizeOrigin(deps.origin);
    let inFlight: Promise<PushRegistration | null> | null = null;

    async function register(): Promise<PushRegistration | null> {
        if (!instance || instance !== deps.origin) throw new BridgeError('instance_origin_invalid');

        let perm = await deps.push.checkPermissions();
        if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
            perm = await deps.push.requestPermissions();
        }
        if (perm.receive !== 'granted') return null;

        const token = await obtainToken(deps.push, deps.tokenTimeoutMs ?? 20_000);

        const res = await deps.http.request({
            url: `${relay}/v1/register`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: { platform: deps.platform, token, instance },
            connectTimeout: 10_000,
            readTimeout: 10_000,
        });
        const handle = jsonBody(res.data)?.handle;
        if (res.status !== 201 || typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) {
            throw new BridgeError(`relay_register_failed: ${res.status}`);
        }
        await deps.kv.set({ key: handleKey(instance), value: handle });

        let info: DeviceInfoLike = {};
        try {
            info = await deps.deviceInfo();
        } catch {
            // The label is cosmetic.
        }
        return { relay, handle, platform: deps.platform, label: deviceLabel(info, deps.platform) };
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
            if (!instance) throw new BridgeError('instance_origin_invalid');
            await deleteRelayHandle(deps.http, relay, handle);
            const stored = (await deps.kv.get({ key: handleKey(instance) })).value;
            if (stored === handle) await deps.kv.remove({ key: handleKey(instance) });
            // The device token itself stays registered: other saved servers may use it.
        },
    });
}

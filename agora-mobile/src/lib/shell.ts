import { registerPlugin } from '@capacitor/core';

/** What native registerPush answers. The device token is never part of it. */
export type NativeRegistration =
    | { registered: false }
    | { registered: true; relay: string; handle: string; platform: string };

/** The push methods of AgoraShell, the only ones an instance page may call. */
export interface AgoraShellPush {
    /**
     * Native code asks for notification permission, gets the FCM/APNs token itself and
     * registers it with the relay for the calling page's origin as the WebView reports
     * it, naming the handle stored for that origin as `previous`: the relay hands it back
     * while it still holds this token and origin, or issues a new one.
     * `registered: false` when permission is denied.
     */
    registerPush(): Promise<NativeRegistration>;
    /** Deletes the handle at the relay, only if it is the one stored for the calling origin. */
    unregisterPush(options: { handle: string }): Promise<void>;
    /** Whether this device has a push handle for the calling origin. */
    hasPushHandle(): Promise<{ value: boolean }>;
}

/**
 * The app's own native plugin (android/.../AgoraShellPlugin.java, ios/App/App/AgoraShellPlugin.swift).
 * getLaunchState and serversChanged are for the bundled picker only; the push methods
 * are for saved instance pages only (native refuses the picker, which has no instance origin).
 */
export interface AgoraShellPlugin extends AgoraShellPush {
    /** autoOpen is true once per app launch, unless the user asked for the server list. */
    getLaunchState(): Promise<{ autoOpen: boolean }>;
    /** Re-read the saved servers after a change, so the native allowlists follow. */
    serversChanged(): Promise<void>;
}

export const AgoraShell = registerPlugin<AgoraShellPlugin>('AgoraShell');

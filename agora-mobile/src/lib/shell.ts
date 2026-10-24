import { registerPlugin } from '@capacitor/core';

/**
 * The app's own native plugin (android/.../AgoraShellPlugin.java, ios/App/App/AgoraShellPlugin.swift).
 * Only the bundled picker page may call it; instance pages are refused natively.
 */
export interface AgoraShellPlugin {
    /** autoOpen is true once per app launch, unless the user asked for the server list. */
    getLaunchState(): Promise<{ autoOpen: boolean }>;
    /** Re-read the saved servers after a change, so the native allowlists follow. */
    serversChanged(): Promise<void>;
}

export const AgoraShell = registerPlugin<AgoraShellPlugin>('AgoraShell');

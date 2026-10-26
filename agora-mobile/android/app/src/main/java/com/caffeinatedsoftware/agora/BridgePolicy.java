package com.caffeinatedsoftware.agora;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * Which native calls a saved instance page may make. The bundled picker page may
 * call anything; an instance page only what window.AgoraNative needs
 * (src/inject/agora-native.ts). Push registration runs in native code
 * (AgoraShell.registerPush), so pages never see the device token and cannot
 * reach the relay or Preferences themselves.
 *
 * Keep REMOTE_CALLS and REMOTE_EVENTS identical to BridgePolicy in
 * AgoraShellPlugin.swift: test/consistency.test.ts compares the two lists.
 */
final class BridgePolicy {

    /** Prefix of the per-instance push handle key; see HANDLE_KEY_PREFIX in src/lib/servers.ts. */
    static final String HANDLE_KEY_PREFIX = "agora.push.";

    /** Every call an instance page may make, as "pluginId.methodName". */
    static final Set<String> REMOTE_CALLS = setOf(
        "AgoraShell.registerPush",
        "AgoraShell.unregisterPush",
        "AgoraShell.hasPushHandle",
        "PushNotifications.addListener",
        "PushNotifications.removeListener",
        "PushNotifications.removeAllListeners",
        "Device.getInfo",
        "Console.log"
    );

    /** The only events an instance page may listen for, as "pluginId.eventName". */
    static final Set<String> REMOTE_EVENTS = setOf(
        "PushNotifications.pushNotificationActionPerformed"
    );

    private BridgePolicy() {}

    /**
     * @param origin    the calling page's origin (a saved server)
     * @param eventName options.eventName, for addListener
     */
    static boolean allowRemote(String origin, String pluginId, String methodName, String eventName) {
        if (origin == null || pluginId == null || methodName == null) return false;
        if (pluginId.contains(".") || methodName.contains(".")) return false;
        if (!REMOTE_CALLS.contains(pluginId + "." + methodName)) return false;
        if (methodName.equals("addListener")) {
            return eventName != null && REMOTE_EVENTS.contains(pluginId + "." + eventName);
        }
        return true;
    }

    private static Set<String> setOf(String... values) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(values)));
    }
}

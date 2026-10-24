package com.caffeinatedsoftware.agora;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Which native calls a saved instance page may make. The bundled picker page may
 * call anything; an instance page only what window.AgoraNative needs
 * (src/inject/agora-native.ts). Keep in step with BridgePolicy.swift.
 */
final class BridgePolicy {

    /** Prefix of the per-instance push handle key; see HANDLE_KEY_PREFIX in src/lib/servers.ts. */
    static final String HANDLE_KEY_PREFIX = "agora.push.";

    private static final Set<String> PUSH_METHODS = new HashSet<>(
        Arrays.asList("checkPermissions", "requestPermissions", "register", "addListener", "removeListener", "removeAllListeners")
    );
    private static final Set<String> PUSH_EVENTS = new HashSet<>(
        Arrays.asList("registration", "registrationError", "pushNotificationActionPerformed")
    );
    private static final Set<String> PREFERENCE_METHODS = new HashSet<>(Arrays.asList("get", "set", "remove"));

    private BridgePolicy() {}

    /**
     * @param origin      the calling page's origin (a saved server)
     * @param relayOrigin the push relay origin from the AgoraShell config
     * @param eventName   options.eventName, for addListener
     * @param key         options.key, for Preferences
     * @param url         options.url, for CapacitorHttp
     */
    static boolean allowRemote(
        String origin,
        String relayOrigin,
        String pluginId,
        String methodName,
        String eventName,
        String key,
        String url
    ) {
        if (origin == null || pluginId == null || methodName == null) return false;
        switch (pluginId) {
            case "PushNotifications":
                if (!PUSH_METHODS.contains(methodName)) return false;
                return !methodName.equals("addListener") || PUSH_EVENTS.contains(eventName);
            case "Device":
                return methodName.equals("getInfo");
            case "Preferences":
                // Only this instance's own push handle.
                return PREFERENCE_METHODS.contains(methodName) && (HANDLE_KEY_PREFIX + origin).equals(key);
            case "CapacitorHttp":
                return methodName.equals("request") && isRelayUrl(url, relayOrigin);
            default:
                return false;
        }
    }

    /** True for an https URL on the relay origin whose path is under /v1/ with no dot segments. */
    static boolean isRelayUrl(String url, String relayOrigin) {
        if (url == null || relayOrigin == null) return false;
        String origin = Origins.httpsOrigin(url);
        if (origin == null || !origin.equals(relayOrigin)) return false;
        try {
            URI uri = new URI(url);
            String path = uri.getRawPath();
            if (path == null || !path.startsWith("/v1/")) return false;
            if (path.contains("/../") || path.contains("/./") || path.endsWith("/..") || path.contains("%2e") || path.contains("%2E")) return false;
            return uri.getRawFragment() == null;
        } catch (Exception e) {
            return false;
        }
    }
}

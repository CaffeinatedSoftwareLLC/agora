package com.caffeinatedsoftware.agora;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Set;
import org.junit.Test;

public class BridgePolicyTest {

    private static final String ORIGIN = "https://agora.example.com";

    private static boolean allow(String plugin, String method, String event) {
        return BridgePolicy.allowRemote(ORIGIN, plugin, method, event);
    }

    @Test
    public void pushRegistrationIsNativeOnly() {
        assertTrue(allow("AgoraShell", "registerPush", null));
        assertTrue(allow("AgoraShell", "unregisterPush", null));
        assertTrue(allow("AgoraShell", "hasPushHandle", null));
        // The page never gets the device token: no register, no token listeners.
        assertFalse(allow("PushNotifications", "register", null));
        assertFalse(allow("PushNotifications", "checkPermissions", null));
        assertFalse(allow("PushNotifications", "requestPermissions", null));
        assertFalse(allow("PushNotifications", "addListener", "registration"));
        assertFalse(allow("PushNotifications", "addListener", "registrationError"));
    }

    @Test
    public void tapsAreTheOnlyEvent() {
        assertTrue(allow("PushNotifications", "addListener", "pushNotificationActionPerformed"));
        assertTrue(allow("PushNotifications", "removeListener", null));
        assertTrue(allow("PushNotifications", "removeAllListeners", null));
        assertFalse(allow("PushNotifications", "addListener", "pushNotificationReceived"));
        assertFalse(allow("PushNotifications", "addListener", null));
        assertFalse(allow("Device", "addListener", "pushNotificationActionPerformed"));
    }

    @Test
    public void otherPushCallsAreRefused() {
        // Unregistering would kill the token every saved server shares.
        assertFalse(allow("PushNotifications", "unregister", null));
        assertFalse(allow("PushNotifications", "getDeliveredNotifications", null));
        assertFalse(allow("PushNotifications", "createChannel", null));
    }

    @Test
    public void noPreferencesOrNativeHttp() {
        assertFalse(allow("Preferences", "get", null));
        assertFalse(allow("Preferences", "set", null));
        assertFalse(allow("Preferences", "remove", null));
        assertFalse(allow("CapacitorHttp", "request", null));
    }

    @Test
    public void everythingElseIsRefused() {
        assertTrue(allow("Device", "getInfo", null));
        assertTrue(allow("Console", "log", null));
        assertFalse(allow("Device", "getId", null));
        assertFalse(allow("AgoraShell", "serversChanged", null));
        assertFalse(allow("AgoraShell", "getLaunchState", null));
        assertFalse(allow("AgoraShell", "requestPermissions", null));
        assertFalse(allow("CapacitorCookies", "setCookie", null));
        assertFalse(allow("WebView", "setServerBasePath", null));
        assertFalse(allow(null, "getInfo", null));
        assertFalse(BridgePolicy.allowRemote(null, "Device", "getInfo", null));
    }

    @Test
    public void namesCannotBeSplicedTogether() {
        assertFalse(allow("Device.getInfo", "", null));
        assertFalse(allow("AgoraShell.registerPush", "x", null));
        assertFalse(allow("AgoraShell", "registerPush.x", null));
    }

    @Test
    public void originsAreNormalised() {
        assertEquals("https://agora.example.com", Origins.httpsOrigin("https://Agora.Example.com:443/app/x?y=1"));
        assertEquals("https://agora.example.com:8443", Origins.httpsOrigin("https://agora.example.com:8443"));
        assertNull(Origins.httpsOrigin("http://agora.example.com"));
        assertNull(Origins.httpsOrigin("https://localhost"));
        assertNull(Origins.httpsOrigin("https://u:p@agora.example.com"));
        assertEquals("https://localhost", Origins.anyOrigin("https://localhost/index.html"));
        assertEquals("capacitor://localhost", Origins.anyOrigin("capacitor://localhost/"));
    }

    @Test
    public void savedListIgnoresBadEntries() {
        Set<String> saved = Origins.parseSaved(
            "[{\"origin\":\"https://a.example.com\",\"name\":\"A\"}," +
            "{\"origin\":\"http://b.example.com\"},{\"origin\":\"https://c.example.com/path\"},{},7]"
        );
        assertEquals(1, saved.size());
        assertTrue(saved.contains("https://a.example.com"));
        assertTrue(Origins.parseSaved("not json").isEmpty());
        assertTrue(Origins.parseSaved(null).isEmpty());
    }
}

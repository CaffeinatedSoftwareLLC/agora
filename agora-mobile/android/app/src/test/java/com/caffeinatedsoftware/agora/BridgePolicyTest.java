package com.caffeinatedsoftware.agora;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Set;
import org.junit.Test;

public class BridgePolicyTest {

    private static final String ORIGIN = "https://agora.example.com";
    private static final String RELAY = "https://push.agora.host";

    private static boolean allow(String plugin, String method, String event, String key, String url) {
        return BridgePolicy.allowRemote(ORIGIN, RELAY, plugin, method, event, key, url);
    }

    @Test
    public void pushRegistrationIsAllowed() {
        assertTrue(allow("PushNotifications", "checkPermissions", null, null, null));
        assertTrue(allow("PushNotifications", "requestPermissions", null, null, null));
        assertTrue(allow("PushNotifications", "register", null, null, null));
        assertTrue(allow("PushNotifications", "addListener", "registration", null, null));
        assertTrue(allow("PushNotifications", "addListener", "pushNotificationActionPerformed", null, null));
    }

    @Test
    public void otherPushCallsAreRefused() {
        // Unregistering would kill the token every saved server shares.
        assertFalse(allow("PushNotifications", "unregister", null, null, null));
        assertFalse(allow("PushNotifications", "addListener", "pushNotificationReceived", null, null));
        assertFalse(allow("PushNotifications", "getDeliveredNotifications", null, null, null));
        assertFalse(allow("PushNotifications", "createChannel", null, null, null));
    }

    @Test
    public void preferencesOnlyForOwnHandle() {
        assertTrue(allow("Preferences", "get", null, "agora.push." + ORIGIN, null));
        assertTrue(allow("Preferences", "set", null, "agora.push." + ORIGIN, null));
        assertFalse(allow("Preferences", "get", null, "agora.push.https://other.example.com", null));
        assertFalse(allow("Preferences", "set", null, "agora.servers", null));
        assertFalse(allow("Preferences", "keys", null, null, null));
        assertFalse(allow("Preferences", "configure", null, null, null));
        assertFalse(allow("Preferences", "clear", null, null, null));
    }

    @Test
    public void httpOnlyToTheRelay() {
        assertTrue(allow("CapacitorHttp", "request", null, null, RELAY + "/v1/register"));
        assertTrue(allow("CapacitorHttp", "request", null, null, RELAY + "/v1/handles"));
        assertFalse(allow("CapacitorHttp", "request", null, null, RELAY + "/v2/register"));
        assertFalse(allow("CapacitorHttp", "request", null, null, RELAY + "/v1/../admin"));
        assertFalse(allow("CapacitorHttp", "request", null, null, RELAY + "/v1/%2e%2e/admin"));
        assertFalse(allow("CapacitorHttp", "request", null, null, "http://push.agora.host/v1/register"));
        assertFalse(allow("CapacitorHttp", "request", null, null, "https://push.agora.host.evil.com/v1/register"));
        assertFalse(allow("CapacitorHttp", "request", null, null, "https://user@push.agora.host/v1/register"));
        assertFalse(allow("CapacitorHttp", "request", null, null, "http://192.168.1.1/"));
        assertFalse(allow("CapacitorHttp", "request", null, null, null));
    }

    @Test
    public void everythingElseIsRefused() {
        assertTrue(allow("Device", "getInfo", null, null, null));
        assertFalse(allow("Device", "getId", null, null, null));
        assertFalse(allow("AgoraShell", "serversChanged", null, null, null));
        assertFalse(allow("AgoraShell", "getLaunchState", null, null, null));
        assertFalse(allow("CapacitorCookies", "setCookie", null, null, null));
        assertFalse(allow("WebView", "setServerBasePath", null, null, null));
        assertFalse(allow(null, "getInfo", null, null, null));
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

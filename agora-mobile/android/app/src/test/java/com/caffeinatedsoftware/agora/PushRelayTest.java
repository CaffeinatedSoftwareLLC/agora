package com.caffeinatedsoftware.agora;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public class PushRelayTest {

    private static final String HANDLE = "AAAAAAAAAAAAAAAAAAAAA_bbbbbbbbbbbbbbbbbbbb-";
    private static final String OTHER = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

    @Test
    public void handlesAre43Base64UrlCharacters() {
        assertEquals(43, HANDLE.length());
        assertTrue(PushRelay.isHandle(HANDLE));
        assertFalse(PushRelay.isHandle(HANDLE + "x"));
        assertFalse(PushRelay.isHandle(OTHER.substring(1) + "="));
        assertFalse(PushRelay.isHandle("null"));
        assertFalse(PushRelay.isHandle(null));
    }

    @Test
    public void registerBodyCarriesTheGivenOrigin() throws Exception {
        JSONObject body = new JSONObject(PushRelay.registerBody("android", "tok", "https://a.example.com"));
        assertEquals("android", body.getString("platform"));
        assertEquals("tok", body.getString("token"));
        assertEquals("https://a.example.com", body.getString("instance"));
        assertEquals(3, body.length());
    }

    @Test
    public void onlyA201WithAValidHandleCounts() {
        assertEquals(HANDLE, PushRelay.handleFrom(new PushRelay.Response(201, "{\"handle\":\"" + HANDLE + "\"}")));
        assertNull(PushRelay.handleFrom(new PushRelay.Response(200, "{\"handle\":\"" + HANDLE + "\"}")));
        assertNull(PushRelay.handleFrom(new PushRelay.Response(201, "{\"handle\":\"short\"}")));
        assertNull(PushRelay.handleFrom(new PushRelay.Response(201, "{}")));
        assertNull(PushRelay.handleFrom(new PushRelay.Response(201, "not json")));
        assertNull(PushRelay.handleFrom(new PushRelay.Response(429, "{\"error\":\"rate_limited\"}")));
        assertNull(PushRelay.handleFrom(null));
    }

    @Test
    public void unregisterAcceptsGoneHandles() {
        assertTrue(PushRelay.unregistered(204));
        assertTrue(PushRelay.unregistered(401));
        assertFalse(PushRelay.unregistered(500));
        assertFalse(PushRelay.unregistered(200));
    }

    @Test
    public void secondRegistrationWithTheSameTokenReusesTheHandle() {
        String hash = PushRelay.sha256("device-token");
        assertTrue(PushRelay.canReuse(HANDLE, hash, hash));
        // The token changed: register again (and delete the old handle).
        assertFalse(PushRelay.canReuse(HANDLE, hash, PushRelay.sha256("new-token")));
        // Nothing stored, or a handle with no token record (stored by an older build).
        assertFalse(PushRelay.canReuse(null, null, hash));
        assertFalse(PushRelay.canReuse(HANDLE, null, hash));
        assertFalse(PushRelay.canReuse("bad", hash, hash));
    }

    @Test
    public void unregisterOnlyTheCallingOriginsHandle() {
        assertTrue(PushRelay.mayUnregister(HANDLE, HANDLE));
        assertFalse(PushRelay.mayUnregister(OTHER, HANDLE));
        assertFalse(PushRelay.mayUnregister(HANDLE, null));
        assertFalse(PushRelay.mayUnregister("short", "short"));
    }

    @Test
    public void tokenHashIsSha256Hex() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", PushRelay.sha256(""));
        assertEquals(64, PushRelay.sha256("device-token").length());
    }
}

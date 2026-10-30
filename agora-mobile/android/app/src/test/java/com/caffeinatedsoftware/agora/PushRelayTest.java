package com.caffeinatedsoftware.agora;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class PushRelayTest {

    /** Records each /v1/register body and answers with the queued response. */
    private static final class FakeRelay implements PushRelay.Transport {
        final List<JSONObject> registered = new ArrayList<>();
        PushRelay.Response next;

        @Override
        public PushRelay.Response send(String method, String path, String bearer, String jsonBody) {
            assertEquals("POST", method);
            assertEquals("/v1/register", path);
            assertNull(bearer);
            try {
                registered.add(new JSONObject(jsonBody));
            } catch (Exception e) {
                throw new AssertionError(e);
            }
            return next;
        }
    }

    private static PushRelay.Response answer(int status, String handle) {
        return new PushRelay.Response(status, "{\"handle\":\"" + handle + "\"}");
    }

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
        JSONObject body = new JSONObject(PushRelay.registerBody("android", "tok", "https://a.example.com", null));
        assertEquals("android", body.getString("platform"));
        assertEquals("tok", body.getString("token"));
        assertEquals("https://a.example.com", body.getString("instance"));
        assertEquals(3, body.length());
    }

    @Test
    public void registerBodyNamesOnlyAWellFormedPrevious() throws Exception {
        assertEquals(HANDLE, new JSONObject(PushRelay.registerBody("android", "tok", "https://a.example.com", HANDLE)).getString("previous"));
        assertFalse(new JSONObject(PushRelay.registerBody("android", "tok", "https://a.example.com", "short")).has("previous"));
    }

    @Test
    public void a201WithAValidHandleOrA200HandingBackPreviousCounts() {
        assertEquals(HANDLE, PushRelay.handleFrom(answer(201, HANDLE), null));
        assertEquals(OTHER, PushRelay.handleFrom(answer(201, OTHER), HANDLE));
        assertEquals(HANDLE, PushRelay.handleFrom(answer(200, HANDLE), HANDLE));
        // A 200 must hand back exactly the handle that was sent.
        assertNull(PushRelay.handleFrom(answer(200, HANDLE), null));
        assertNull(PushRelay.handleFrom(answer(200, OTHER), HANDLE));
        assertNull(PushRelay.handleFrom(answer(201, "short"), null));
        assertNull(PushRelay.handleFrom(new PushRelay.Response(201, "{}"), null));
        assertNull(PushRelay.handleFrom(new PushRelay.Response(201, "not json"), null));
        assertNull(PushRelay.handleFrom(new PushRelay.Response(429, "{\"error\":\"rate_limited\"}"), null));
        assertNull(PushRelay.handleFrom(null, null));
    }

    @Test
    public void firstRegistrationSendsNoPrevious() throws Exception {
        FakeRelay relay = new FakeRelay();
        relay.next = answer(201, HANDLE);
        assertEquals(HANDLE, PushRelay.register(relay, "android", "device-token", "https://a.example.com", null));
        assertFalse(relay.registered.get(0).has("previous"));
        assertFalse(PushRelay.replaces(null, HANDLE));
    }

    @Test
    public void unregisterAcceptsGoneHandles() {
        assertTrue(PushRelay.unregistered(204));
        assertTrue(PushRelay.unregistered(401));
        assertFalse(PushRelay.unregistered(500));
        assertFalse(PushRelay.unregistered(200));
    }

    @Test
    public void secondRegistrationWithTheSameTokenReusesTheHandle() throws Exception {
        // The relay is called with the stored handle as previous and hands it back (200).
        FakeRelay relay = new FakeRelay();
        relay.next = answer(200, HANDLE);
        String handle = PushRelay.register(relay, "android", "device-token", "https://a.example.com", HANDLE);
        assertEquals(HANDLE, handle);
        assertEquals(1, relay.registered.size());
        assertEquals(HANDLE, relay.registered.get(0).getString("previous"));
        assertEquals("device-token", relay.registered.get(0).getString("token"));
        assertFalse(PushRelay.replaces(HANDLE, handle));
    }

    @Test
    public void aCachedHandleTheRelayNoLongerKnowsIsReplaced() throws Exception {
        // Pruned, lost database or a new relay key: the relay answers previous with a new handle.
        FakeRelay relay = new FakeRelay();
        relay.next = answer(201, OTHER);
        String handle = PushRelay.register(relay, "android", "device-token", "https://a.example.com", HANDLE);
        assertEquals(OTHER, handle);
        assertEquals(HANDLE, relay.registered.get(0).getString("previous"));
        // The new handle is stored and the old one deleted (best effort, harmless if unknown).
        assertTrue(PushRelay.replaces(HANDLE, handle));
    }

    @Test
    public void aNewTokenGetsANewHandleAndTheOldOneIsDeleted() throws Exception {
        FakeRelay relay = new FakeRelay();
        relay.next = answer(201, OTHER);
        String handle = PushRelay.register(relay, "android", "new-token", "https://a.example.com", HANDLE);
        assertEquals("new-token", relay.registered.get(0).getString("token"));
        assertEquals(HANDLE, relay.registered.get(0).getString("previous"));
        assertTrue(PushRelay.replaces(HANDLE, handle));
    }

    @Test
    public void aRelayErrorKeepsNothing() {
        FakeRelay relay = new FakeRelay();
        relay.next = new PushRelay.Response(429, "{\"error\":\"rate_limited\"}");
        try {
            PushRelay.register(relay, "android", "device-token", "https://a.example.com", HANDLE);
            throw new AssertionError("expected RegisterFailed");
        } catch (PushRelay.RegisterFailed e) {
            assertEquals(429, e.status);
            assertEquals("relay_register_failed: 429", e.getMessage());
        } catch (Exception e) {
            throw new AssertionError(e);
        }
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

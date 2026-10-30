package com.caffeinatedsoftware.agora;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * The relay side of push registration (docs/planning/mobile-apps.md section 8).
 * Only native code talks to the relay: the device token never reaches page
 * JavaScript, and the instance origin sent with it is the one the WebView
 * reported for the calling page. Mirrors the push code in AgoraShellPlugin.swift.
 */
final class PushRelay {

    /** 32 random bytes, base64url, no padding. */
    private static final Pattern HANDLE = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private static final int TIMEOUT_MS = 10_000;

    private PushRelay() {}

    static final class Response {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    /** How register() reaches the relay: send() in the app, a fake in the JVM tests. */
    interface Transport {
        Response send(String method, String path, String bearer, String jsonBody) throws IOException;
    }

    /** /v1/register answered with something other than a usable handle. */
    static final class RegisterFailed extends Exception {
        final int status;

        RegisterFailed(int status) {
            super("relay_register_failed: " + status);
            this.status = status;
        }
    }

    static boolean isHandle(String value) {
        return value != null && HANDLE.matcher(value).matches();
    }

    /** `previous` (the handle stored for this origin) is sent only when it is a well-formed handle. */
    static String registerBody(String platform, String token, String instance, String previous) throws Exception {
        JSONObject body = new JSONObject();
        body.put("platform", platform);
        body.put("token", token);
        body.put("instance", instance);
        if (isHandle(previous)) body.put("previous", previous);
        return body.toString();
    }

    /**
     * The handle from a /v1/register answer: a 201 with a well-formed new handle, or a 200
     * handing back `previous` itself. Null for anything else.
     */
    static String handleFrom(Response res, String previous) {
        if (res == null || res.body == null || (res.status != 201 && res.status != 200)) return null;
        try {
            String handle = new JSONObject(res.body).optString("handle", null);
            if (!isHandle(handle)) return null;
            if (res.status == 200 && !handle.equals(previous)) return null;
            return handle;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * POST /v1/register, always, naming the stored handle as `previous`. The relay hands
     * `previous` back while it still holds this token and origin, and issues a new handle
     * when it does not (new token, or the relay pruned it, lost its database or changed
     * its key), so a dead handle is never kept.
     */
    static String register(Transport relay, String platform, String token, String instance, String previous) throws Exception {
        Response res = relay.send("POST", "/v1/register", null, registerBody(platform, token, instance, previous));
        String handle = handleFrom(res, isHandle(previous) ? previous : null);
        if (handle == null) throw new RegisterFailed(res == null ? 0 : res.status);
        return handle;
    }

    /**
     * Whether to delete `previous` at the relay after register() returned `handle`: whenever
     * they differ. With a new token the old handle points at a dead token; with the same
     * token the relay no longer knew it, and a DELETE of an unknown handle is a harmless 204.
     */
    static boolean replaces(String previous, String handle) {
        return isHandle(previous) && !previous.equals(handle);
    }

    /** DELETE /v1/handles: 204, or 401 when the relay no longer knows the handle (already gone). */
    static boolean unregistered(int status) {
        return status == 204 || status == 401;
    }

    /** unregisterPush only deletes the handle registered for the calling origin. */
    static boolean mayUnregister(String handle, String storedHandle) {
        return isHandle(handle) && handle.equals(storedHandle);
    }

    /** Lower-case hex SHA-256, so the token itself is never stored by the shell. */
    static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** One request to the relay. Blocking: call off the main thread. */
    static Response send(String relayOrigin, String method, String path, String bearer, String jsonBody) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(relayOrigin + path).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            if (bearer != null) conn.setRequestProperty("Authorization", "Bearer " + bearer);
            if (jsonBody != null) {
                byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(bytes);
                }
            }
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            return new Response(status, in == null ? "" : read(in));
        } finally {
            conn.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream stream = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int n;
            int total = 0;
            while ((n = stream.read(buffer)) != -1) {
                total += n;
                if (total > 64 * 1024) break;
                out.write(buffer, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}

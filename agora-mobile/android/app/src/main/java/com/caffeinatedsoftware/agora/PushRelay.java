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

    static boolean isHandle(String value) {
        return value != null && HANDLE.matcher(value).matches();
    }

    static String registerBody(String platform, String token, String instance) throws Exception {
        JSONObject body = new JSONObject();
        body.put("platform", platform);
        body.put("token", token);
        body.put("instance", instance);
        return body.toString();
    }

    /** The handle from a /v1/register answer, or null unless it is a 201 with a well-formed handle. */
    static String handleFrom(Response res) {
        if (res == null || res.status != 201 || res.body == null) return null;
        try {
            String handle = new JSONObject(res.body).optString("handle", null);
            return isHandle(handle) ? handle : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** DELETE /v1/handles: 204, or 401 when the relay no longer knows the handle (already gone). */
    static boolean unregistered(int status) {
        return status == 204 || status == 401;
    }

    /**
     * The relay issues a new handle on every /v1/register, and the instance keeps one
     * device row per handle. So registerPush reuses the handle stored for the calling
     * origin while the device token is unchanged, and registers again only when there
     * is no handle or the token changed.
     */
    static boolean canReuse(String storedHandle, String storedTokenHash, String tokenHash) {
        return isHandle(storedHandle) && storedTokenHash != null && storedTokenHash.equals(tokenHash);
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

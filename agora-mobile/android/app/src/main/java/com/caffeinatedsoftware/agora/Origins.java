package com.caffeinatedsoftware.agora;

import java.net.URI;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Origin helpers shared by the navigation lock, the bridge filter and the
 * microphone grant. Mirrors normalizeOrigin() in src/lib/origin.ts.
 */
final class Origins {

    private Origins() {}

    /** "https://host[:port]" for an https URL, or null. Default ports are dropped, the host is lower-cased. */
    static String httpsOrigin(String url) {
        if (url == null) return null;
        try {
            URI uri = new URI(url);
            if (!"https".equalsIgnoreCase(uri.getScheme())) return null;
            String host = uri.getHost();
            if (host == null || host.isEmpty() || uri.getRawUserInfo() != null) return null;
            host = host.toLowerCase(Locale.ROOT);
            if (host.equals("localhost")) return null;
            int port = uri.getPort();
            return "https://" + host + (port == -1 || port == 443 ? "" : ":" + port);
        } catch (Exception e) {
            return null;
        }
    }

    /** Scheme, host and port of any URL, for comparing against the app's own local origin. */
    static String anyOrigin(String url) {
        if (url == null) return null;
        try {
            URI uri = new URI(url);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            int port = uri.getPort();
            boolean defaultPort = port == -1 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
            return scheme + "://" + host.toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * The saved servers, from the JSON the picker writes with Capacitor Preferences
     * (key "agora.servers", see src/lib/servers.ts). Entries that are not exact
     * https origins are ignored.
     */
    static Set<String> parseSaved(String json) {
        Set<String> origins = new LinkedHashSet<>();
        if (json == null) return origins;
        try {
            JSONArray array = new JSONArray(json);
            for (int i = 0; i < array.length(); i++) {
                JSONObject entry = array.optJSONObject(i);
                if (entry == null) continue;
                String origin = entry.optString("origin", null);
                if (origin != null && origin.equals(httpsOrigin(origin))) origins.add(origin);
            }
        } catch (Exception e) {
            // A corrupt list means no saved servers, never "allow everything".
        }
        return origins;
    }
}

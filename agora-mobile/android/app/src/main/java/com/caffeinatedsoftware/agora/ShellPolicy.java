package com.caffeinatedsoftware.agora;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The shell's decisions that don't need a WebView: where a URL loads and whether the
 * instance bridge can be scoped. Plain Java, so the
 * JVM unit tests cover them.
 */
final class ShellPolicy {

    /** Where AgoraShell.shouldOverrideLoad sends a URL. */
    enum Load {
        /** Load in the WebView. */
        WEBVIEW,
        /** A saved server, but the bridge could not be scoped: never load it in the WebView. */
        REFUSE,
        /** Hand to the system (browser, mail, phone app). */
        SYSTEM,
    }

    private static final Pattern SCHEME = Pattern.compile("^([A-Za-z][A-Za-z0-9+.-]*):");

    private ShellPolicy() {}

    /**
     * Instance pages may load only when the bridge is scoped to the saved origins and
     * the main frame, which needs both WebView features and an installed listener.
     * Otherwise Capacitor's fallback is an unfiltered JavaScript interface.
     */
    static boolean canScopeBridge(boolean webMessageListener, boolean documentStartScript) {
        return webMessageListener && documentStartScript;
    }

    /**
     * @param url           the URL being loaded in the main frame
     * @param localOrigin   the bundled picker's origin
     * @param saved         the saved server origins
     * @param remoteAllowed whether the scoped bridge is installed (see {@link #canScopeBridge})
     */
    static Load decideLoad(String url, String localOrigin, Set<String> saved, boolean remoteAllowed) {
        if (url == null) return Load.SYSTEM;
        String scheme = scheme(url);
        // In-page content (srcdoc frames, downloads); top-level data: navigation is blocked by the WebView itself.
        if (scheme.equals("data") || scheme.equals("blob") || scheme.equals("about")) return Load.WEBVIEW;
        if (localOrigin != null && localOrigin.equals(Origins.anyOrigin(url))) return Load.WEBVIEW;
        String origin = Origins.httpsOrigin(url);
        if (origin != null && saved != null && saved.contains(origin)) return remoteAllowed ? Load.WEBVIEW : Load.REFUSE;
        return Load.SYSTEM;
    }

    static String scheme(String url) {
        Matcher m = SCHEME.matcher(url);
        return m.find() ? m.group(1).toLowerCase(Locale.ROOT) : "";
    }
}

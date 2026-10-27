package com.caffeinatedsoftware.agora;

import android.webkit.PermissionRequest;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The shell's decisions that don't need a WebView: where a URL loads, whether the
 * instance bridge can be scoped, and who gets the microphone. Plain Java, so the
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

    /** What AgoraShell does when a page finishes loading while the saved servers wait to be re-scoped. */
    enum Rescope {
        /** Nothing is waiting. */
        NONE,
        /** The blank page is up and no document holds an androidBridge object: re-register now. */
        NOW,
        /** Another page loaded first (it may hold the object): go to the blank page again. */
        BLANK_FIRST,
    }

    /** What MainActivity does on Back. */
    enum Back {
        /** Go back in the WebView history. */
        GO_BACK,
        /** Load the server list. */
        PICKER,
        /** Let the system handle it: leave the app. */
        LEAVE,
    }

    /**
     * Loaded with loadUrl from native code, so shouldOverrideLoad never sees it. It has an
     * opaque origin, which no listener rule matches: it never gets an androidBridge object.
     */
    static final String BLANK = "about:blank";

    private static final Pattern SCHEME = Pattern.compile("^([A-Za-z][A-Za-z0-9+.-]*):");

    private ShellPolicy() {}

    /**
     * Removing and re-adding the androidBridge listener while a document holds the
     * injected object crashes the WebView (SIGSEGV in its native code) the next time that
     * document posts a message. So the listener changes only while the blank page is shown.
     *
     * @param pending   whether the saved servers changed since the listener was registered
     * @param loadedUrl the URL of the page that just finished loading
     */
    static Rescope rescope(boolean pending, String loadedUrl) {
        if (!pending) return Rescope.NONE;
        return BLANK.equals(loadedUrl) ? Rescope.NOW : Rescope.BLANK_FIRST;
    }

    /**
     * After a re-scope the blank page and the reloaded picker are both history entries
     * (loadUrl), so Back could land on the blank page. When the picker reload that ends a
     * re-scope finishes, the history is cleared so it starts at the picker.
     *
     * @param pickerReloadPending whether a re-scope just loaded the picker again
     * @param loadedUrl           the URL of the page that just finished loading
     * @param localOrigin         the bundled picker's origin
     */
    static boolean clearHistoryAfterRescope(boolean pickerReloadPending, String loadedUrl, String localOrigin) {
        return pickerReloadPending && localOrigin != null && localOrigin.equals(Origins.anyOrigin(loadedUrl));
    }

    /**
     * Back walks the WebView history, except onto a blank page left by a re-scope, which
     * counts as no history: from a server that opens the server list. Back on the server
     * list leaves the app.
     *
     * @param onPicker    whether the page shown is the bundled picker
     * @param canGoBack   WebView.canGoBack()
     * @param previousUrl the URL of the previous history entry, or null
     */
    static Back back(boolean onPicker, boolean canGoBack, String previousUrl) {
        if (onPicker) return Back.LEAVE;
        if (canGoBack && !isBlankPage(previousUrl)) return Back.GO_BACK;
        return Back.PICKER;
    }

    /** about:blank (with or without a fragment or query) and any other about: page. */
    static boolean isBlankPage(String url) {
        return url != null && scheme(url).equals("about");
    }

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

    /**
     * The microphone, never the camera, and only when the requesting origin is the
     * origin of the top-level page and that is a saved server. Android does not say
     * which frame asked, so a same-origin iframe of that page also qualifies; a
     * sandboxed or cross-origin frame does not.
     */
    static boolean grantMicrophone(String requestOrigin, String topLevelUrl, String[] resources, Set<String> saved) {
        if (resources == null || resources.length == 0 || saved == null) return false;
        for (String resource : resources) {
            if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return false;
        }
        String origin = Origins.httpsOrigin(requestOrigin);
        return origin != null && origin.equals(Origins.httpsOrigin(topLevelUrl)) && saved.contains(origin);
    }

    static String scheme(String url) {
        Matcher m = SCHEME.matcher(url);
        return m.find() ? m.group(1).toLowerCase(Locale.ROOT) : "";
    }
}

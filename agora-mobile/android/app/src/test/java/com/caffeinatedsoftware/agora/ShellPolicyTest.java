package com.caffeinatedsoftware.agora;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.webkit.PermissionRequest;
import java.util.Collections;
import java.util.Set;
import org.junit.Test;

public class ShellPolicyTest {

    private static final String LOCAL = "https://localhost";
    private static final String SERVER = "https://agora.example.com";
    private static final Set<String> SAVED = Collections.singleton(SERVER);
    private static final String MIC = PermissionRequest.RESOURCE_AUDIO_CAPTURE;
    private static final String CAMERA = PermissionRequest.RESOURCE_VIDEO_CAPTURE;

    @Test
    public void bridgeIsScopedOnlyWithBothFeatures() {
        assertTrue(ShellPolicy.canScopeBridge(true, true));
        assertFalse(ShellPolicy.canScopeBridge(false, true));
        assertFalse(ShellPolicy.canScopeBridge(true, false));
        assertFalse(ShellPolicy.canScopeBridge(false, false));
    }

    @Test
    public void savedServersLoadWhenTheBridgeIsScoped() {
        assertEquals(ShellPolicy.Load.WEBVIEW, ShellPolicy.decideLoad(SERVER + "/app/01A", LOCAL, SAVED, true));
        assertEquals(ShellPolicy.Load.WEBVIEW, ShellPolicy.decideLoad(LOCAL + "/index.html", LOCAL, SAVED, true));
        assertEquals(ShellPolicy.Load.SYSTEM, ShellPolicy.decideLoad("https://evil.example.com/", LOCAL, SAVED, true));
    }

    @Test
    public void failsClosedWithoutTheScopedBridge() {
        // An old WebView: saved servers never load in the WebView, the picker still does.
        assertEquals(ShellPolicy.Load.REFUSE, ShellPolicy.decideLoad(SERVER + "/", LOCAL, SAVED, false));
        assertEquals(ShellPolicy.Load.REFUSE, ShellPolicy.decideLoad("https://AGORA.example.com:443/app", LOCAL, SAVED, false));
        assertEquals(ShellPolicy.Load.WEBVIEW, ShellPolicy.decideLoad(LOCAL + "/", LOCAL, SAVED, false));
        assertEquals(ShellPolicy.Load.WEBVIEW, ShellPolicy.decideLoad(LOCAL + "/#open=x", LOCAL, SAVED, false));
        assertEquals(ShellPolicy.Load.SYSTEM, ShellPolicy.decideLoad("https://other.example.com/", LOCAL, SAVED, false));
        assertEquals(ShellPolicy.Load.SYSTEM, ShellPolicy.decideLoad("mailto:a@example.com", LOCAL, SAVED, false));
    }

    @Test
    public void otherSchemesGoToTheSystem() {
        assertEquals(ShellPolicy.Load.SYSTEM, ShellPolicy.decideLoad("tel:+15555550100", LOCAL, SAVED, true));
        assertEquals(ShellPolicy.Load.SYSTEM, ShellPolicy.decideLoad("intent://x#Intent;end", LOCAL, SAVED, true));
        assertEquals(ShellPolicy.Load.SYSTEM, ShellPolicy.decideLoad("http://agora.example.com/", LOCAL, SAVED, true));
        assertEquals(ShellPolicy.Load.WEBVIEW, ShellPolicy.decideLoad("about:blank", LOCAL, SAVED, false));
        assertEquals(ShellPolicy.Load.WEBVIEW, ShellPolicy.decideLoad("blob:https://agora.example.com/x", LOCAL, SAVED, true));
        assertEquals(ShellPolicy.Load.SYSTEM, ShellPolicy.decideLoad(null, LOCAL, SAVED, true));
    }

    @Test
    public void rescopesOnlyOnTheBlankPage() {
        assertEquals(ShellPolicy.Rescope.NONE, ShellPolicy.rescope(false, ShellPolicy.BLANK));
        assertEquals(ShellPolicy.Rescope.NONE, ShellPolicy.rescope(false, LOCAL + "/"));
        assertEquals(ShellPolicy.Rescope.NOW, ShellPolicy.rescope(true, "about:blank"));
        // Any page that may hold an androidBridge object: the picker, a saved server, or unknown.
        assertEquals(ShellPolicy.Rescope.BLANK_FIRST, ShellPolicy.rescope(true, LOCAL + "/"));
        assertEquals(ShellPolicy.Rescope.BLANK_FIRST, ShellPolicy.rescope(true, SERVER + "/app/01A"));
        assertEquals(ShellPolicy.Rescope.BLANK_FIRST, ShellPolicy.rescope(true, "about:blank#x"));
        assertEquals(ShellPolicy.Rescope.BLANK_FIRST, ShellPolicy.rescope(true, null));
    }

    @Test
    public void clearsHistoryOnlyWhenThePickerReloadAfterARescopeLoads() {
        assertTrue(ShellPolicy.clearHistoryAfterRescope(true, LOCAL + "/", LOCAL));
        assertTrue(ShellPolicy.clearHistoryAfterRescope(true, LOCAL + "/index.html#x", LOCAL));
        assertFalse(ShellPolicy.clearHistoryAfterRescope(false, LOCAL + "/", LOCAL));
        assertFalse(ShellPolicy.clearHistoryAfterRescope(true, ShellPolicy.BLANK, LOCAL));
        assertFalse(ShellPolicy.clearHistoryAfterRescope(true, SERVER + "/", LOCAL));
        assertFalse(ShellPolicy.clearHistoryAfterRescope(true, null, LOCAL));
        assertFalse(ShellPolicy.clearHistoryAfterRescope(true, LOCAL + "/", null));
    }

    @Test
    public void backNeverLandsOnTheBlankPage() {
        // A server page with real history goes back.
        assertEquals(ShellPolicy.Back.GO_BACK, ShellPolicy.back(false, true, SERVER + "/app/01A"));
        assertEquals(ShellPolicy.Back.GO_BACK, ShellPolicy.back(false, true, LOCAL + "/"));
        // The previous entry is the blank page a re-scope left: treat it as no history.
        assertEquals(ShellPolicy.Back.PICKER, ShellPolicy.back(false, true, ShellPolicy.BLANK));
        assertEquals(ShellPolicy.Back.PICKER, ShellPolicy.back(false, true, "about:blank#x"));
        assertEquals(ShellPolicy.Back.PICKER, ShellPolicy.back(false, false, null));
        // On the server list, Back leaves the app, whatever the history holds.
        assertEquals(ShellPolicy.Back.LEAVE, ShellPolicy.back(true, true, ShellPolicy.BLANK));
        assertEquals(ShellPolicy.Back.LEAVE, ShellPolicy.back(true, true, SERVER + "/"));
        assertEquals(ShellPolicy.Back.LEAVE, ShellPolicy.back(true, false, null));
    }

    @Test
    public void blankPages() {
        assertTrue(ShellPolicy.isBlankPage("about:blank"));
        assertTrue(ShellPolicy.isBlankPage("ABOUT:blank#x"));
        assertFalse(ShellPolicy.isBlankPage(null));
        assertFalse(ShellPolicy.isBlankPage(LOCAL + "/"));
        assertFalse(ShellPolicy.isBlankPage("https://about.example.com/"));
    }

    @Test
    public void microphoneOnlyForTheSavedServerShown() {
        String[] mic = { MIC };
        assertTrue(ShellPolicy.grantMicrophone(SERVER + "/", SERVER + "/app/01A", mic, SAVED));
        // Another origin than the top-level page (a cross-origin frame, or a stale request).
        assertFalse(ShellPolicy.grantMicrophone("https://embed.example.com/", SERVER + "/app/01A", mic, SAVED));
        assertFalse(ShellPolicy.grantMicrophone(SERVER + "/", "https://localhost/", mic, SAVED));
        // Not a saved server, even as the top-level page.
        assertFalse(ShellPolicy.grantMicrophone("https://other.example.com/", "https://other.example.com/", mic, SAVED));
        // Opaque origins (sandboxed frames), unknown origins.
        assertFalse(ShellPolicy.grantMicrophone("null", SERVER + "/", mic, SAVED));
        assertFalse(ShellPolicy.grantMicrophone(null, SERVER + "/", mic, SAVED));
        assertFalse(ShellPolicy.grantMicrophone(SERVER + "/", null, mic, SAVED));
    }

    @Test
    public void neverTheCamera() {
        assertFalse(ShellPolicy.grantMicrophone(SERVER + "/", SERVER + "/", new String[] { CAMERA }, SAVED));
        assertFalse(ShellPolicy.grantMicrophone(SERVER + "/", SERVER + "/", new String[] { MIC, CAMERA }, SAVED));
        assertFalse(ShellPolicy.grantMicrophone(SERVER + "/", SERVER + "/", new String[0], SAVED));
        assertFalse(ShellPolicy.grantMicrophone(SERVER + "/", SERVER + "/", null, SAVED));
    }
}

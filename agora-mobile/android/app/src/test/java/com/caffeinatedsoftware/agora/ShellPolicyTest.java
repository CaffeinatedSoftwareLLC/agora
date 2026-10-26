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

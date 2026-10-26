package com.caffeinatedsoftware.agora;

import android.webkit.PermissionRequest;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.Logger;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Capacitor's chrome client grants camera and microphone to any page once the
 * Android permission is given. Agora only needs the microphone (push-to-talk),
 * and only for the saved server shown in the WebView (ShellPolicy.grantMicrophone).
 */
class AgoraChromeClient extends BridgeWebChromeClient {

    private final Bridge bridge;
    private final Supplier<Set<String>> savedOrigins;

    AgoraChromeClient(Bridge bridge, Supplier<Set<String>> savedOrigins) {
        super(bridge);
        this.bridge = bridge;
        this.savedOrigins = savedOrigins;
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        String requestOrigin = request.getOrigin() == null ? null : request.getOrigin().toString();
        // Called on the main thread, so the WebView's current URL is safe to read.
        String topLevelUrl = bridge.getWebView().getUrl();
        if (ShellPolicy.grantMicrophone(requestOrigin, topLevelUrl, request.getResources(), savedOrigins.get())) {
            // Asks for RECORD_AUDIO if needed, then grants.
            super.onPermissionRequest(request);
            return;
        }
        Logger.warn("AgoraShell", "Denied WebView permission request from " + requestOrigin);
        request.deny();
    }
}

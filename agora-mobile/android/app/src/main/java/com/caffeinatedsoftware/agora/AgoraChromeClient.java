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
 * and only for saved servers.
 */
class AgoraChromeClient extends BridgeWebChromeClient {

    private final Supplier<Set<String>> savedOrigins;

    AgoraChromeClient(Bridge bridge, Supplier<Set<String>> savedOrigins) {
        super(bridge);
        this.savedOrigins = savedOrigins;
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        String origin = request.getOrigin() == null ? null : Origins.httpsOrigin(request.getOrigin().toString());
        boolean audioOnly = true;
        for (String resource : request.getResources()) {
            if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audioOnly = false;
        }
        if (origin != null && audioOnly && savedOrigins.get().contains(origin)) {
            // Asks for RECORD_AUDIO if needed, then grants.
            super.onPermissionRequest(request);
            return;
        }
        Logger.warn("AgoraShell", "Denied WebView permission request from " + request.getOrigin());
        request.deny();
    }
}

package com.caffeinatedsoftware.agora;

import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Logger;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Capacitor's WebViewClient, unchanged (local assets, navigation through
 * AgoraShell.shouldOverrideLoad), plus one thing: when a saved server's page can't be
 * reached, the picker says so instead of the WebView's raw error page.
 */
final class AgoraWebViewClient extends BridgeWebViewClient {

    private static final String TAG = "AgoraShell";

    private final Bridge bridge;
    private final Supplier<Set<String>> savedOrigins;

    AgoraWebViewClient(Bridge bridge, Supplier<Set<String>> savedOrigins) {
        super(bridge);
        this.bridge = bridge;
        this.savedOrigins = savedOrigins;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        super.onReceivedError(view, request, error);
        String origin = ShellPolicy.unreachableServer(
            request.isForMainFrame(),
            error.getErrorCode(),
            request.getUrl() == null ? null : request.getUrl().toString(),
            savedOrigins.get()
        );
        if (origin == null) return;
        Logger.warn(TAG, "Could not reach " + origin + ": " + error.getErrorCode() + " " + error.getDescription());
        view.loadUrl(ShellPolicy.unreachablePickerUrl(bridge.getAppUrl(), origin));
    }
}

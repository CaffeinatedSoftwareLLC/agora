package com.caffeinatedsoftware.agora;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AgoraShellPlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge == null) return;

        // The bridge exists and the start page is only queued: lock the bridge down before any page runs.
        PluginHandle handle = bridge.getPlugin("AgoraShell");
        if (handle != null) ((AgoraShellPlugin) handle.getInstance()).attach();

        // Back walks the WebView history; Back from a server's first page opens the server list,
        // and Back on the server list leaves the app. (Capacitor only handles Back through
        // @capacitor/app, which the shell doesn't need. The picker's own history entry can't be
        // relied on: Chromium skips entries that navigated away without a user gesture.)
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge.getWebView();
                String local = Origins.anyOrigin(bridge.getAppUrl());
                boolean onPicker = local != null && local.equals(Origins.anyOrigin(webView.getUrl()));
                if (!onPicker && webView.canGoBack()) {
                    webView.goBack();
                } else if (!onPicker) {
                    webView.loadUrl(bridge.getAppUrl());
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        });
    }
}

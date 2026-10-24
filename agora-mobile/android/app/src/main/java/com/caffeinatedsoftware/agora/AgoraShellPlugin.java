package com.caffeinatedsoftware.agora;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.webkit.WebView;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSExport;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.MessageHandler;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/**
 * The shell around the user's Agora instances:
 *  - navigation lock: only saved servers (and the bundled picker) load in the WebView;
 *  - the Capacitor bridge and window.AgoraNative on saved servers only, main frame only,
 *    with instance pages limited to BridgePolicy;
 *  - microphone for saved servers only (AgoraChromeClient);
 *  - the "agora" notification channel and the "Switch server" shortcut.
 */
@CapacitorPlugin(name = "AgoraShell")
public class AgoraShellPlugin extends Plugin {

    static final String ACTION_SWITCH_SERVER = "com.caffeinatedsoftware.agora.SWITCH_SERVER";
    static final String NOTIFICATION_CHANNEL_ID = "agora";
    private static final String TAG = "AgoraShell";
    /** Capacitor Preferences' default group and the picker's key; see src/lib/servers.ts. */
    private static final String PREFERENCES_GROUP = "CapacitorStorage";
    private static final String SERVERS_KEY = "agora.servers";
    private static final String BRIDGE_NAME = "androidBridge";
    /** Plugins whose JS proxies instance pages get. BridgePolicy decides what they may call. */
    private static final String[] REMOTE_PLUGIN_IDS = { "PushNotifications", "Device", "Preferences", "CapacitorHttp" };

    private volatile Set<String> savedOrigins = Collections.emptySet();
    private String localOrigin;
    private String relayOrigin;
    private MessageHandler messageHandler;
    private ScriptHandler instanceScript;
    private String instanceScriptSource;
    private boolean autoOpenUsed = false;

    @Override
    public void load() {
        relayOrigin = Origins.httpsOrigin(getConfig().getString("relayUrl", ""));
        if (relayOrigin == null) Logger.error(TAG, "plugins.AgoraShell.relayUrl is not an https URL; push registration will fail", null);
        createNotificationChannel();
        publishSwitchShortcut();
    }

    /**
     * Called by MainActivity once the bridge and WebView exist and before the first
     * page runs, so no message has used Capacitor's own listener yet.
     */
    void attach() {
        Bridge bridge = getBridge();
        localOrigin = Origins.anyOrigin(bridge.getAppUrl());
        savedOrigins = readSavedOrigins();
        bridge.getWebView().setWebChromeClient(new AgoraChromeClient(bridge, () -> savedOrigins));
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // Capacitor falls back to a JavaScript interface here; instance pages get no bridge.
            Logger.error(TAG, "This Android System WebView is too old for the instance bridge. Update it from the Play Store.", null);
            return;
        }
        exposeBridge();
    }

    // ── Navigation lock ──────────────────────────────────────────────

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase();
        // In-page content (srcdoc frames, downloads); top-level data: navigation is blocked by the WebView itself.
        if (scheme.equals("data") || scheme.equals("blob") || scheme.equals("about")) return false;
        String raw = url.toString();
        if (localOrigin != null && localOrigin.equals(Origins.anyOrigin(raw))) return false;
        String origin = Origins.httpsOrigin(raw);
        if (origin != null && savedOrigins.contains(origin)) return false;
        // Everything else (other sites, mailto:, tel:, intent:) goes to the system.
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, url);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Logger.warn(TAG, "No app to open " + scheme + " link");
        }
        return true;
    }

    // ── Plugin methods (picker only, see onBridgeMessage) ────────────

    @PluginMethod
    public void getLaunchState(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (this) {
            result.put("autoOpen", !autoOpenUsed);
            autoOpenUsed = true;
        }
        call.resolve(result);
    }

    @PluginMethod
    public void serversChanged(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            savedOrigins = readSavedOrigins();
            if (messageHandler != null) exposeBridge();
            call.resolve();
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent != null && ACTION_SWITCH_SERVER.equals(intent.getAction())) {
            synchronized (this) {
                autoOpenUsed = true;
            }
            getBridge().executeOnMainThread(() -> getBridge().getWebView().loadUrl(getBridge().getAppUrl()));
        }
    }

    // ── Bridge exposure ──────────────────────────────────────────────

    /** (Re)register the bridge listener and the instance script for the current saved servers. Main thread. */
    private void exposeBridge() {
        WebView webView = getBridge().getWebView();
        try {
            WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME);
            if (messageHandler == null) {
                // Its constructor registers an unfiltered listener under the same name; replace it.
                messageHandler = new MessageHandler(getBridge(), webView, null);
                WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME);
            }
            Set<String> rules = new HashSet<>(savedOrigins);
            rules.add(localOrigin);
            WebViewCompat.addWebMessageListener(webView, BRIDGE_NAME, rules, this::onBridgeMessage);
        } catch (Exception e) {
            Logger.error(TAG, "Could not install the bridge listener", e);
        }

        if (instanceScript != null) {
            instanceScript.remove();
            instanceScript = null;
        }
        if (savedOrigins.isEmpty()) return;
        try {
            if (instanceScriptSource == null) instanceScriptSource = buildInstanceScript();
            instanceScript = WebViewCompat.addDocumentStartJavaScript(webView, instanceScriptSource, new HashSet<>(savedOrigins));
        } catch (Exception e) {
            Logger.error(TAG, "Could not install the instance script", e);
        }
    }

    private void onBridgeMessage(
        WebView view,
        androidx.webkit.WebMessageCompat message,
        Uri sourceOrigin,
        boolean isMainFrame,
        androidx.webkit.JavaScriptReplyProxy replyProxy
    ) {
        String data = message.getData();
        if (!isMainFrame || data == null) return;
        String origin = Origins.anyOrigin(sourceOrigin.toString());
        if (origin != null && origin.equals(localOrigin)) {
            messageHandler.postMessage(data);
            return;
        }
        if (origin == null || !savedOrigins.contains(origin)) return;
        try {
            JSONObject msg = new JSONObject(data);
            String type = msg.optString("type", "");
            if (type.equals("js.error")) {
                messageHandler.postMessage(data);
                return;
            }
            if (!type.isEmpty() && !type.equals("message")) return;
            String pluginId = msg.optString("pluginId", null);
            String methodName = msg.optString("methodName", null);
            JSONObject options = msg.optJSONObject("options");
            String eventName = options == null ? null : options.optString("eventName", null);
            String key = options == null ? null : options.optString("key", null);
            String url = options == null ? null : options.optString("url", null);
            String refusal = null;
            if (!BridgePolicy.allowRemote(origin, relayOrigin, pluginId, methodName, eventName, key, url)) {
                refusal = "Not available to this page";
            } else if ("PushNotifications".equals(pluginId) && "register".equals(methodName) && !firebaseConfigured()) {
                // Without google-services.json the push plugin throws on a background thread and the app crashes.
                refusal = "Push notifications are not configured in this build";
            }
            if (refusal == null) {
                messageHandler.postMessage(data);
            } else {
                Logger.warn(TAG, "Refused " + pluginId + "." + methodName + " from " + origin + ": " + refusal);
                String callbackId = msg.optString("callbackId", null);
                if (callbackId != null && pluginId != null && methodName != null) {
                    new PluginCall(messageHandler, pluginId, callbackId, methodName, new JSObject()).reject(refusal);
                }
            }
        } catch (Exception e) {
            Logger.warn(TAG, "Dropped a malformed bridge message from " + origin);
        }
    }

    /** Capacitor's runtime (as it injects into its own origin), then agora-native.js. */
    private String buildInstanceScript() throws Exception {
        Context context = getContext();
        Bridge bridge = getBridge();
        List<PluginHandle> handles = new ArrayList<>();
        for (String id : REMOTE_PLUGIN_IDS) {
            PluginHandle handle = bridge.getPlugin(id);
            if (handle != null) handles.add(handle);
        }
        // Same pieces and order as Capacitor's JSInjector.getScriptString() (package-private), without Cordova.
        return String.join(
            "\n\n",
            JSExport.getGlobalJS(context, bridge.getConfig().isLoggingEnabled(), bridge.isDevMode()),
            "window.WEBVIEW_SERVER_URL = '" + bridge.getLocalUrl() + "';",
            JSExport.getBridgeJS(context),
            JSExport.getPluginJS(handles),
            readAsset("public/agora-native.js")
        );
    }

    private String readAsset(String path) throws Exception {
        try (InputStream in = getContext().getAssets().open(path); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    /** The google-services Gradle plugin writes google_app_id from android/app/google-services.json. */
    private boolean firebaseConfigured() {
        Context context = getContext();
        return context.getResources().getIdentifier("google_app_id", "string", context.getPackageName()) != 0;
    }

    private Set<String> readSavedOrigins() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFERENCES_GROUP, Context.MODE_PRIVATE);
        return Collections.unmodifiableSet(Origins.parseSaved(prefs.getString(SERVERS_KEY, null)));
    }

    // ── Notifications and shortcuts ──────────────────────────────────

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(NOTIFICATION_CHANNEL_ID, "Agora", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Approvals, mentions and agents that need you");
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void publishSwitchShortcut() {
        Context context = getContext();
        Intent intent = new Intent(context, MainActivity.class).setAction(ACTION_SWITCH_SERVER);
        ShortcutInfoCompat shortcut = new ShortcutInfoCompat.Builder(context, "switch-server")
            .setShortLabel("Switch server")
            .setLongLabel("Switch Agora server")
            .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
            .setIntent(intent)
            .build();
        try {
            ShortcutManagerCompat.setDynamicShortcuts(context, Collections.singletonList(shortcut));
        } catch (Exception e) {
            Logger.warn(TAG, "Could not publish the Switch server shortcut");
        }
    }
}

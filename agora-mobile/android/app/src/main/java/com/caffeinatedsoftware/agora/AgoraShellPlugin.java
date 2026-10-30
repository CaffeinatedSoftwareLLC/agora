package com.caffeinatedsoftware.agora;

import android.Manifest;
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
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSExport;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.MessageHandler;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * The shell around the user's Agora instances:
 *  - navigation lock: only saved servers (and the bundled picker) load in the WebView;
 *  - the Capacitor bridge and window.AgoraNative on saved servers only, main frame only,
 *    with instance pages limited to BridgePolicy; without the WebView features that
 *    scoping needs, no bridge at all and no saved server loads (fail closed);
 *  - push registration in native code, for the calling page's origin as the WebView
 *    reports it: the device token never reaches page JavaScript;
 *  - microphone for the saved server shown (AgoraChromeClient);
 *  - the "agora" notification channel and the "Switch server" shortcut.
 */
@CapacitorPlugin(
    name = "AgoraShell",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = AgoraShellPlugin.NOTIFICATIONS) }
)
public class AgoraShellPlugin extends Plugin {

    static final String ACTION_SWITCH_SERVER = "com.caffeinatedsoftware.agora.SWITCH_SERVER";
    static final String NOTIFICATION_CHANNEL_ID = "agora";
    static final String NOTIFICATIONS = "notifications";
    private static final String TAG = "AgoraShell";
    /** Capacitor Preferences' default group and the picker's key; see src/lib/servers.ts. */
    private static final String PREFERENCES_GROUP = "CapacitorStorage";
    private static final String SERVERS_KEY = "agora.servers";
    /** Native-only: SHA-256 of the device token each origin's handle was registered with. No page reads it. */
    private static final String PUSH_TOKEN_GROUP = "AgoraShellPush";
    private static final String BRIDGE_NAME = "androidBridge";
    /** Plugins whose JS proxies instance pages get. BridgePolicy decides what they may call. */
    private static final String[] REMOTE_PLUGIN_IDS = { "AgoraShell", "PushNotifications", "Device" };
    private static final String PAGE_ONLY = "Only a saved server's page can use this";

    private volatile Set<String> savedOrigins = Collections.emptySet();
    /** True once the scoped bridge is installed; until then (or if it fails) no saved server loads. */
    private volatile boolean remoteAllowed = false;
    private String localOrigin;
    private String relayOrigin;
    private MessageHandler messageHandler;
    private ScriptHandler instanceScript;
    private String instanceScriptSource;
    private boolean autoOpenUsed = false;
    /** Main thread. The saved servers changed and the listener still has the old rules; see serversChanged. */
    private boolean rescopePending = false;
    /** Main thread. A re-scope reloaded the picker; clear the history once it loads (ShellPolicy.clearHistoryAfterRescope). */
    private boolean clearHistoryOnPickerLoad = false;
    /** One thread: registrations for an origin never interleave. */
    private final ExecutorService pushExecutor = Executors.newSingleThreadExecutor();
    private final Map<String, PageCall> pendingPermission = new ConcurrentHashMap<>();

    /** An AgoraShell call from an instance page, answered only to the document that made it. */
    private static final class PageCall {

        final String origin;
        final String callbackId;
        final String methodName;
        final JavaScriptReplyProxy replyProxy;

        PageCall(String origin, String callbackId, String methodName, JavaScriptReplyProxy replyProxy) {
            this.origin = origin;
            this.callbackId = callbackId;
            this.methodName = methodName;
            this.replyProxy = replyProxy;
        }
    }

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
        // Capacitor's client plus a picker message when a saved server can't be reached.
        bridge.setWebViewClient(new AgoraWebViewClient(bridge, () -> savedOrigins));
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                AgoraShellPlugin.this.onPageLoaded(webView);
            }
        });
        boolean scopable = ShellPolicy.canScopeBridge(
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER),
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        );
        if (scopable && exposeBridge()) {
            remoteAllowed = true;
        } else {
            failClosed();
        }
    }

    /**
     * Without the scoped listener, Capacitor's fallback is a JavaScript interface that
     * every page and frame can call with no origin check. Remove it, keep saved servers
     * out of the WebView, and reload the picker, which then explains what to update.
     */
    private void failClosed() {
        remoteAllowed = false;
        Logger.error(TAG, "Could not scope the native bridge. This Android System WebView is too old: update it from the Play Store.", null);
        WebView webView = getBridge().getWebView();
        webView.removeJavascriptInterface(BRIDGE_NAME);
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME);
            }
        } catch (Exception e) {
            Logger.warn(TAG, "Could not remove the bridge listener");
        }
        if (instanceScript != null) {
            instanceScript.remove();
            instanceScript = null;
        }
        // A removed JavaScript interface disappears on the next page load.
        webView.loadUrl(getBridge().getAppUrl());
    }

    // ── Navigation lock ──────────────────────────────────────────────

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String raw = url.toString();
        switch (ShellPolicy.decideLoad(raw, localOrigin, savedOrigins, remoteAllowed)) {
            case WEBVIEW:
                return false;
            case REFUSE:
                Logger.warn(TAG, "Refused to open a saved server: the bridge is not scoped on this WebView");
                return true;
            default:
                break;
        }
        // Everything else (other sites, mailto:, tel:, intent:) goes to the system.
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, url);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Logger.warn(TAG, "No app to open " + ShellPolicy.scheme(raw) + " link");
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

    /**
     * The Java filter (onBridgeMessage, shouldOverrideLoad) follows the new list at once.
     * The listener and instance script can't be re-registered under the picker that is
     * calling: once the listener is removed and re-added, the next message from a document
     * that still holds the old androidBridge object crashes the WebView (SIGSEGV in its
     * native code). So the picker gives way to the blank page, which has no such object;
     * onPageLoaded re-scopes there and loads the picker again.
     */
    @PluginMethod
    public void serversChanged(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            savedOrigins = readSavedOrigins();
            call.resolve();
            if (!remoteAllowed) return;
            rescopePending = true;
            getBridge().getWebView().loadUrl(ShellPolicy.BLANK);
        });
    }

    /** Main thread, from the WebViewListener added in attach(). */
    private void onPageLoaded(WebView webView) {
        String loaded = webView.getUrl();
        switch (ShellPolicy.rescope(rescopePending, loaded)) {
            case NOW:
                rescopePending = false;
                if (!remoteAllowed) return;
                if (exposeBridge()) {
                    clearHistoryOnPickerLoad = true;
                    webView.loadUrl(getBridge().getAppUrl());
                } else {
                    failClosed();
                }
                break;
            case BLANK_FIRST:
                webView.loadUrl(ShellPolicy.BLANK);
                break;
            default:
                // The blank page and the earlier entries go, so Back never lands on the blank page.
                if (ShellPolicy.clearHistoryAfterRescope(clearHistoryOnPickerLoad, loaded, localOrigin)) webView.clearHistory();
                // Only the first page after the re-scope; MainActivity's Back skips a blank entry otherwise.
                if (!ShellPolicy.isBlankPage(loaded)) clearHistoryOnPickerLoad = false;
                break;
        }
    }

    /*
     * registerPush, unregisterPush and hasPushHandle are declared so instance pages get
     * them on their AgoraShell proxy. Calls from instance pages never arrive here: the
     * bridge filter runs them for the origin the WebView reported (handlePageCall). The
     * picker has no instance origin, so these refuse it.
     */

    @PluginMethod
    public void registerPush(PluginCall call) {
        call.reject(PAGE_ONLY);
    }

    @PluginMethod
    public void unregisterPush(PluginCall call) {
        call.reject(PAGE_ONLY);
    }

    @PluginMethod
    public void hasPushHandle(PluginCall call) {
        call.reject(PAGE_ONLY);
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

    /**
     * (Re)register the bridge listener and the instance script for the current saved
     * servers. Main thread. Returns false if the scoped listener could not be installed.
     * Only call it while no document holds an androidBridge object: before the first page
     * (attach) or on the blank page (onPageLoaded).
     */
    private boolean exposeBridge() {
        WebView webView = getBridge().getWebView();
        try {
            WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME);
            if (messageHandler == null) {
                // Its constructor registers an unfiltered listener under the same name (or, if
                // that fails, a JavaScript interface); replace it.
                messageHandler = new MessageHandler(getBridge(), webView, null);
                WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME);
                webView.removeJavascriptInterface(BRIDGE_NAME);
            }
            Set<String> rules = new HashSet<>(savedOrigins);
            rules.add(localOrigin);
            WebViewCompat.addWebMessageListener(webView, BRIDGE_NAME, rules, this::onBridgeMessage);
        } catch (Exception e) {
            Logger.error(TAG, "Could not install the bridge listener", e);
            return false;
        }

        if (instanceScript != null) {
            instanceScript.remove();
            instanceScript = null;
        }
        if (savedOrigins.isEmpty()) return true;
        try {
            if (instanceScriptSource == null) instanceScriptSource = buildInstanceScript();
            instanceScript = WebViewCompat.addDocumentStartJavaScript(webView, instanceScriptSource, new HashSet<>(savedOrigins));
        } catch (Exception e) {
            // Instance pages then get no Capacitor runtime; the listener still filters anything they send.
            Logger.error(TAG, "Could not install the instance script", e);
        }
        return true;
    }

    private void onBridgeMessage(
        WebView view,
        androidx.webkit.WebMessageCompat message,
        Uri sourceOrigin,
        boolean isMainFrame,
        JavaScriptReplyProxy replyProxy
    ) {
        String data = message.getData();
        if (!isMainFrame || data == null) return;
        String origin = Origins.anyOrigin(sourceOrigin.toString());
        if (origin != null && origin.equals(localOrigin)) {
            messageHandler.postMessage(data);
            return;
        }
        if (!remoteAllowed || origin == null || !savedOrigins.contains(origin)) return;
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
            String callbackId = msg.optString("callbackId", null);
            JSONObject options = msg.optJSONObject("options");
            String eventName = options == null ? null : options.optString("eventName", null);
            if (BridgePolicy.allowRemote(origin, pluginId, methodName, eventName)) {
                if ("AgoraShell".equals(pluginId)) {
                    if (callbackId != null) handlePageCall(new PageCall(origin, callbackId, methodName, replyProxy), options);
                } else {
                    messageHandler.postMessage(data);
                }
                return;
            }
            Logger.warn(TAG, "Refused " + pluginId + "." + methodName + " from " + origin);
            if (callbackId != null && pluginId != null && methodName != null) {
                new PluginCall(messageHandler, pluginId, callbackId, methodName, new JSObject()).reject("Not available to this page");
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

    // ── Push registration for instance pages ─────────────────────────

    private void handlePageCall(PageCall call, JSONObject options) {
        switch (call.methodName) {
            case "registerPush":
                registerPushFor(call);
                break;
            case "unregisterPush":
                unregisterPushFor(call, options == null ? null : options.optString("handle", null));
                break;
            case "hasPushHandle": {
                JSObject result = new JSObject();
                result.put("value", PushRelay.isHandle(storedHandle(call.origin)));
                reply(call, result, null);
                break;
            }
            default:
                reply(call, null, "Not available to this page");
        }
    }

    private void registerPushFor(PageCall call) {
        if (relayOrigin == null) {
            reply(call, null, "relay_url_invalid");
            return;
        }
        if (!firebaseConfigured()) {
            // Without google-services.json FirebaseMessaging is not initialised.
            reply(call, null, "Push notifications are not configured in this build");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            PermissionState state = getPermissionState(NOTIFICATIONS);
            if (state == PermissionState.DENIED) {
                replyNotRegistered(call);
                return;
            }
            if (state != PermissionState.GRANTED) {
                // Capacitor's permission flow needs a saved PluginCall; this one only carries an ID.
                String id = "agora-push-" + UUID.randomUUID();
                pendingPermission.put(id, call);
                PluginCall permissionCall = new PluginCall(messageHandler, getPluginHandle().getId(), id, "registerPush", new JSObject());
                requestPermissionForAlias(NOTIFICATIONS, permissionCall, "notificationPermissionResult");
                return;
            }
        }
        fetchTokenAndRegister(call);
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall permissionCall) {
        if (permissionCall == null) return;
        PageCall call = pendingPermission.remove(permissionCall.getCallbackId());
        permissionCall.release(getBridge());
        if (call == null) return;
        if (getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            fetchTokenAndRegister(call);
        } else {
            replyNotRegistered(call);
        }
    }

    private void fetchTokenAndRegister(PageCall call) {
        FirebaseMessaging messaging;
        try {
            messaging = FirebaseMessaging.getInstance();
            messaging.setAutoInitEnabled(true);
        } catch (Exception e) {
            reply(call, null, "push_registration_failed: " + e.getClass().getSimpleName());
            return;
        }
        messaging
            .getToken()
            .addOnCompleteListener(task -> {
                String token = task.isSuccessful() ? task.getResult() : null;
                if (token == null || token.isEmpty()) {
                    Exception e = task.getException();
                    reply(call, null, "push_registration_failed: " + (e == null ? "no token" : e.getMessage()));
                    return;
                }
                pushExecutor.execute(() -> registerWithRelay(call, token));
            });
    }

    /**
     * On pushExecutor. Always asks the relay, naming the stored handle as `previous`: the
     * relay hands it back while it still holds this token and origin, or issues a new one
     * (PushRelay.register).
     */
    private void registerWithRelay(PageCall call, String token) {
        String key = BridgePolicy.HANDLE_KEY_PREFIX + call.origin;
        String tokenHash = PushRelay.sha256(token);
        SharedPreferences handles = getContext().getSharedPreferences(PREFERENCES_GROUP, Context.MODE_PRIVATE);
        SharedPreferences hashes = getContext().getSharedPreferences(PUSH_TOKEN_GROUP, Context.MODE_PRIVATE);
        String oldHandle = handles.getString(key, null);
        String relay = relayOrigin;
        String handle;
        try {
            handle = PushRelay.register((method, path, bearer, body) -> PushRelay.send(relay, method, path, bearer, body), "android", token, call.origin, oldHandle);
        } catch (PushRelay.RegisterFailed e) {
            reply(call, null, e.getMessage());
            return;
        } catch (Exception e) {
            reply(call, null, "relay_register_failed: " + e.getClass().getSimpleName());
            return;
        }
        handles.edit().putString(key, handle).commit();
        hashes.edit().putString(call.origin, tokenHash).commit();
        reply(call, registration(handle), null);
        if (PushRelay.replaces(oldHandle, handle)) {
            // A new token (the old handle points at a dead token), or the relay no longer knew
            // the old handle (the DELETE is then a harmless 204). Best effort either way.
            try {
                PushRelay.send(relayOrigin, "DELETE", "/v1/handles", oldHandle, null);
            } catch (Exception e) {
                Logger.warn(TAG, "Could not delete the previous push handle for " + call.origin);
            }
        }
    }

    private void unregisterPushFor(PageCall call, String handle) {
        if (!PushRelay.isHandle(handle)) {
            reply(call, null, "handle_invalid");
            return;
        }
        if (relayOrigin == null) {
            reply(call, null, "relay_url_invalid");
            return;
        }
        pushExecutor.execute(() -> {
            String key = BridgePolicy.HANDLE_KEY_PREFIX + call.origin;
            SharedPreferences handles = getContext().getSharedPreferences(PREFERENCES_GROUP, Context.MODE_PRIVATE);
            if (!PushRelay.mayUnregister(handle, handles.getString(key, null))) {
                reply(call, null, "handle_not_registered");
                return;
            }
            int status;
            try {
                status = PushRelay.send(relayOrigin, "DELETE", "/v1/handles", handle, null).status;
            } catch (Exception e) {
                reply(call, null, "relay_unregister_failed: " + e.getClass().getSimpleName());
                return;
            }
            if (!PushRelay.unregistered(status)) {
                reply(call, null, "relay_unregister_failed: " + status);
                return;
            }
            handles.edit().remove(key).commit();
            getContext().getSharedPreferences(PUSH_TOKEN_GROUP, Context.MODE_PRIVATE).edit().remove(call.origin).commit();
            // The device token itself stays registered: other saved servers may use it.
            reply(call, new JSObject(), null);
        });
    }

    private String storedHandle(String origin) {
        return getContext().getSharedPreferences(PREFERENCES_GROUP, Context.MODE_PRIVATE).getString(BridgePolicy.HANDLE_KEY_PREFIX + origin, null);
    }

    private JSObject registration(String handle) {
        JSObject result = new JSObject();
        result.put("registered", true);
        result.put("relay", relayOrigin);
        result.put("handle", handle);
        result.put("platform", "android");
        return result;
    }

    private void replyNotRegistered(PageCall call) {
        JSObject result = new JSObject();
        result.put("registered", false);
        reply(call, result, null);
    }

    /** Settle the page's promise through the reply proxy of the document that called, never another page. */
    private void reply(PageCall call, JSObject data, String error) {
        JSObject msg = new JSObject();
        msg.put("save", false);
        msg.put("callbackId", call.callbackId);
        msg.put("pluginId", "AgoraShell");
        msg.put("methodName", call.methodName);
        msg.put("success", error == null);
        if (error == null) {
            msg.put("data", data == null ? new JSObject() : data);
        } else {
            JSObject err = new JSObject();
            err.put("message", error);
            msg.put("error", err);
        }
        String json = msg.toString();
        getBridge().executeOnMainThread(() -> {
            try {
                call.replyProxy.postMessage(json);
            } catch (Exception e) {
                Logger.warn(TAG, "Could not answer " + call.methodName + " on " + call.origin);
            }
        });
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

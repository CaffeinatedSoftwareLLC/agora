/**
 * True on the bundled picker inside the app when native code withheld the bridge.
 * Capacitor always injects WEBVIEW_SERVER_URL into its own pages, but on Android
 * the bridge object itself is only there when the shell could scope it to the
 * picker and saved servers (WebView features WEB_MESSAGE_LISTENER and
 * DOCUMENT_START_SCRIPT). Without it the shell fails closed: no bridge, and no
 * saved server opens in the app.
 */
export function nativeBridgeMissing(win: { WEBVIEW_SERVER_URL?: unknown }, isNativePlatform: boolean): boolean {
    return typeof win.WEBVIEW_SERVER_URL === 'string' && win.WEBVIEW_SERVER_URL !== '' && !isNativePlatform;
}

export const WEBVIEW_TOO_OLD =
    'This phone\'s Android System WebView is too old for Agora to open servers safely. ' +
    'Update "Android System WebView" (and Chrome) in the Play Store, then close and reopen Agora.';

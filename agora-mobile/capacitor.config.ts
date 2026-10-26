import type { CapacitorConfig } from '@capacitor/cli';
import app from './app.config.json';

/**
 * The shell's start page is the bundled server picker (dist/). It never sets
 * `server.url`: the instance origins are the user's saved servers, which the
 * native AgoraShell code reads at runtime (see README "Security").
 *
 * appId, appName and relayUrl live in app.config.json, the one place to change them.
 */
const config: CapacitorConfig = {
    appId: app.appId,
    appName: app.appName,
    webDir: 'dist',
    // Terracotta `bg` (agora-ui/src/theme/palettes.ts), so the WebView never flashes white before the picker paints
    backgroundColor: '#1C1410',
    // Navigation is decided by AgoraShell.shouldOverrideLoad against the saved servers.
    // Leave allowNavigation empty: anything listed here would bypass that check.
    server: { androidScheme: 'https' },
    android: {
        // Remote pages get the bridge through WebMessageListener and document-start
        // scripts, which need a current Android System WebView.
        minWebViewVersion: 100,
    },
    plugins: {
        AgoraShell: { relayUrl: app.relayUrl },
        PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
    },
};

export default config;

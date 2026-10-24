import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HANDLE_KEY_PREFIX, SERVERS_KEY } from '../src/lib/servers';

/**
 * The native projects repeat a few values the TypeScript side owns. These
 * checks catch drift that would otherwise only show on a device.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const app = JSON.parse(read('app.config.json'));
const pkg = JSON.parse(read('package.json'));
const javaDir = 'android/app/src/main/java/com/caffeinatedsoftware/agora';

describe('app.config.json', () => {
    it('has an https relay URL and a reverse-DNS app ID', () => {
        expect(new URL(app.relayUrl).protocol).toBe('https:');
        expect(app.appId).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
        expect(app.appName).toBe('Agora');
    });

    it('is the iOS bundle ID and version source', () => {
        const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
        const ids = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]);
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids)).toEqual(new Set([app.appId]));
        const versions = [...pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]);
        expect(new Set(versions)).toEqual(new Set([pkg.version]));
    });

    it('is read by the Android build', () => {
        const gradle = read('android/app/build.gradle');
        expect(gradle).toContain("file('../../app.config.json')");
        expect(gradle).toContain('applicationId agoraApp.appId');
    });
});

describe('native code', () => {
    it('reads the saved servers and handles under the same keys', () => {
        const java = read(`${javaDir}/AgoraShellPlugin.java`);
        expect(java).toContain(`SERVERS_KEY = "${SERVERS_KEY}"`);
        expect(read(`${javaDir}/BridgePolicy.java`)).toContain(`HANDLE_KEY_PREFIX = "${HANDLE_KEY_PREFIX}"`);
        const swift = read('ios/App/App/AgoraShellPlugin.swift');
        expect(swift).toContain(`"CapacitorStorage.${SERVERS_KEY}"`);
        expect(swift).toContain(`handleKeyPrefix = "${HANDLE_KEY_PREFIX}"`);
    });

    it('allows the same plugin calls on both platforms', () => {
        const java = read(`${javaDir}/BridgePolicy.java`);
        const swift = read('ios/App/App/AgoraShellPlugin.swift');
        for (const name of ['checkPermissions', 'requestPermissions', 'register', 'addListener', 'removeListener', 'removeAllListeners',
            'registration', 'registrationError', 'pushNotificationActionPerformed']) {
            expect(java).toContain(`"${name}"`);
            expect(swift).toContain(`"${name}"`);
        }
        expect(java).not.toContain('"unregister"');
        expect(swift).not.toContain('"unregister"');
    });

    it('sends notifications to the "agora" channel and approvals to AGORA_APPROVAL', () => {
        expect(read(`${javaDir}/AgoraShellPlugin.java`)).toContain('NOTIFICATION_CHANNEL_ID = "agora"');
        expect(read('android/app/src/main/AndroidManifest.xml')).toMatch(/default_notification_channel_id"\s+android:value="agora"/);
        expect(read('ios/App/App/AppDelegate.swift')).toContain('"AGORA_APPROVAL"');
    });

    it('declares the microphone on both platforms', () => {
        expect(read('android/app/src/main/AndroidManifest.xml')).toContain('android.permission.RECORD_AUDIO');
        expect(read('ios/App/App/Info.plist')).toContain('NSMicrophoneUsageDescription');
    });

    it('uses the custom view controller on iOS', () => {
        expect(read('ios/App/App/Base.lproj/Main.storyboard')).toContain('customClass="AgoraBridgeViewController"');
    });
});

describe('credentials', () => {
    it('are gitignored', () => {
        const ignore = read('.gitignore');
        for (const entry of ['android/app/google-services.json', 'ios/App/App/GoogleService-Info.plist', '*.keystore', '*.jks', 'keystore.properties', '*.p8', '*.p12']) {
            expect(ignore).toContain(entry);
        }
    });
});

describe('iOS Swift package', () => {
    it('uses forward-slash paths (cap sync ios on Windows writes backslashes; run it on the Mac)', () => {
        expect(read('ios/App/CapApp-SPM/Package.swift')).not.toContain(String.fromCharCode(92));
    });
});

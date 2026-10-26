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

/** The calls window.AgoraNative needs (src/inject/agora-native.ts), as "pluginId.methodName". */
const REMOTE_CALLS = [
    'AgoraShell.registerPush',
    'AgoraShell.unregisterPush',
    'AgoraShell.hasPushHandle',
    'PushNotifications.addListener',
    'PushNotifications.removeListener',
    'PushNotifications.removeAllListeners',
    'Device.getInfo',
    // iOS's native bridge sends every console call to the Console plugin; Android has no
    // such plugin, so allowing it there is a no-op that keeps the two lists identical.
    'Console.log',
];
const REMOTE_EVENTS = ['PushNotifications.pushNotificationActionPerformed'];

const literals = (source: string) => [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);

function block(source: string, start: RegExp, end: string): string {
    const m = start.exec(source);
    if (!m) throw new Error(`not found: ${start}`);
    const from = m.index + m[0].length;
    const to = source.indexOf(end, from);
    if (to < 0) throw new Error(`no end for ${start}`);
    return source.slice(from, to);
}

/** BridgePolicy.java: REMOTE_CALLS and REMOTE_EVENTS, and every string literal in the class. */
function javaPolicy() {
    const source = read(`${javaDir}/BridgePolicy.java`).replace(/\r\n/g, '\n');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return {
        calls: new Set(literals(block(code, /REMOTE_CALLS\s*=\s*setOf\(/, ');'))),
        events: new Set(literals(block(code, /REMOTE_EVENTS\s*=\s*setOf\(/, ');'))),
        literals: literals(code),
    };
}

/** `enum BridgePolicy` in AgoraShellPlugin.swift, the same way. */
function swiftPolicy() {
    const source = read('ios/App/App/AgoraShellPlugin.swift').replace(/\r\n/g, '\n');
    const code = block(source, /\nenum BridgePolicy \{/, '\n}\n').replace(/\/\/.*$/gm, '');
    return {
        calls: new Set(literals(block(code, /static let remoteCalls: Set<String> = \[/, ']'))),
        events: new Set(literals(block(code, /static let remoteEvents: Set<String> = \[/, ']'))),
        literals: literals(code),
    };
}

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

    it('allows exactly the same calls and events to instance pages on both platforms', () => {
        const java = javaPolicy();
        const swift = swiftPolicy();
        expect(java.calls).toEqual(swift.calls);
        expect(java.events).toEqual(swift.events);
        // What src/inject/agora-native.ts needs, and nothing else.
        expect(java.calls).toEqual(new Set(REMOTE_CALLS));
        expect(java.events).toEqual(new Set(REMOTE_EVENTS));
    });

    it('decides instance pages only from those lists', () => {
        // Every string literal in either policy is a list entry or one of these, so an
        // extra allowance outside the lists (a `case "Preferences":`) fails here.
        const allowed = new Set([
            ...REMOTE_CALLS, ...REMOTE_EVENTS, HANDLE_KEY_PREFIX, 'addListener', 'eventName',
            // How each side builds the "pluginId.name" keys it looks up.
            '.', '\\(pluginId).\\(methodName)', '\\(pluginId).\\(eventName)',
        ]);
        for (const literal of [...javaPolicy().literals, ...swiftPolicy().literals]) {
            expect(allowed, `unexpected literal "${literal}" in a BridgePolicy`).toContain(literal);
        }
    });

    it('never lets instance pages near the device token, the relay or Preferences', () => {
        for (const policy of [javaPolicy(), swiftPolicy()]) {
            expect(policy.calls).not.toContain('PushNotifications.register');
            expect(policy.calls).not.toContain('PushNotifications.unregister');
            expect(policy.events).not.toContain('PushNotifications.registration');
            expect(policy.events).not.toContain('PushNotifications.registrationError');
            for (const call of policy.calls) expect(call).not.toMatch(/^(CapacitorHttp|Preferences|CapacitorCookies)\./);
        }
    });

    it('declares the AgoraShell push methods natively on both platforms', () => {
        const java = read(`${javaDir}/AgoraShellPlugin.java`);
        const swift = read('ios/App/App/AgoraShellPlugin.swift');
        for (const call of REMOTE_CALLS.filter((c) => c.startsWith('AgoraShell.'))) {
            const method = call.slice('AgoraShell.'.length);
            expect(java).toMatch(new RegExp(`@PluginMethod\\s+public void ${method}\\(PluginCall call\\)`));
            expect(java).toContain(`case "${method}":`);
            expect(swift).toContain(`CAPPluginMethod(name: "${method}", returnType: CAPPluginReturnPromise)`);
            expect(swift).toContain(`case "${method}":`);
        }
        expect(java).toContain('"AgoraShell"');
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

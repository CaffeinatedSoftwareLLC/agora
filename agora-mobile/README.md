# Agora for Android and iOS

The store apps for Agora: a Capacitor 7 shell that opens **your own Agora instance** in a WebView and adds what a browser tab can't: native push notifications, Approve/Deny actions on approval notifications, and the microphone for push-to-talk. Plan: `docs/planning/mobile-apps.md` (Phase 4; the bridge and relay shapes are its section 8).

Agora is not affiliated with Anthropic, OpenAI or Google. Claude Code, Codex and Gemini are trademarks of their owners.

## How it works

- **Server picker.** The app's bundled start page (`index.html`, `src/picker/`) lists saved servers and adds new ones. A new address must be `https://host[:port]` and answer like Agora: `GET /health` returns `{ "status": "ok" }` and `GET /instance/status` has Agora's shape. The list is stored with Capacitor Preferences (`agora.servers`).
- **The instance, not a bundled UI.** Opening a server navigates the WebView to its origin, so the `SameSite=Strict` session cookie, sockets and uploads work unchanged, and the UI always matches its server.
- **Navigation lock.** Only the picker and saved origins load in the WebView. Every other link (other sites, `mailto:`, `tel:`) opens in the system browser or app. `server.allowNavigation` stays empty on purpose: the lock is `AgoraShell.shouldOverrideLoad`, which reads the saved list.
- **Back to the server list.** Android: Back from a server's first page, or long-press the app icon → **Switch server**. iOS: swipe back from a server's first page, or long-press the app icon → **Switch server**. The app reopens the last server on launch; it doesn't after Switch server.
- **`window.AgoraNative`** (section 8) on saved servers: `platform`, `version`, `registerPush()` and `unregisterPush(handle)`. `registerPush()` asks for notification permission, gets the FCM (Android) or APNs (iOS) token, `POST`s `{platform, token, instance}` to the relay's `/v1/register` and returns `{relay, handle, platform, label}`; the handle is also stored on the device under `agora.push.<origin>`. `unregisterPush` calls `DELETE /v1/handles` and never unregisters the device token, which other saved servers share.
- **Notification taps.** The relay sends `data: {type, url, instance}` (`instance` is the origin the handle was registered for, set by the relay). The app opens `url` on `instance` only if `instance` is a saved server with a handle from this device and `url` is a path on it (`/…`, not `//…`, no backslashes or control characters). An instance page opens its own links; anything else goes through the picker, which checks the full saved list and otherwise returns the user to the page they were on.
- **Notifications.** Android channel `agora` (high importance); notifications are shown in the foreground too. iOS category `AGORA_APPROVAL` has **Approve…** and **Deny…** actions; both open the approval card in the app and need the device unlocked. Nothing is approved from the notification, so passkey step-up (#78) still applies.
- **Microphone.** Android `RECORD_AUDIO` and iOS `NSMicrophoneUsageDescription`. The WebView grants the microphone (never the camera) to saved servers only, main frame only.

## Security

The Capacitor bridge is what lets page JavaScript call native code. Capacitor normally exposes it to the app's own origin (Android) or to every page in the main frame with no origin check (iOS). The shell changes that:

- **Who gets the bridge.** Only the bundled picker and the saved server origins, and only their main frame. Android: the `androidBridge` message listener is re-registered with exactly those origins (`AgoraShellPlugin.exposeBridge`), and Capacitor's runtime plus `agora-native.js` are a document-start script scoped to the saved origins. iOS: a filtering `WKScriptMessageHandler` in front of Capacitor's checks each message's frame and security origin (`AgoraBridgeViewController.swift`). Sandboxed canvas iframes and any other frame get nothing.
- **What an instance page may call** (`BridgePolicy.java` / `BridgePolicy` in `AgoraShellPlugin.swift`, kept in step by `test/consistency.test.ts`): push permission and registration, the `registration`/`registrationError`/`pushNotificationActionPerformed` listeners, `Device.getInfo`, Preferences only for its own `agora.push.<origin>` key, and CapacitorHttp only to `<relay>/v1/…`. Everything else (the saved-server list, other servers' handles, `AgoraShell`, unregistering the device token, native HTTP elsewhere) is refused with an error. The picker may call everything.
- **What that means.** Adding a server trusts its pages with the above. A compromised or malicious saved server could register this device for its own pushes, read the device model, and see the origin and path of a tapped notification for another saved server. It cannot read the saved list or other servers' handles, change the list, or reach other hosts through the app. The device token passes through the instance page's JavaScript on its way to the relay; it is only useful together with Caffeinated Software's FCM/APNs credentials, which only the relay has.
- **Old Android WebViews.** The scoped bridge needs WebView features `WEB_MESSAGE_LISTENER` and `DOCUMENT_START_SCRIPT`; `minWebViewVersion` is 100. On an older WebView, instance pages get no bridge (no push).

## Configuration: `app.config.json` (confirm before release)

| Key | Value | Notes |
| --- | --- | --- |
| `appId` | `com.caffeinatedsoftware.agora` | **Placeholder, confirm.** Android `applicationId` reads it at build time. The iOS bundle ID is in the Xcode project (`PRODUCT_BUNDLE_IDENTIFIER`); `npm test` fails if the two differ. Cannot change after the first store upload. |
| `appName` | `Agora` | Store names may need a suffix if "Agora" is taken. |
| `relayUrl` | `https://push.agora.host` | **Placeholder, confirm.** Built into `agora-native.js` and the native bridge filter. Instances must list the same origin in their allowed relays. |

The app version is `package.json`'s `version`. Android derives `versionName` and `versionCode` from it; iOS `MARKETING_VERSION` must match (checked by `npm test`). Bump it for every store upload, and bump `CURRENT_PROJECT_VERSION` (iOS build number) in Xcode for every TestFlight upload.

Icons and splash screens are **Capacitor's placeholders**: there is no Agora logo in the repo yet. Before a store submission, put a 1024×1024 icon and a splash image in `agora-mobile/assets/` and run `npx @capacitor/assets generate`, or replace them in Android Studio (Image Asset) and Xcode (`Assets.xcassets`).

## Credentials

Nothing secret is in this repo, and none of these files may be committed (all are in `.gitignore`):

| File | Where it goes | What it is |
| --- | --- | --- |
| `google-services.json` | `agora-mobile/android/app/google-services.json` | Firebase Android app config (Firebase console → Project settings → Android app with the package name from `appId`). Without it the app builds and runs, but push is refused ("not configured in this build"). |
| Upload keystore (`.jks`) | Outside the repo, e.g. `%USERPROFILE%\.keys\agora-upload.jks`, plus a backup | Android upload key. Play App Signing holds the app signing key. |
| `keystore.properties` | `agora-mobile/android/keystore.properties` | `storeFile=C:/Users/<you>/.keys/agora-upload.jks`, `storePassword=…`, `keyAlias=…`, `keyPassword=…`. Read by `android/app/build.gradle` for release builds. |
| Apple certificates and profiles | Your Mac's keychain, managed by Xcode (automatic signing) | |
| APNs auth key (`.p8`) | The relay host only | With key ID, team ID, bundle ID and environment. Never in this repo or any instance. |
| FCM service-account JSON | The relay host only | Must belong to the same Firebase project as `google-services.json`. |

`GoogleService-Info.plist` is **not needed**: on iOS the push plugin returns the APNs token and the relay sends straight to APNs. (Its path, `ios/App/App/GoogleService-Info.plist`, is gitignored in case that changes.)

## Android (Windows)

Needs Node 22+, Android Studio (its bundled JDK 21 is enough) and the Android SDK (platform 35).

```bash
cd agora-mobile
npm ci
npm test && npm run check                 # unit tests and type-check
npm run sync:android                      # build the picker and agora-native.js, copy into android/
# Git Bash: use Android Studio's JDK
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
cd android && ./gradlew assembleDebug testDebugUnitTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or `npm run android` to sync and open Android Studio, then Run. Debug builds allow `chrome://inspect` on the WebView.

Never run `npx cap sync` (both platforms) or `cap sync ios` on Windows: it rewrites `ios/App/CapApp-SPM/Package.swift` with backslash paths. `npm test` catches that.

### Release: Play Console internal testing

1. Create the upload keystore once (keep it and its passwords safe, outside the repo):
   `keytool -genkeypair -v -keystore %USERPROFILE%\.keys\agora-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias agora-upload`
2. Write `android/keystore.properties` as above, and put `google-services.json` in `android/app/`.
3. `npm run sync:android`, then `cd android && ./gradlew bundleRelease` → `app/build/outputs/bundle/release/app-release.aab`.
4. Play Console → Create app (name, default language, app, free) → Testing → **Internal testing** → Create release → accept Play App Signing → upload the `.aab` → add testers (email list) → Save → Review → Roll out. Testers install from the opt-in link.
5. Before closed testing or production: the Phase 5 items below (Data safety form, privacy policy URL, content rating, app access instructions with the reviewer login).

## iOS (Mac)

Needs Xcode 16+, Node 22+, and the Apple developer account. No CocoaPods: the project uses Swift Package Manager.

```bash
git fetch && git checkout feat/mobile-shell
cd agora-mobile
npm ci
npm test
npm run sync:ios          # builds the web parts, copies them and refreshes Package.swift
npx cap open ios          # opens ios/App/App.xcodeproj
```

In Xcode:

1. Select the **App** target → **Signing & Capabilities**: tick *Automatically manage signing*, choose your team, and check the bundle identifier matches `app.config.json`. **Push Notifications** is already enabled through `App/App.entitlements`; Xcode registers the App ID with it.
2. Run on a real iPhone (Product → Run). Add your server, sign in, and allow notifications when the UI asks.
3. Apple Developer → Certificates, IDs & Profiles → **Keys** → + → Apple Push Notifications service (APNs) → download the `.p8` once. It goes to the relay host with the key ID, your team ID and the bundle ID. Debug builds from Xcode use the APNs **sandbox** (`development`); TestFlight and App Store builds use **production**, so the relay must send to the matching environment.

### Release: TestFlight

1. App Store Connect → Apps → + → New App: platform iOS, name, bundle ID (the one above), SKU.
2. Xcode: bump the build number (target → General → Build), select *Any iOS Device (arm64)*, Product → **Archive** → Distribute App → App Store Connect → Upload.
3. App Store Connect → TestFlight: answer export compliance (the app only uses HTTPS; `ITSAppUsesNonExemptEncryption` is `false`), add internal testers. External testing needs Beta App Review, which needs the demo instance and reviewer login (Phase 5).

## Store review notes (guideline 4.2, minimum functionality)

Suggested text for App Review notes and the Play "App access" section:

> Agora is a self-hosted control room for AI coding agents. The app connects to the user's own Agora server (a demo server and reviewer login are provided below) and adds native features the website cannot offer:
> - **Push notifications** when an agent needs the user: an approval waiting, a mention, a blocked session, a task ready for review. Delivered through APNs/FCM via our relay; notifications carry short labels only, never message content.
> - **Notification actions**: approval notifications have Approve and Deny actions that open the approval card directly (the decision is always confirmed in the app).
> - **Push-to-talk**: hold the microphone button in any message box to dictate to agents (microphone permission).
> - **Multiple servers**: a native server list and a "Switch server" quick action.
> To review: add the server `<demo URL>`, sign in as `<reviewer>`, then trigger a notification by `<step>`.

## Tests

- `npm test`: vitest for origin and deep-link validation, the bridge (`registerPush`/`unregisterPush` with the Capacitor plugins mocked), the instance-page installer, the server probe, the picker storage, and consistency checks between the TypeScript side and the native projects.
- `npm run check`: TypeScript.
- `cd android && ./gradlew testDebugUnitTest`: JUnit for `BridgePolicy` and `Origins`.
- The iOS Swift code has not been compiled yet (no Mac in the build loop); build it once in Xcode before relying on it.

## Remaining (Phase 5 and follow-ups)

- **In-app account deletion** (Apple requires it): decide whether a deleted account's messages are removed or anonymised.
- **Privacy policy URL**, Apple privacy labels and the Play Data safety form. Data: device push token and model label go to the relay and the user's instance; no tracking.
- **Demo instance with a reviewer login**, for App Review and Play app access.
- **Store listings** with the not-affiliated line, screenshots, real **icons and splash** (placeholders now).
- **Android Approve/Deny actions.** The relay sends FCM *notification* messages, which Android shows itself while the app is in the background, so action buttons can't be added. That needs data-only messages and the app building the notification (a custom `FirebaseMessagingService`), which changes the relay payload. iOS has the actions now.
- `agora-ui` must call `window.AgoraNative.registerPush()` after login and `unregisterPush` on logout (the notifications branch does this), and the instance admin must add the relay origin to the allowed relays.
- File downloads (`Content-Disposition: attachment`) are not handled yet: Capacitor's WebView has no download handler, and the system browser doesn't have the session cookie.
- iOS: build and run once in Xcode (the Swift code is unverified), then check push, a tap on a notification for another saved server, the Approve/Deny actions, and push-to-talk on a device.

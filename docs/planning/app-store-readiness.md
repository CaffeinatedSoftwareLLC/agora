# Store readiness: Google Play and the App Store

> **Status:** 2026-10-30. Phase 5 of [mobile-apps.md](mobile-apps.md). Release 0.3.5 has the notifications, the push relay, the app shells and account deletion. On-device tests passed on a Samsung S26 (FCM) and an iPad (APNs sandbox). No iPhone has been tested. What is left is listed here: hosting the privacy policy, the store forms, a demo instance, the relay going live, and the bundle ID.

Privacy policy draft: [docs/privacy-policy.md](../privacy-policy.md).

## 1. Only Eryk can do these

| # | What | Blocks |
|---|---|---|
| 1 | **Create the apps** in Play Console and App Store Connect with the bundle ID `com.caffeinatedsoftware.agora` (confirmed 2026-10-30; it can't change after the first upload). | Every upload |
| 2 | **Privacy contact address and effective date** for the policy. Use a role address, not a personal one: the policy is public. | Publishing the policy |
| 3 | **Publish the policy** at `https://agora.host/privacy` and the account-deletion page at `https://agora.host/delete-account` (section 4.3). | Both store forms |
| 4 | **Relay host:** pick a Linux VPS, point `push.agora.host` at it, and put the FCM service account and the APNs `.p8` key on it (section 6). | Push in store builds |
| 5 | **Approve the demo instance plan** (section 5), then its host, `demo.agora.host`, and the reviewer passwords (kept in your password manager). | Review on both stores |
| 6 | **Answer the Play Data safety form and the App Store privacy label** in the consoles, using sections 2 and 3. Decide the open question in 2.2. | Submission |
| 7 | **Store listings:** screenshots, descriptions with the not-affiliated line, the content rating questionnaire, the category (Developer Tools / Productivity). | Submission |

Apple signing: the certificates are ready, kept outside this repo. Register the App ID `com.caffeinatedsoftware.agora` with Push Notifications (Xcode does this with automatic signing).

## 2. Google Play: Data safety

Play's rule: data is **collected** when it leaves the device. Data passed to a service provider that processes it for you is not **shared**. Every answer below comes from the code in 0.3.5.

### 2.1 Data Caffeinated Software handles (the relay, plus Google's FCM SDK)

| Question | Answer | Evidence |
|---|---|---|
| Does the app collect or share required user data types? | **Yes** | |
| Is all user data encrypted in transit? | **Yes** | The app only adds `https://` servers (`agora-mobile/src/lib/`); the relay and FCM use HTTPS |
| Do you provide a way for users to request deletion? | **Yes** | In-app account deletion (`DELETE /users/@me`, #293); the device and server removal paths in the policy, section 5 |
| **Device or other IDs** | **Collected**, not shared. Not processed ephemerally. **Optional** (the user can turn notifications off). Purpose: **App functionality** | The FCM registration token is stored encrypted by the relay (`agora-push-relay/src/store.ts`). `firebase-messaging` also uses a Firebase installation ID to deliver (`android/app/build.gradle:70`). Google acts as a service provider here |

Not collected by the app or the relay: location, contacts, calendar, health, financial info, web history, app usage analytics, crash logs, advertising ID. The only libraries are Capacitor core, Device, Preferences and Push Notifications, plus `firebase-messaging` on Android. There is no analytics or crash SDK in `agora-mobile` or `agora-ui` (checked with grep).

### 2.2 Data the app sends to the user's own instance (open decision)

Play counts anything the app sends off the device, even to a server the user chose and Caffeinated Software can't reach. The WebView sends the instance what any Agora account involves. Two ways to answer:

- **A. Declare it (recommended).** Declaring more than you collect is safe. Declaring less can get the app pulled. Add the types below, all **Collected**, not shared, purpose **App functionality** and **Account management**, with the note in the policy that the data goes to the server the user picks:
  - Personal info: **Email address**, **User IDs** (username). Required on instances that ask for email.
  - Messages: **Other in-app messages**. Required.
  - Photos and videos, Files and docs: **Files and docs** and **Photos**. Optional (uploads).
  - Audio: **Voice or sound recordings**. Optional (push-to-talk, sent to the instance for transcription).
  - Device or other IDs: already declared above. The instance stores a device label, such as "Pixel 8 (Android)".
- **B. Declare only 2.1**, because Caffeinated Software never receives instance data. That matches Apple's definition (section 3), but Play's definition is about data leaving the device, so this is the riskier reading.

### 2.3 Other Play Console items

- **App access:** "All or some functionality is restricted". Give the demo server address and the reviewer login (section 5), plus the steps from the review note in `agora-mobile/README.md`.
- **Account deletion:** Play requires a **web link** where users can request deletion without the app (section 4.3), and an in-app path (Settings → Account & security → Delete account).
- **Ads:** No. **Content rating:** questionnaire. Users can exchange messages, so answer yes to "users can interact".
- **Target audience:** 18+, or 13+. Not designed for children.
- **Permissions:** `RECORD_AUDIO` is used for push-to-talk only, and `POST_NOTIFICATIONS` for alerts. No sensitive permission declarations are needed.

## 3. App Store: App Privacy (nutrition label)

Apple's rule: data is **collected** when it leaves the device so that **you or your third-party partners** can access it for longer than the request takes. An instance run by someone else is neither, so its data is not collected by Caffeinated Software.

| Apple category | Answer | Why |
|---|---|---|
| **Identifiers → Device ID** | **Collected.** Purpose: **App Functionality**. **Not linked** to the user's identity. **Not used for tracking** | The APNs device token, stored encrypted by the relay next to the instance origin. It holds no account, name or email (`store.ts`) |
| Everything else (Contact Info, User Content, Audio, Usage Data, Diagnostics, Location, …) | **Not collected** | It goes only to the user's chosen instance. iOS uses APNs directly and has no Firebase SDK (`agora-mobile/README.md`, Credentials) |
| Tracking | **No** | No ad SDKs, no cross-app identifiers, no data brokers |

If Caffeinated Software ever runs instances for users (hosted Agora), the instance data becomes collected and this label must change.

Also in App Store Connect:
- **Privacy Policy URL:** `https://agora.host/privacy`.
- **Account deletion:** in the app at Settings → Account & security → Delete account (guideline 5.1.1(v)).
- **Export compliance:** `ITSAppUsesNonExemptEncryption` is `false` (HTTPS only).
- **Sign-in required:** yes. Give the demo login in App Review Information (section 5).

### 3.1 Privacy manifest (`PrivacyInfo.xcprivacy`), to do on the Mac

The app has no privacy manifest yet, and App Store Connect rejects uploads that use "required reason" APIs without one. `AgoraShellPlugin.swift` reads `UserDefaults` directly (lines 33, 241, 291, 319). In Xcode: File → New → File → **App Privacy**, target **App**, then:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSPrivacyTracking</key>
    <false/>
    <key>NSPrivacyTrackingDomains</key>
    <array/>
    <key>NSPrivacyCollectedDataTypes</key>
    <array>
        <dict>
            <key>NSPrivacyCollectedDataType</key>
            <string>NSPrivacyCollectedDataTypeDeviceID</string>
            <key>NSPrivacyCollectedDataTypeLinked</key>
            <false/>
            <key>NSPrivacyCollectedDataTypeTracking</key>
            <false/>
            <key>NSPrivacyCollectedDataTypePurposes</key>
            <array>
                <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
            </array>
        </dict>
    </array>
    <key>NSPrivacyAccessedAPITypes</key>
    <array>
        <dict>
            <key>NSPrivacyAccessedAPIType</key>
            <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
            <key>NSPrivacyAccessedAPITypeReasons</key>
            <array>
                <string>CA92.1</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
```

Then check that each Capacitor plugin package (`node_modules/@capacitor/*/ios`) ships its own `PrivacyInfo.xcprivacy`. `@capacitor/device` reports disk space; if its package has no manifest, add `NSPrivacyAccessedAPICategoryDiskSpace` to the app's manifest. Archive once, then Xcode → Organizer → **Generate Privacy Report** to confirm.

## 4. Privacy policy

### 4.1 What it covers

[docs/privacy-policy.md](../privacy-policy.md) covers:
- what the app keeps on the phone, the relay and the instance;
- encryption, logs and retention (365-day relay prune);
- deletion paths;
- Google and Apple as delivery providers;
- the rule that self-hosted instances are run by their operators.

It is written against 0.3.5. Re-check it when the relay, the app's plugins or the push payload change.

### 4.2 Where it must be hosted

| Place | What goes there |
|---|---|
| `https://agora.host/privacy` (Cloudflare Pages) | The published text, public, no login |
| Play Console → App content → Privacy policy | The URL |
| App Store Connect → App Information | The URL |
| Inside the app | A "Privacy policy" link in the server picker (guideline 5.1.1(i)). A small `agora-mobile` change, made once the URL is live |

### 4.3 Account deletion page (Play requirement)

Drafted: [docs/delete-account.md](../delete-account.md). Publish it at `https://agora.host/delete-account` and give that URL in Play Console's account deletion field. It explains:
- that the account lives on the user's server;
- the in-app and browser path (Settings → Account & security → Delete account);
- to ask the operator if they can't sign in;
- how to remove relay records;
- the contact for the demo server.

Google requires the web link because the app shows the instance's sign-up page, whoever runs the instance. The page only points to deletion; Caffeinated Software deletes nothing on instances it doesn't run.

## 5. Reviewer demo instance (proposal, waiting for Eryk's go)

Nothing below has been created.

**Where:** `https://demo.agora.host`, a small Agora stack (`docker-compose.prod.yml`) on its own VPS. It should not share a host with the relay: the demo has public logins, and the relay holds the FCM and APNs keys. It should not be the WSL live instance either, which gets wiped and sits behind Tailscale. The demo needs no gVisor, because code runs stay off.

**Settings:**
- Registration `invite_only`, so strangers can't sign up.
- Allowed relays: `["https://push.agora.host"]`.
- No AI provider keys, so nothing can spend money.
- Code runs off. Small file quota.
- Account deletion setting: `anonymize`.

**Content:**
- A server, "Agora Demo", with `#general` and a thread or two.
- A task board with a card in Review.
- A scripted **demo-bot**: a bot token plus a small script, no AI model.

**Accounts** (passwords generated and kept in Eryk's password manager, never in the repo or chat):
- `reviewer`: owner of "Agora Demo", so it gets approval notifications.
- `reviewer-delete`: a second account for testing account deletion, so deleting it doesn't lock out the next reviewer.

**How the reviewer gets a notification:**
- Posting `@demo-bot ping` makes the bot reply with `@reviewer` (a `mention` push).
- Posting `@demo-bot approval` makes the bot post a run approval card (an `approval` push). On iOS that push carries Approve…/Deny…. Reuse the script from the 2026-10-30 device test that filed a real approval.
- On iOS, the reviewer may need to background the app to see the banner.

**Reset:** a nightly job re-creates both reviewer accounts and the demo content, so a review that deleted `reviewer-delete` or changed settings doesn't break the next one.

**Review notes:** fill in `<demo URL>`, `<reviewer>` and `<step>` in the README's review note, in both consoles.

**Privacy:** Caffeinated Software runs this instance, so the policy covers it ("If we run an instance ourselves").

## 6. Push relay deployment (`push.agora.host`)

Do this before any store build goes to testers outside the team: store builds register with `https://push.agora.host`, built in from `app.config.json`. The steps follow `agora-push-relay/README.md` → Deploying, with the store-specific checks added.

### 6.1 Before deploying

1. **Host:** a small Linux VPS with Docker, its own host (not the demo or a dev machine). Firewall: 22 (SSH, keys only), 80 and 443 in; nothing else.
2. **DNS:** an `A`/`AAAA` record for `push.agora.host` pointing at the VPS. agora.host stays on Cloudflare Pages; this record is separate. If Cloudflare proxies it (orange cloud), set SSL/TLS to Full (strict). Otherwise use DNS only and let Caddy get the certificate.
3. **FCM credentials:** in Google Cloud for project `agora-ff0ca`, create a dedicated service account with only the **Firebase Cloud Messaging API Admin** role, and make a JSON key for it. Avoid the default `firebase-adminsdk` account: it has far broader rights. The project must match the `google-services.json` built into the Android app.
4. **APNs credentials:** an APNs auth key (`.p8`), with its Key ID and the Team ID. Set `APNS_ENVIRONMENT=production`: TestFlight and App Store builds use production. Xcode debug builds use the sandbox and will fail against this relay (`BadDeviceToken`). For debug testing, run a second relay with `sandbox`.
5. **`APNS_BUNDLE_ID`** = `com.caffeinatedsoftware.agora`, the default in `.env.example`.

### 6.2 Deploy

1. `git clone` the repo on the VPS (or `git pull`). Check out the release tag.
2. Put `fcm-service-account.json` and `apns-key.p8` in `agora-push-relay/secrets/`. Run `chmod 700` on the directory and `chmod 600` on the files. If your user isn't uid 1000, `chown 1000:1000` the files.
3. `cp agora-push-relay/.env.example agora-push-relay/.env`. Set `RELAY_SECRET_KEY=$(openssl rand -hex 32)`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` and `APNS_ENVIRONMENT=production`. Leave `RELAY_TRUST_PROXY=true`.
4. **Back up `RELAY_SECRET_KEY`** off the host, for example in the password manager. Without it, every handle is lost.
5. `docker compose -f docker-compose.relay.yml up -d --build`.
6. Install Caddy on the host with this config. Leave the `log` directive out, so client IPs aren't logged; the privacy policy says IPs aren't stored:

   ```
   push.agora.host {
       reverse_proxy 127.0.0.1:8787
   }
   ```

### 6.3 Checks (all must pass)

| # | Check | Expect |
|---|---|---|
| 1 | `curl -s https://push.agora.host/healthz` | `{"status":"ok","providers":{"android":true,"ios":true}}` |
| 2 | `docker compose -f docker-compose.relay.yml logs push-relay \| head` | The startup line shows both providers; no errors |
| 3 | From outside: `curl -s -o /dev/null -w '%{http_code}' http://<vps-ip>:8787/healthz` | Connection refused. The port is loopback only |
| 4 | `curl -s -X POST https://push.agora.host/v1/push -H 'Authorization: Bearer x' -H 'Content-Type: application/json' -d '{}'` | `400` or `401`, not `5xx` |
| 5 | Android end to end: an internal-testing build, add a 0.3.5+ instance whose allowed relays include `https://push.agora.host`, sign in, allow notifications, have another account @mention you | The notification arrives; the relay logs `sent_android` |
| 6 | iOS end to end: a TestFlight build, same steps | Arrives; the relay logs `sent_apns`. This is the first iPhone test, if a tester has one |
| 7 | Tap the notification | Opens the right channel or thread |
| 8 | Sign out in the app | The device leaves Settings → Account & security; the relay logs a `DELETE /v1/handles` `204` |
| 9 | Log hygiene: grep the relay logs for the instance hostname and for `Bearer` | No matches |
| 10 | Monitoring: an uptime check on `/healthz` (any free monitor), alerting Eryk | Set up |

### 6.4 After it's live

- Instances opt in by adding `https://push.agora.host` under Instance settings → App push. It is off by default.
- Rotate the FCM and APNs keys if anyone with access leaves; the steps are in the relay README under Operator duties.
- Upgrade: `git pull`, then the same `up -d --build`. Back up the `relay-data` volume first.

## 7. Submission order

1. Apps created in Play Console and App Store Connect (section 1, item 1). The bundle ID is confirmed.
2. Relay live, checks 1–4 (6.3).
3. Privacy policy and deletion page published (4.2, 4.3). Privacy link added to the picker.
4. iOS: privacy manifest added (3.1), first Xcode build, TestFlight internal testing. Checks 5–8.
5. Demo instance up (5), reviewer flows tried on both platforms.
6. Data safety and privacy label filled in (2, 3). Listings and screenshots.
7. Play closed testing (new personal developer accounts need 12 testers for 14 days before production access; check whether that applies to the Caffeinated Software account). TestFlight external testing (Beta App Review).
8. Production review on both stores.

## 8. Found while writing this

- **Account deletion doesn't tell the relay.** `src/lib/account-deletion.ts:129-132` deletes the person's `push_devices` rows, but it doesn't call the relay's `DELETE /v1/handles` the way `DELETE /me/push-devices/:id` does after commit (`src/routes/notifications.ts:219`). The relay rows then wait for the 365-day prune. The policy states this as it is today. Fix: decrypt the handles before the delete and forget them after commit, then shorten the policy's retention note.
- The privacy policy link in the picker (4.2) is a small `agora-mobile` change, made once the URL exists.

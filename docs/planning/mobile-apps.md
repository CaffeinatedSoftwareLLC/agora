# Agora Android and iOS apps

> **Status:** Draft step 0, 2026-10-24. Not agreed. The questions in section 7 need Eryk's answers before work starts.
> **Branch:** `docs/mobile-apps-plan`

## 1. Goal

Agora on the Play Store and the App Store, so that an owner can steer agents from a phone and **get told when an agent needs them**: an approval waiting, a mention, a blocked session, a card ready for review. The responsive web UI already covers steering; what is missing is notifications.

Today there is no notification system at all: no service worker, no web app manifest, and no notification code in `agora-ui/src` (checked on `main` at 2c21e67). Most of this plan is about building one. The store apps sit on top of it.

## 2. Approach: a Capacitor shell that loads the instance

Use **Capacitor** to wrap the user's own Agora instance in a native WebView, with native push, rather than rebuilding the UI in React Native or Expo.

**Why load the instance URL instead of bundling the UI into the app:**
- The session cookie is `SameSite=Strict` (`src/auth/session-cookie.ts:82`). A bundled UI runs from `capacitor://localhost` or `https://localhost`, which is cross-site to the instance, so the cookie would not be sent. Login would need a separate token flow.
- Loading the instance origin keeps everything same-origin. Login, sockets and uploads work unchanged.
- Each instance can be a different Agora version, and the UI always matches its own server.

**What the shell adds:**
- A first-run "Which Agora server?" screen, a saved list of servers, and a switcher between them.
- Navigation locked to that origin. Other links open in the system browser.
- Native push registration.
- Microphone permission for push-to-talk: Android `RECORD_AUDIO`, and iOS `NSMicrophoneUsageDescription` with WebView `getUserMedia` bridging.
- Deep links from a notification to the right channel, thread or approval card.

**Constraint:** the instance must be served over HTTPS, because the cookie is `Secure`. A Tailscale instance needs its tailnet certificate (`docker-compose.tailnet.yml`). The phone's VPN handles routing, and the app needs nothing Tailscale-specific.

## 3. Phases

### Phase 1: Notification events on the server (about 1–2 days)
- A `notifications` table, plus a per-user preference for each type. Notifications are created inside the request transaction and emitted after commit, like every other event.
- **Types:**
  - A run, tool or permission approval is waiting for you. This goes to the owner or directors who can approve it.
  - You were @mentioned.
  - A session is blocked, out of budget or out of credit.
  - A task card moved to Review.
  - An `agora-collab` DONE or BLOCK in a thread you started.
- **In-app:** an unread badge and an inbox list. This replaces the placeholder notifications in the UI.
- **Payloads carry no message text.** Each payload has a type, a channel or thread ID and a short label such as "Approval waiting in #general". The client fetches the details itself.

### Phase 2: Web push (dropped)
- Eryk has the store accounts, the signing setup and a Mac, so notifications go native-only.
- Browser push (a service worker with VAPID keys) can be added later if self-hosters ask for it.

### Phase 3: Push relay (about 1 day)
- Self-hosted instances cannot hold Caffeinated Software's FCM and APNs signing keys. Instead, a small relay run by Caffeinated Software holds them and forwards pushes. Mastodon and Matrix (Sygnal) work the same way.
- **Registration:** the app registers with the relay and gets an opaque push handle. It gives the instance only that handle, never the raw FCM or APNs token.
- **Sending:** the instance POSTs `{handle, type, label, deep link}` to the relay. A handle is bound to one instance, so a leaked handle cannot be used to spam from elsewhere. The relay is rate-limited per handle.
- **Content-free:** the relay never sees message text, so all it can log is that some instance pinged some device.
- **Opt-in:** relay use is a setting on each instance, off by default. Self-hosters who don't trust the relay can stay on web push.

### Phase 4: Native shells (about 2–3 days, plus review time)
- A new package `agora-mobile/` (Capacitor 7), containing the server picker, the push plugin, deep links and the microphone permission.
- **Notification actions:** Approve and Deny buttons on approval notifications. Tapping one opens the card. It never approves blind, so passkey step-up (#78) still applies.
- **Android:** builds on Windows with Android Studio. Release goes through Play Console internal testing, then closed testing, then production.
- **iOS:** needs Xcode, which means macOS: a Mac, or a cloud macOS runner (GitHub Actions or Codemagic). Release goes through TestFlight, then review.

### Phase 5: Store requirements (about 1–2 days)
- **In-app account deletion.** Apple requires it for apps where users can create an account. Agora has registration but no self-service deletion.
- **Privacy policy** and data disclosures (Apple privacy labels, Play Data safety). With content-free pushes the disclosures stay small.
- **Demo instance with a reviewer login.** Without it, Apple review can't sign in and will reject the app.
- **Guideline 4.2 (minimum functionality):** a website in a shell gets rejected. Native push, notification actions and the microphone are the native value. Describe them in the review notes.
- **Not-affiliated wording** in the store listings, the same as in the README and UI.

## 4. Order

The phases depend on each other in a chain:
- Phase 1 must come before Phase 2.
- Phase 2 is shippable on its own.
- Phase 3 and Phase 4 can be built in parallel.
- Phase 5 must be done before any store submission.

## 5. Security notes

- The WebView only loads the configured instance origin. No remote JavaScript bridge reaches pages outside it.
- Push payloads carry no secrets and no message text. Deep links are validated against the saved server list.
- The device push token stays in the app's native code. Instance pages ask native code to register (section 8); the instance origin sent to the relay is the one the WebView reports for the calling page, so a saved server cannot get a handle for another one.
- Signing keys (the Android keystore, Apple certificates, FCM and APNs credentials) stay with Eryk and the relay host. They are never committed, never sent to Agora instances, and never pasted into chat.

## 6. Not doing

- **A React Native or Expo rewrite.** It would duplicate a UI that already works on phones.
- **Bundling the UI into the app.** That runs into the cookie problem described in section 2.
- **Message text in pushes.** Keeping pushes content-free keeps the relay out of scope for privacy.

## 7. Decisions (2026-10-24)

- Eryk has the Apple and Google developer accounts, the signing setup, Firebase and APNs access, and a Mac for iOS builds.
- Web push is dropped; see Phase 2.
- Phases 1, 3 and 4 are built in parallel against the contract in section 8.
- **Account deletion (Phase 5):** each instance's owner decides what happens to a deleted account's messages, not Caffeinated Software, so it is an instance setting with two choices: remove the messages, or anonymise them. Deletion itself is always available in the account page, in the browser and in the app.
- **Release scope:** any self-hosted instance, after thorough testing.
- **Relay:** a separate small server at `push.agora.host`. agora.host is a Cloudflare Pages site, so it cannot run the relay.
- **Bundle ID:** `com.caffeinatedsoftware.agora`, pending Eryk's confirmation.

## 8. Contract between the three parts

The three parts are developed in parallel, so they agree on only these shapes. A change to any of them must be made in all three branches.

### Push relay (`agora-push-relay/`, run by Caffeinated Software)

**`POST /v1/register`**, called by the app's native code, never by page JavaScript:
- Body: `{ platform: "android" | "ios", token: string, instance: "<https origin>", previous?: string }`
- `instance` is the origin of the instance page that asked, as the WebView reports it. The relay trusts it, which is why pages never see the token or choose `instance`.
- Response: `201 { handle: string }` for a new handle, or `200 { handle: string }` when it hands back `previous`.
- The handle is 43 base64url characters (32 random bytes). The relay stores the device token, the platform and the instance origin under it.
- `previous` is the handle the app already holds for this instance. The relay returns it again (`200`, and counts it as seen for the TTL prune) only if it exists, can still be decrypted, and was registered with the same platform, token and instance. Otherwise it issues a new random handle (`201`) and leaves `previous` as it was. So a handle the relay pruned, lost with its database, or can no longer decrypt after a key change is replaced on the next registration instead of being reused forever.
- Without a matching `previous`, every call returns a new random handle. Earlier handles stay valid until `DELETE /v1/handles`, a provider `410`, or the relay's TTL prune.
- So the app calls the relay on every `registerPush`, sending the handle it stores for that instance as `previous`. It stores the handle it gets back with a SHA-256 of the token, and when that differs from the stored one it deletes the old handle (best effort; `204` even if the relay no longer knows it). The instance keeps one device row per handle, so keeping one handle per instance avoids duplicate rows and duplicate pushes.

**`POST /v1/push`**, called by an instance:
- Header: `Authorization: Bearer <handle>`
- Body: `{ instance: "<https origin>", type: string, title: string, body: string, url: string }`
- The `title` and `body` are short labels, never message text. Each is at most 120 characters.
- The `url` is a UI path on the instance: `/app/<channelId>`, or `/app/<channelId>?thread=<threadId>` to open a thread. `/channels/...` is an API route and would load JSON.
- Responses:
  - `202` when accepted.
  - `401` for an unknown handle.
  - `403` when `instance` does not match the origin the handle was registered with.
  - `410` when Apple or Google reports the device token is gone. The relay deletes the handle, and the instance should delete it too.
  - `429` when rate-limited. The limit is per handle, 30 a minute.

**What reaches the phone** (agreed between the relay and the app during the build):
- A notification with the `title` and `body`, plus data keys `{type, url, instance}`.
- On Android, it goes to notification channel `agora`.
- On iOS, approvals get category `AGORA_APPROVAL` (when `type` is `"approval"`). That category adds Approve…/Deny… buttons, which open the card and never approve directly.
- Android has no buttons for now, because that would need data-only FCM messages.

**`DELETE /v1/handles`**:
- Header: `Authorization: Bearer <handle>`
- Response: `204`.

**Logging and credentials:**
- The relay stores and logs no payload text, only counts.
- Credentials come from environment variables pointing at files: FCM HTTP v1 service-account JSON, and an APNs `.p8` token key with key ID, team ID, bundle ID and environment.

### Instance API (server)

**`POST /me/push-devices`**, authenticated by the session cookie:
- Body: `{ relay: "<https origin>", handle: string, platform: "android" | "ios", label: string }`
- Response: `201 { id }`
- It is accepted only if `relay` is in the instance's allowed relays. That admin setting defaults to empty, meaning push is off.

**`GET /me/push-devices`** lists the user's devices. **`DELETE /me/push-devices/:id`** removes one, and the instance also calls the relay's `DELETE /v1/handles`.

**Sending:** a notification enqueues one send per device of each recipient after the request commits. The instance treats a relay `410` by deleting the device.

### Native bridge (exposed by the app, used by `agora-ui`)

When the UI runs inside the app, the page has an object `window.AgoraNative`:

```ts
interface AgoraNative {
  platform: 'android' | 'ios';
  version: string;
  // Native code asks for notification permission if needed and registers this page's origin
  // with the relay, naming the handle it already holds for that origin as `previous`.
  // Resolves null if permission is denied. The device token never reaches the page.
  registerPush(): Promise<{ relay: string; handle: string; platform: 'android' | 'ios'; label: string } | null>;
  // Deletes the handle at the relay, only if it is the one stored for this page's origin.
  unregisterPush(handle: string): Promise<void>;
}
```

**The UI:** after login, if `window.AgoraNative` exists and the user has not turned app notifications off, it calls `registerPush()` once per session. It POSTs the result to `/me/push-devices`, and it calls `unregisterPush` on logout.

**The app:** tapping a notification opens its `url` on the instance that sent it.

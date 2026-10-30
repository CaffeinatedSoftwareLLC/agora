# Privacy policy: Agora apps and push relay

> **Draft, not yet published.** Effective date: `<YYYY-MM-DD>`. Contact: `<privacy contact address>`. Both are filled in when the policy goes live. The public copy belongs at `https://agora.host/privacy` (see "Where this policy is hosted" at the end).

This policy covers the **Agora apps for Android and iOS** and the **Agora push relay** (`push.agora.host`), both run by Caffeinated Software LLC ("we"). It does not cover the Agora servers the apps connect to. Those are run by whoever set them up.

Agora is not affiliated with Anthropic, OpenAI or Google.

## The short version

- The app is a window onto **an Agora server you choose**. Your account, messages, files and voice clips go to that server, not to us. Whoever runs that server decides how it keeps them.
- To send you notifications, we keep your phone's **push token** and the **address of the Agora server** that notifies you. We store both encrypted. We don't learn who you are.
- Notifications carry **short labels**, such as "Approval waiting in #general". They never carry message text.
- No ads. No analytics. No tracking. No crash reporting. We don't sell or share data.

## 1. Who runs what

| Part | Run by | What it holds |
|---|---|---|
| The app on your phone | You (installed from the store) | The list of servers you added, plus one push handle per server |
| An Agora server (an "instance") | Its **operator**: you, your employer, or whoever gave you the address | Your account, messages, files, settings, and a record of your phone for notifications |
| The push relay | Caffeinated Software | Your phone's push token and the instance's address, encrypted |
| Google Firebase Cloud Messaging (Android) and Apple Push Notification service (iOS) | Google and Apple | What they need to deliver a notification to your phone |

Agora is self-hosted software. **We have no access to an instance we don't run**, and we can't see, change or delete data on it. For anything about your account or messages on an instance, ask its operator. If we run an instance ourselves (for example, the demo server we give app reviewers), this policy covers that instance too.

## 2. What the app keeps on your phone

- **Saved servers:** the address and name of each Agora server you add.
- **Push handles:** for each server that has notifications turned on, an opaque handle from the relay. The app also keeps a fingerprint (SHA-256 hash) of the push token the handle was issued for, so it notices when the token changes.
- **The instance's own data**, cached by the in-app browser the way any browser caches a website: your session cookie and page data. It belongs to that server.

All of this stays on the phone. Uninstalling the app removes it.

**Permissions the app asks for:**
- **Notifications**, so it can show alerts.
- **Microphone**, only when you use push-to-talk. Audio is recorded only while you hold or tap the microphone button. The clip goes to the Agora server you are using, which turns it into text. If that server's operator has turned on the device's own speech recognition instead, the audio is processed by Google or Apple's speech service. The app never uses the camera.

## 3. What the push relay keeps

When you allow notifications for a server, the app's native code registers with the relay. The page you're viewing can't do this itself. The relay stores one record for each phone and server:

| Field | How it's stored |
|---|---|
| Platform (`android` or `ios`) | Plain text |
| Your phone's push token (from Google or Apple) | Encrypted (AES-256-GCM) |
| The address of the instance, such as `https://agora.example.com` | Encrypted, together with the token |
| A SHA-256 hash of the push handle | The handle itself is never stored |
| When the record was created and when it was last used | Timestamps |

The relay holds **no name, email, username, account ID or message content**. It can't tell which person on an instance a record belongs to.

**When an instance sends a notification**, it gives the relay a type (such as `approval`), a short title, a short label (each at most 120 characters) and a link into the instance. The relay passes them to Google or Apple and keeps nothing. Agora instances send labels, not message text. A modified instance could put other text in those 240 characters, and Google or Apple would see it in transit.

**Logs:** for each request, the relay logs the route, the result code, an outcome such as "sent" or "token gone", and how long it took. Once an hour it logs a count of outcomes. It never logs push tokens, handles, instance addresses, notification text or IP addresses. To limit abuse, it counts registrations per IP address in memory for one minute and stores no IP address.

**Retention.** A relay record is deleted when any of these happens:
- You sign out of the instance in the app, remove the phone under Settings → Account & security, or remove the server from the app's server list. The relay is told at once.
- Google or Apple tells us the token no longer works, for example after you uninstall the app. This happens on the next notification.
- The record goes **365 days** without being registered or used.

If you delete your Agora account (section 5), the instance deletes its record of your phone. The relay record then stops being used and is removed within 365 days. To remove it at once, sign out in the app or remove the server from the app before you delete the account.

Backups of the relay database are encrypted the same way as the database. The encryption key is kept separately.

## 4. What the instance keeps

The Agora server you connect to stores what any Agora account involves: your username, email address, password hash or passkeys, messages, files, settings and notification history. For notifications it also stores:
- the relay's address;
- the push handle, encrypted;
- the platform;
- a device label, such as "Pixel 8 (Android)" or "iPhone (iOS)";
- when the device was added and when it last received a notification.

It never stores your phone's push token. The device label is the model name. On iOS it is the generic model name, not the name you gave your phone.

The instance's operator controls this data, its retention and its backups. On instances we don't run, we never see it.

## 5. Deleting your data

- **Your account:** in the app or a browser, open **Settings → Account & security → Delete account**. What happens to your messages (removed or anonymised) is the instance operator's setting, and the page shows which before you confirm. The details are in [account-deletion.md](account-deletion.md).
- **Notifications for one server:** sign out, remove the phone under **Settings → Account & security**, or remove the server from the app. Any of these deletes the relay record at once.
- **Everything the app keeps on your phone:** uninstall the app.
- **The relay:** the steps above delete relay records. We can't look up a record by name or email, because the relay never holds them. Questions go to `<privacy contact address>`.

## 6. Sharing

We don't sell data, use it for advertising, or share it with data brokers. The only third parties are:
- **Google** (Firebase Cloud Messaging, Android) and **Apple** (APNs, iOS), which deliver notifications. They receive the push token and the notification's title and label.
- **The instance you connect to**, which receives what you send it as you use Agora.

We disclose data to authorities only when the law requires it. The relay has little to disclose: encrypted tokens and server addresses, and no identities.

## 7. Security

- Every connection uses HTTPS. The app only loads the servers you added, and other links open in your system browser.
- Push tokens never reach web pages. The instance only ever sees an opaque handle, and each handle works for one instance only.
- Relay records are encrypted at rest. Signing keys for Google and Apple are kept only on the relay host.

Report security problems through GitHub's private reporting: see [SECURITY.md](../SECURITY.md).

## 8. Children

The apps are developer tools and are not directed at children under 13 (or the minimum age in your country). We don't knowingly collect data from children.

## 9. Changes

We'll post changes here and update the effective date. Material changes are also noted in the app's release notes. The history of this file is public in the Agora repository.

---

### Where this policy is hosted (not part of the published text)

- **Public URL:** `https://agora.host/privacy`, on the Cloudflare Pages site. It must load without signing in, and stay up while the apps are listed.
- **Play Console:** App content → Privacy policy, and the store listing.
- **App Store Connect:** App Information → Privacy Policy URL.
- **In the app:** Apple asks for the policy to be easy to reach inside the app too (guideline 5.1.1). Add a "Privacy policy" link to the server picker. It opens in the system browser, as the navigation lock already does for outside links.
- **Repository:** this file stays the source. Copy changes to the site when the text changes.

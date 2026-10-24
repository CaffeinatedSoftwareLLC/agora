# Notifications

Agora tells a person when something needs them: an approval waiting, a mention, a blocked agent session, a task card ready for review, or a collaboration that finished or blocked. Notifications show under the bell in the web UI. With the Android and iOS apps, they can also arrive as pushes on a phone, through a push relay (see `docs/planning/mobile-apps.md`, sections 3 and 8).

A notification carries a type, a short label such as "Approval waiting in #general", and a link. It never carries message text. The person opens the link to see the details.

## Types

| Type | When | Who gets it |
|---|---|---|
| `approval` | A run approval card (Run request) is posted | The server owner |
| `approval` | A permission relay card is posted (Claude Code Channel) | The server owner |
| `approval` | A tool approval card is posted | The owner and every director of the channel. A live request on a `subscription` profile goes to the owner only, on a `siwc` profile to its plan owner only. |
| `approval` | A code run waits for approval | Members with Manage Bots or Administrator |
| `mention` | Someone @mentions a person by name, in a channel or a thread | The person mentioned, not the author. `@everyone` notifies nobody. |
| `session` | An agent session is shelved by its budget, hits its provider's usage or rate limit, fails a wake after its retries, or finishes a run without posting | The person who started the session, or the owner when nobody did or that account is no longer active |
| `review` | A task card moves to Review (by hand or when a pull request is opened) | The person who created the card, unless they moved it |
| `collab` | An `agora-collab` message with `STATE=DONE`, `STATE=BLOCK` or a `DECIDE` of `BLOCK` is posted in a thread | The person who started the thread, unless they wrote it |

The same rules apply to every type:

- Only active human accounts get notifications. Bots never do.
- A person who cannot see the channel gets nothing, whoever the source names.
- A person who switched the type off gets nothing.
- A repeat is dropped. If the same person already has an unread notification of the same type for the same channel and thread from the last 2 minutes, no new one is created.

## How it works

`notify()` and its helpers (`src/lib/notifications.ts`) run in the transaction of the action that caused the notification. The card, the post or the session change and its notifications commit together, or not at all. The helpers write as the service role, inside a savepoint. A failure rolls back only the notification and is logged, so it never fails the action itself.

For each recipient, `notify()` writes:

- one `notifications` row;
- one `push_outbox` row per push device, if the person has app push on and the device's relay is still allowed;
- a `pg_notify('agora_notifications', …)` with the notification.

Postgres delivers a NOTIFY only when its transaction commits. The API process LISTENs, and for each committed notification it emits `NotificationCreate` to the recipient's `user:<id>` room and wakes the push sender. This works the same whichever process wrote the notification: the API, the capability gateway or the runner. If the listener's connection drops, it reconnects after 5 seconds. A notification committed in that gap still shows when the bell opens, and its pushes go out with the next timer drain.

Reading a notification emits `NotificationRead` to the person's other tabs and devices, so their badges update.

## REST API

All routes are for people. Bots get 403 `humans_only`.

| Route | Does |
|---|---|
| `GET /me/notifications?limit&before&unread` | Newest first, `limit` 1-100 (default 30). `before` is a notification ID for the next page. Returns `{ notifications, unread, hasMore }`. |
| `POST /me/notifications/:id/read` | Marks one read. Returns `{ id, readAt, unread }`. |
| `POST /me/notifications/read-all` | Marks all read. Returns `{ updated, unread: 0 }`. |
| `GET /me/notification-preferences` | `{ types: { approval, mention, session, review, collab }, appPush }`, all `true` until changed. |
| `PUT /me/notification-preferences` | `{ types?, appPush? }`. Only the keys sent change. Returns the full preferences. |
| `POST /me/push-devices` | `{ relay, handle, platform, label }`, from the app's `registerPush()`. Returns 201 `{ id }`. |
| `GET /me/push-devices` | `{ devices: [{ id, relay, platform, label, createdAt, lastOkAt }] }`. The handle is never returned. |
| `DELETE /me/push-devices/:id` | Removes the device. After commit, the instance asks the relay to forget the handle (`DELETE /v1/handles`). |
| `GET /admin/settings/push` | Instance admins: `{ allowedRelays }`. |
| `PATCH /admin/settings/push` | Instance admins: `{ allowedRelays }`, up to 10 https origins. An empty list turns app push off. |

A notification is `{ id, type, label, url, serverId, channelId, threadId, readAt, createdAt }`. The `url` is a path in the web UI: `/app/<channelId>`, or `/app/<channelId>?thread=<threadId>` for a thread. The UI opens the thread panel from the `thread` parameter, then removes it from the address.

## App push

App push is off until an instance admin allows at least one relay (Instance settings → App push). The setting is `push.allowed_relays` in `instance_settings`.

**Registering a phone.** Inside the app, the page has `window.AgoraNative`. After sign-in, if the person has not turned app push off, the UI calls `registerPush()` once per login session and POSTs the result to `/me/push-devices`. The instance accepts it only if `relay` is an allowed https origin. It stores:

- the handle, encrypted with `AGORA_ENCRYPTION_KEY` (`encryptString` in `src/lib/encryption.ts`);
- a SHA-256 of the handle, to recognise the same phone registering again;
- the instance origin the app registered the handle for. This is the request's `Origin` header when it is https. Otherwise it is the first https origin in `CORS_ORIGIN`. Without either, the request fails with 400 `instance_origin_unknown`.

The relay hands out one handle per phone and instance. If another account registers the same handle, for example after a sign-out and a sign-in as someone else on the same phone, the device moves to that account, and sends still queued for the previous account are dropped. An account can have at most 20 devices.

**Signing out** in the app removes the device on the instance, then calls `unregisterPush(handle)`.

**Sending.** The push sender (`src/workers/push-sender.ts`) runs in the API process. It drains `push_outbox` when a notification commits, and every 15 seconds for retries. It leases rows with `FOR UPDATE SKIP LOCKED`, so two API processes never send the same row. For each row it POSTs to `<relay>/v1/push` with `Authorization: Bearer <handle>` and this body:

```json
{ "instance": "https://agora.example.com", "type": "approval", "title": "Approval waiting", "body": "Approval waiting in #general", "url": "/app/01J…" }
```

The `title` is fixed per type, and the `body` is the notification's label. Each is at most 120 characters. The relay's answer decides what happens next:

| Relay answer | Instance does |
|---|---|
| 2xx | Sets the device's `last_ok_at` |
| 410 | Deletes the device (the phone's token is gone) |
| 401, 403 | Deletes the device and logs a warning (the relay doesn't know the handle, or it was registered for another origin) |
| 429, 5xx, no answer | Retries after 30 s, doubling each time up to 15 min, or after the relay's `Retry-After` if that is longer. It gives up after 5 attempts. |
| any other status | Drops the send and logs a warning |

A send is also dropped if its notification is more than an hour old, the person turned app push off, or the device's relay is no longer allowed. The handle is never logged. Log lines name the device ID and relay only. Redirects from a relay are not followed.

## Security

- `notifications` RLS: a person can read, mark read and delete only their own rows. `app_user` cannot insert, because only the server writes notifications.
- `notification_preferences` RLS: own row only.
- `push_devices` RLS: a person can read and delete their own devices. Registration writes as the service role, so that a device can move between accounts.
- `push_outbox`: RLS on with no policies and no grants. Only the server reads it.
- The UI follows a notification's `url` only if it is a path on the same origin. The app validates it too: a relative path that starts with a single `/`.

## Not yet done

- Web push in browsers (dropped for now; see the plan).
- Approve and Deny actions on the notification itself. The app's buttons open the card instead.
- Old notifications are never pruned.

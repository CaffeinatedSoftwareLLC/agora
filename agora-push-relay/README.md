# agora-push-relay

A small service, run by Caffeinated Software, that sends push notifications to the
Agora Android and iOS apps on behalf of self-hosted Agora instances.

A self-hosted instance cannot hold Caffeinated Software's Firebase (FCM) and Apple
(APNs) signing keys. The relay holds them instead. The app registers its device
token with the relay and gets back an opaque **handle**; the instance only ever sees
the handle and sends `{type, title, body, url}` to the relay, which forwards it to
Google or Apple. Mastodon and Matrix (Sygnal) work the same way.

Plan and contract: `docs/planning/mobile-apps.md`, Phase 3 and section 8.

## API

| Call | Who calls it | Answers |
|---|---|---|
| `POST /v1/register` `{platform, token, instance}` | the app | `201 {handle}`, a new handle on every call; `400` bad body/origin/token; `429` per-IP limit; `503` platform not configured |
| `POST /v1/push` `{instance, type, title, body, url}` + `Authorization: Bearer <handle>` | an instance | `202`; `400`; `401` unknown handle; `403` `instance` is not the origin the handle was registered with; `410` the device token is gone (handle deleted); `413`; `429` (30/min per handle, `Retry-After`); `502` provider error, retry later; `503` platform not configured |
| `DELETE /v1/handles` + `Authorization: Bearer <handle>` | an instance or the app | `204` (also for an unknown handle); `401` no well-formed handle |
| `GET /healthz` | monitoring | `200 {status, providers: {android, ios}}` |

Errors are `{ "error": "<code>" }`. `title` and `body` are at most 120 characters,
`type` at most 64, `url` must be a path on the instance (`/channels/...`), bodies at
most 8 KiB. `/v1/register` and `/v1/handles` send `Access-Control-Allow-Origin: *`
so the app can call them from its WebView; `/v1/push` does not.

### What reaches the device

FCM HTTP v1:

```json
{ "message": { "token": "…",
  "notification": { "title": "…", "body": "…" },
  "data": { "type": "approval", "url": "/channels/…", "instance": "https://agora.example.com" },
  "android": { "priority": "HIGH", "ttl": "86400s", "notification": { "channel_id": "agora" } } } }
```

APNs (`apns-push-type: alert`, priority 10, expires after a day):

```json
{ "aps": { "alert": { "title": "…", "body": "…" }, "sound": "default", "category": "AGORA_APPROVAL" },
  "type": "approval", "url": "/channels/…", "instance": "https://agora.example.com" }
```

`category` is sent only when `type` is `approval`. `instance` is the origin stored at
registration, normalised (lowercase host, no trailing slash, default port dropped),
never the value in the push body. The app opens `instance + url` only for a saved
server.

## Privacy model

- **No message text.** Instances send short labels such as "Approval waiting in
  #general"; the app fetches details from the instance itself.
- **Nothing about a push is stored.** Title, body, URL and type pass through memory
  to the provider and are dropped.
- **Logs** carry, per request, the route, status, an outcome code (for example
  `sent_android`, `gone_apns_410_Unregistered`, `instance_mismatch`) and timing,
  plus an hourly line of outcome counts. Never payload text, device tokens, handles,
  instance origins or client IP addresses. A test checks this.
- **Handles** are bearer secrets. The database keys each registration by
  SHA-256(handle); the handle itself is never stored or logged.
- **Device tokens and instance origins** are encrypted at rest with AES-256-GCM,
  bound to their row. Only the platform is stored in the clear.
- **A leaked handle is bound to one instance**: pushes naming another origin get 403
  and do not use up the owner's rate limit.
- Handles neither registered nor pushed to for `RELAY_HANDLE_TTL_DAYS` (365) are
  deleted. A successful push keeps a handle alive.

### Storage and handles

SQLite through Node's built-in `node:sqlite` (Node 22.13+; no native build), one
`handles` table in the `relay-data` volume, WAL mode. `node:sqlite` is still flagged
experimental on Node 22 (the start command silences the warning), which is why the
Dockerfile pins an exact Node release (`node:22.23.4-alpine3.24`) in both stages
rather than following `node:22-alpine`. Move the pin on purpose and run the tests
when you do.

Every registration gets a **new random handle**: 32 random bytes, base64url, 43
characters. Only SHA-256(handle) is stored. Registering a token and instance that are
already registered issues another handle and leaves the existing ones as they are:
each stays valid until it is deleted (`DELETE /v1/handles`), the provider reports the
token gone (`410` on a push through it), or it is pruned after
`RELAY_HANDLE_TTL_DAYS` without a push. So:

- knowing a device token does not get you a handle someone else holds. Anyone who has
  a token can register it naming any origin (the relay cannot check that the caller
  speaks for that instance), but they only get a fresh handle of their own;
- registering cannot revoke anyone else's handle, because nothing replaces or deletes
  an existing row. Deleting needs the handle itself;
- the app should register when it gets a new device token, not on every launch, and
  give the instance the handle it got back. Handles it stops using expire after the
  TTL.

The alternative, re-registration replacing the earlier handle, was rejected because
it would let anyone holding the token revoke the instance's handle at will.

Before this change (0.1.0, never in production) handles were
`HMAC-SHA256(handleKey, instance, token)`, so registering the same pair returned the
same handle to whoever asked. The table, the seal key and the lookup are unchanged,
so rows written then still work and need no migration; their handles are simply
never handed out again.

`RELAY_SECRET_KEY` is expanded with HKDF into the encryption key. Changing it
orphans every registration: old handles answer `401` and each device needs to
register again and give its instance the new handle.

## Deploying (Caffeinated Software)

Needs a Linux host with Docker and a domain for the relay. The app expects it at
`relayUrl` in `agora-mobile/app.config.json` (`https://push.agora.host`).

1. **Credentials, outside git.** Put them in `agora-push-relay/secrets/` on the
   relay host (the directory is gitignored, as are `*.p8` files):
   - `agora-push-relay/secrets/fcm-service-account.json`: Firebase console →
     Project settings → Service accounts → Generate new private key.
   - `agora-push-relay/secrets/apns-key.p8`: developer.apple.com → Certificates,
     IDs & Profiles → Keys → a key with Apple Push Notifications service enabled.
     Note its Key ID and your Team ID.

   Then `chmod 700 agora-push-relay/secrets && chmod 600 agora-push-relay/secrets/*`.
   The container runs as uid 1000; if your user is not uid 1000, also
   `sudo chown 1000:1000 agora-push-relay/secrets/*`. Never paste these files into
   chat, an issue or an Agora instance.
2. **Settings.** `cp agora-push-relay/.env.example agora-push-relay/.env` and fill in
   `RELAY_SECRET_KEY` (`openssl rand -hex 32`, and keep a backup of it),
   `APNS_KEY_ID`, `APNS_TEAM_ID`, and check `APNS_BUNDLE_ID` and
   `APNS_ENVIRONMENT` (`production` for TestFlight and App Store builds). Every
   variable is described in that file.
   Only one platform ready? Clear the other's variables in `.env` and remove its two
   lines from `docker-compose.relay.yml` (see the comment at the top).
3. **Start it.** From the repo root:
   `docker compose -f docker-compose.relay.yml up -d --build`.
   It listens on `127.0.0.1:8787` only, read-only filesystem, no capabilities.
   `docker compose -f docker-compose.relay.yml logs push-relay` should show
   `providers` with `android: true` and `ios: true`.
4. **HTTPS.** Put a reverse proxy in front. With Caddy:

   ```
   push.agora.host {
       reverse_proxy 127.0.0.1:8787
   }
   ```

   `RELAY_TRUST_PROXY=true` (the default in `.env.example`) makes the per-IP limit
   use the proxy's `X-Forwarded-For`. Keep the port bound to `127.0.0.1` while it is
   `true`.
5. **Check it.** `curl https://push.agora.host/healthz` →
   `{"status":"ok","providers":{"android":true,"ios":true}}`.

Back up `RELAY_SECRET_KEY`: without it the database cannot be read. Losing the
database loses every handle: instances get `401` and each device has to register
again and hand its instance the new handle.

Upgrading: `git pull`, then the same `up -d --build`.

## Pointing an instance at the relay

On the instance, an admin adds the relay's origin to the allowed relays
(`PATCH /admin/settings/push` with `{"allowedRelays": ["https://push.agora.host"]}`;
see `docs/notifications.md` once the instance work lands). The list is empty by
default, which means app push is off. The app registers with the relay named in its
build, and the instance accepts a device only if that relay is allowed.

## Development

```bash
cd agora-push-relay
npm install
npm run check      # tsc on src and test
npm test           # vitest; no network, no credentials
npm run build
RELAY_SECRET_KEY=$(openssl rand -hex 32) RELAY_DB_PATH=./relay.db npm start
```

The tests generate throwaway RSA and P-256 keys and run local stand-ins for
Google's token endpoint, FCM and APNs (HTTP/2 cleartext). They never contact Google
or Apple.

## Not done yet

- No metrics endpoint; counts are only in the hourly log line.
- One process, in-memory rate limits: running several replicas would need a shared
  limiter.
- No key rotation tool for `RELAY_SECRET_KEY`.

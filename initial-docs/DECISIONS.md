# Agora — Decisions & Architecture

> **Living document.** Update this file as decisions are made in web chats or Claude Code sessions. CC reads this before every session to stay in sync.
>
> Last updated: 2026-02-26

---

## Identity

**Name:** Agora
**Tagline:** Self-hosted community chat. Your data, your hardware, your rules.
**Positioning:** Privacy-first Discord alternative for communities that want sovereignty. No government ID, no face scans, no 620-million-user data breaches.

---

## Core Architecture

### One Instance = One Community

Agora follows the **Slack/Mattermost model**, not the Discord model. A single Agora deployment IS the community — there are no "servers within servers." Channels exist within the instance, but there's no multi-tenant layer.

- The person who deploys the instance is the admin
- If someone else wants their own community, they deploy their own Agora instance
- The **client app** is the multiplexer — it maintains connections to multiple instances, displayed in the sidebar rail
- Each instance has its own URL, its own auth, its own channels
- Nothing stops a power user from running 10 instances behind a reverse proxy if they want to be a "platform" — that's an infrastructure choice, not an application concern

### Setup Flow

Follows the Rocket.Chat setup wizard pattern:

1. `docker compose up`
2. Setup token appears in logs (or set via `AGORA_SETUP_TOKEN` env var)
3. Hit `localhost:3000` → redirects to `/setup` (only available route)
4. Enter setup token → create admin account → name instance → set registration policy
5. All auth endpoints (register, login, WS gateway) return 503 until setup completes — no "first hit wins" vulnerability
6. Setup wizard permanently disabled after completion

### Single-Instance Architecture (Implemented 2026-02-17)

The codebase was migrated from a Discord-like multi-server model to a single-instance Slack model. Key decisions:

- The `servers` table remains as an **invisible singleton** — no schema migration, no RLS rewrite. The backend still uses servers/server_members/etc. under the hood.
- `instance_config` stores `instance_server_id` pointing to the singleton server, set during `POST /instance/setup`
- **Auto-join on registration:** `open` policy users are auto-added to the instance server on register. `invite_only` users join via invite (which points to the instance server). `approval` users are auto-joined when an admin approves them.
- **Frontend routing simplified:** `/app/{channelId}` for channels, `/app/dms/{channelId}` for DMs (no server segment in URL)
- **No server selection UI:** TabBar shows instance name + Messages tab. Channel sidebar always shows the singleton server's channels. No ServerRail, no HomeView, no ExploreView.
- The `POST /servers` endpoint still exists (used by tests) but is unexposed in the UI
- **Future: wrapper app** — a desktop/mobile client that connects to N independent Agora instances simultaneously, aggregating notifications locally. Each instance is unaware of the wrapper. Zero backend changes required — the existing REST + Socket.IO API is sufficient.

### Instance Status

`GET /instance/status` — unauthenticated endpoint returning `{ initialized, registrationPolicy, instanceName, instanceServerId }`. Client checks this on cold load to decide routing.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| API Server | Node.js + Fastify + TypeScript |
| Database | PostgreSQL 16 |
| Real-time | Socket.IO with Redis adapter |
| Cache/PubSub | Redis 7 |
| File Storage | MinIO (S3-compatible) — not yet integrated |
| Frontend | React 19 + Vite 7 + Tailwind v4 + Zustand |
| Voice/Video | LiveKit (self-hosted SFU) with built-in TURN |
| Containers | Docker + Docker Compose |

### Why This Stack

- Single combined API + WebSocket server (not microservices) — right simplicity tradeoff for current stage
- PostgreSQL over MongoDB because servers→channels→roles→permissions is deeply relational
- Socket.IO for real-time because the gateway pattern validates it and we can keep HTTP + WS on the same Fastify server

---

## Agora ID (v2 — Not Yet Built)

Optional Supabase-backed OAuth identity provider. A "passport" for Agora users.

- **Local auth is always the default.** Every instance ships fully self-contained.
- Instance admins **opt in** to enabling "Sign in with Agora ID"
- Standard OAuth redirect flow — instance gets a token, creates a local user record, skips the password step
- After initial OAuth dance, the instance never depends on Agora ID staying up — existing sessions work independently
- Agora ID stores: users, OAuth tokens, list of linked instances. **No message data, no channel data.**
- Future possibilities: public instance directory, portable profiles, community discovery

---

## Themes & Visual Identity

**Hard rule:** No Discord aesthetics. Discord's UI is actively hated right now. Lean into the Greek "Agora" identity.

### Aegean & Marble (Default)

| Role | Hex | Name |
|------|-----|------|
| Primary | `#0D5EAF` | Tech Blue |
| Accent | `#0FA3B1` | Pacific Blue |
| Background | `#241623` | Midnight Violet |
| Surface | `#332838` | Lighter Midnight Violet |
| Text | `#FDFFF7` | Porcelain |
| White | `#FCFCFC` | White |

### Terracotta & Stone (Alt)

| Role | Hex | Name |
|------|-----|------|
| Primary | `#C2703E` | Chocolate |
| Secondary | `#65743A` | Fern |
| Background | `#1C1410` | Coffee Bean |
| Surface | `#2A2018` | Lighter Coffee Bean |
| Text | `#EBF5DF` | Honeydew |
| Accent | `#D5FFF3` | Frozen Water (mint) |

---

## Security Decisions

- **Mentions:** Server-side resolution. Client sends message content with `@username` syntax; backend parses mentions, resolves usernames to user IDs (membership-gated), and stores in `message_mentions` table. `@everyone` increments `mention_count` for all channel members.
- **Permissions:** Discord-style model. Role overrides aggregated into single allow/deny pair, then `(base & ~aggregated_deny) | aggregated_allow`. Allow bits override deny bits within the same scope.
- **Setup token:** If env var set, use it. If not, generate 32-char token on first boot, write to data volume (`.agora/setup-token`), print to logs. Persisted to survive container restarts. Never regenerated.
- **Instance admin:** `is_instance_admin` boolean on users table. Only set by `/instance/setup`.

### Anti-Abuse (Implemented 2026-02-17)

- **Encrypted IP tracking:** User IPs recorded on register and login. Stored as HMAC (for lookups) + AES-encrypted (for admin display). Admins see decrypted IPs in the user table; the DB never stores plaintext IPs.
- **IP bans:** `ip_bans` table keyed by HMAC. Checked before `/auth/register` and `/auth/login` — returns 403 `ip_banned`. Supports optional expiration (`expires_at`). Upsert clears expiration on re-ban.
- **Rate limiting:** `@fastify/rate-limit` globally, with `/auth/register` specifically capped at 5 per hour per IP. Disabled in test mode.
- **Account suspension:** `account_status` field (`active`/`pending`/`suspended`). Suspended users cannot log in (403) and are force-disconnected from WebSocket via `pendingDisconnects`. Admin can suspend account + ban IP in one action.
- **Audit logging:** All admin actions (approve, reject, ban, IP ban, settings changes) logged to `audit_log` with actor, target, action type, and changes JSON.

### Security Hardening (Implemented 2026-02-20)

- **CORS lockdown:** Removed wildcard `*` CORS. Origin now set via `CORS_ORIGIN` env var (defaults to `http://localhost:5173` in dev).
- **Token revocation on logout:** `POST /auth/logout` blacklists the JWT `jti` in Redis with TTL matching token expiry. Auth middleware checks the blacklist on every request. WebSocket gateway also checks blacklist on connect.
- **No fallback credentials:** Removed hardcoded LiveKit API key/secret fallbacks. All secrets must be provided via env vars.

---

## E2EE Roadmap (DMs)

**Tier 1 — Encryption at rest (next):** Server-side encryption in Postgres using per-conversation key derived from server's master secret. Protects against database dumps/backup leaks. `pgcrypto` or `crypto.createCipheriv()`.

**Tier 2 — Client-side E2EE (future):** Web Crypto API with X25519 key agreement. Users publish public keys, sender does ECDH for shared secret, encrypt with AES-GCM. Real E2EE without full Double Ratchet complexity.

**Tier 3 — Signal-grade (if Agora takes off):** Full Double Ratchet, Matrix Olm/Megolm style. Major engineering effort.

**Schema design:** DM message body stored as `ciphertext` column with separate `key_id` reference, designed for Tier 2 upgrade path even when shipping Tier 1.

---

## Voice, Video & Calls (Implemented 2026-02-18 → 2026-02-26)

**LiveKit** is the SFU — open source (Apache 2.0), self-hostable, Go binary, Docker-friendly. Built-in TURN server enabled for NAT/mobile clients.

### Channel Voice/Video (Phases 1–3)

- **Phase 1 — Voice channels:** `POST /voice/token` generates LiveKit access token scoped to channel. `livekit-server` service in Docker Compose (dev + prod). Channel sidebar shows connected participants with real-time join/leave via Socket.IO. Voice channel type selectable in Create Channel modal.
- **Phase 2 — Video & screen share:** Video grid with responsive layout, screen sharing with audio capture, deafen toggle, device selector (mic/camera/speaker). Frontend unit tests with comprehensive LiveKit mocks (`agora-ui/src/test/livekit-mocks.tsx`).
- **Phase 3 — Admin controls:** Server-side `POST /voice/mute/:userId`, `/voice/deafen/:userId`, `/voice/undeafen/:userId` endpoints. Uses LiveKit REST API (`RoomServiceClient`) to set participant track permissions. Right-click context menu on voice participants (mute, deafen, disconnect). Permission-gated via `useVoicePermissions` hook. `LIVEKIT_INTERNAL_URL` env var for Docker-internal REST API (avoids prod 404s when public URL isn't reachable from the API container).

### DM Voice/Video Calls (Phase 4)

- **Ring/accept/decline flow:** `POST /dm-calls/start` initiates a call, emits `dm:call:incoming` Socket.IO event to recipient. Recipient can accept (`POST /dm-calls/:callId/accept`) or decline (`POST /dm-calls/:callId/decline`). 30-second ring timeout auto-cancels.
- **In-memory call state:** `src/call-state.ts` maintains three maps — `activeCalls` (channelId → call), `callIdToChannel` (reverse lookup), `userInCall` (prevents multi-call). Recipient isn't marked "in call" until they accept.
- **System messages:** Call events (missed, declined, ended with duration) written as messages with `system_event` column (migration 014). Displayed in chat history.
- **LiveKit room lifecycle:** Room created on call start, caller joins immediately. Recipient joins on accept. Room auto-cleaned by LiveKit webhook (`participant_left` / `room_finished`).
- **UI:** `IncomingCallOverlay` (ring animation, accept/decline buttons), `OutgoingCallOverlay` (ringing state, cancel button). Call store (`callStore.ts`) manages UI state.

**Note:** ngrok won't work for voice (WebRTC needs UDP ports). Voice requires a real box with public IP or the built-in TURN server. Messaging + signaling works through ngrok.

---

## Public Access / Tunneling

Agora is compatible with:
- **ngrok** — for quick demos and development
- **Cloudflare Tunnels** — for production self-hosting without port forwarding

The "Add Instance" flow in the client: user pastes a tunnel URL, authenticates against that host, instance appears in their sidebar rail.

---

## What's Built (as of 2026-02-26)

### Backend
- Auth: register, login, Argon2id, JWT
- Instance setup wizard with setup token, admin creation, registration policy (open/invite_only/approval)
- Auto-join: users are automatically added to the instance server on registration (open), invite redemption (invite_only), or admin approval (approval)
- Channels: text channels with CRUD (types: text, voice, forum — voice/forum are schema-ready but not feature-complete)
- Real-time messaging: send, edit, soft-delete via Socket.IO
- DMs with `dm_pairs` deduplication and speculative insert
- Emoji reactions: add/remove with idempotent upsert, real-time events
- Unreads: per-channel read markers with `last_read_id` + `mention_count`, ACK endpoint that only moves marker forward
- Mentions: server-side `@username` resolution (membership-gated) + `@everyone` support with per-user mention counts
- User search: prefix-matching endpoint (`GET /users/search?q=`)
- Roles: @everyone + custom with server-level bitmask permissions
- Row Level Security on all multi-tenant tables
- Per-request transaction lifecycle with RLS context
- Admin panel: user management (paginated, filterable, searchable), approve/reject/suspend, IP ban management, instance settings, audit logging
- Anti-abuse: encrypted IP tracking, IP bans with expiration, rate limiting, account suspension with forced WS disconnect
- WebSocket Ready event bootstraps full client state in one round-trip (servers, channels, unreads, online users)
- Post-COMMIT event emission: Socket.IO events queued during request, only emitted after transaction commits
- Voice channels: LiveKit integration with token generation, join/leave tracking, participant lists via Socket.IO
- Voice admin controls: server-side mute/deafen/undeafen via LiveKit REST API, permission-gated
- DM voice/video calls: ring/accept/decline flow, 30s timeout, in-memory call state, system messages for call history
- Security hardening: CORS lockdown, JWT blacklist on logout (Redis-backed), no fallback credentials
- Docker Compose for local dev (PostgreSQL 16 + Redis 7 + LiveKit)
- Production Docker Compose: multi-service stack (postgres, redis, livekit, migrate, api, web/nginx) with persistent volumes, Caddy reverse proxy for TLS
- 14 database migrations, 19 tables
- v0.0.1 public alpha release (AGPL-3.0 license)

### Frontend
- Arc V2-inspired UI with two palette themes (Aegean, Terracotta)
- Single-instance layout: TabBar (instance name + Messages), channel sidebar, content area, members sidebar
- Auth flow: login, register (with invite code support), pending approval page
- Admin dashboard: stats cards, user table (paginated, filterable by status, searchable), IP ban management, instance settings
- Instance setup wizard
- Real-time: messages, typing indicators, presence dots, reactions (bar + picker), @mention autocomplete
- Unread tracking with per-channel badges and mention counts
- DM sidebar with user search + new DM modal
- Message features: grouping by author/time, edit/delete, "new messages" pill, empty channel placeholder
- Members sidebar with online/offline status
- Invite generation + copy modal
- Channel creation modal
- Connection status indicator
- WebSocket-first state hydration via Ready event (no REST waterfall)
- Voice channels: join/leave UI, participant list in sidebar, voice control bar (mute, deafen, disconnect)
- Video grid with responsive layout, screen sharing with audio capture, device selector (mic/camera/speaker)
- Voice admin: right-click context menu on participants (mute, deafen, disconnect), permission-gated
- DM calls: incoming/outgoing call overlays with ring animation, accept/decline/cancel buttons
- Call history as system messages in DM chat

---

## Deferred (Explicitly Not Now)

- File uploads / image attachments (MinIO integration — `files` table exists but no endpoints)
- Message search (no full-text search)
- Custom emoji
- Threads / forums
- ~~Voice / video~~ — **Implemented** (Phases 1–4, see above)
- User profiles (display_name, avatar, banner, bio columns exist but no endpoints)
- Role management UI (permission system built in backend, no frontend)
- Friend / block relationships (table exists but no endpoints)
- E2EE for DMs
- Federation between instances
- Bot API
- Mobile client
- Wrapper app (multi-instance aggregator)

---

## Competitive Landscape Notes

### vs Discord
Privacy crisis (age verification, data breaches), universally hated UI redesign, broken moderation. Users actively searching for alternatives.

### vs Revolt/Stoat
7-service Docker nightmare, Rust = tiny contributor pool, MongoDB for relational data, complex dev setup, voice barely works.

### vs Fluxer
Polyglot microservice architecture (10+ services, 91 commits, still beta), self-hosting docs "coming soon," no E2EE.

### Agora's Differentiators
1. `docker compose up` → chatting in 2 minutes
2. Clean ownership model (deploy it = own it)
3. Non-Discord aesthetic (Aegean/Terracotta)
4. E2EE roadmap for DMs
5. Node/TypeScript = accessible contributor pool

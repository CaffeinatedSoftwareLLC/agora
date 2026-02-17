# Agora — Decisions & Architecture

> **Living document.** Update this file as decisions are made in web chats or Claude Code sessions. CC reads this before every session to stay in sync.
>
> Last updated: 2026-02-17

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
| File Storage | MinIO (S3-compatible) |
| Frontend | React + Vite + TypeScript + Zustand |
| Voice/Video | LiveKit (future) |
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

- **Mentions:** MVP-insecure with client-trusted arrays. Flagged explicitly — not shipped pretending it's production behavior.
- **Permissions:** Discord-style model. Role overrides aggregated into single allow/deny pair, then `(base & ~aggregated_deny) | aggregated_allow`. Allow bits override deny bits within the same scope.
- **Setup token:** If env var set, use it. If not, generate 32-char token on first boot, write to data volume (`.agora/setup-token`), print to logs. Persisted to survive container restarts. Never regenerated.
- **Instance admin:** `is_instance_admin` boolean on users table. Only set by `/instance/setup`.

---

## E2EE Roadmap (DMs)

**Tier 1 — Encryption at rest (next):** Server-side encryption in Postgres using per-conversation key derived from server's master secret. Protects against database dumps/backup leaks. `pgcrypto` or `crypto.createCipheriv()`.

**Tier 2 — Client-side E2EE (future):** Web Crypto API with X25519 key agreement. Users publish public keys, sender does ECDH for shared secret, encrypt with AES-GCM. Real E2EE without full Double Ratchet complexity.

**Tier 3 — Signal-grade (if Agora takes off):** Full Double Ratchet, Matrix Olm/Megolm style. Major engineering effort.

**Schema design:** DM message body stored as `ciphertext` column with separate `key_id` reference, designed for Tier 2 upgrade path even when shipping Tier 1.

---

## Voice & Screen Sharing Roadmap

**LiveKit** is the chosen SFU — open source (Apache 2.0), self-hostable, Go binary, Docker-friendly.

Integration pattern:
1. Add `livekit-server` service to `docker-compose.yml`
2. `POST /api/voice/token` endpoint generates LiveKit access token scoped to channel
3. `<VoiceChannel />` React component using `@livekit/components-react`
4. Screen sharing is a prop toggle in their React SDK

**Note:** ngrok won't work for voice (WebRTC needs UDP ports). Voice requires a real box with public IP or a TURN server. Messaging + signaling works through ngrok.

---

## Public Access / Tunneling

Agora is compatible with:
- **ngrok** — for quick demos and development
- **Cloudflare Tunnels** — for production self-hosting without port forwarding

The "Add Instance" flow in the client: user pastes a tunnel URL, authenticates against that host, instance appears in their sidebar rail.

---

## What's Built (as of 2026-02-17)

### Backend
- Auth: register, login, Argon2id, JWT
- Instance setup wizard with setup token, admin creation, registration policy (open/invite_only/approval)
- Auto-join: users are automatically added to the instance server on registration (open), invite redemption (invite_only), or admin approval (approval)
- Channels: text channels with CRUD
- Real-time messaging: send, edit, soft-delete via Socket.IO
- DMs with `dm_pairs` deduplication and speculative insert
- Roles: @everyone + custom with server-level bitmask permissions
- Row Level Security on all multi-tenant tables
- Per-request transaction lifecycle with RLS context
- Admin dashboard: user management, approve/reject/suspend, instance settings
- WebSocket Ready event bootstraps full client state in one round-trip
- Docker Compose local development stack

### Frontend
- Arc-inspired UI with two palette themes (Aegean, Terracotta)
- Single-instance layout: TabBar (instance name + Messages), channel sidebar, content area, members sidebar
- Auth flow: login, register (with invite code support), pending approval page
- Admin dashboard with user management
- Instance setup wizard
- Real-time: messages, typing indicators, presence dots, reactions
- Unread tracking with per-channel badges
- DM sidebar with search
- WebSocket-first state hydration via Ready event (no REST waterfall)

---

## Deferred (Explicitly Not Now)

- File uploads / image attachments
- Message search
- Custom emoji
- Threads / forums
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

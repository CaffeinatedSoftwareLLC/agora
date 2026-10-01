# Sandbox Isolation Spec & Threat Model

> **WBS 3.1**: sign-off gate for the sandboxed runtime (3.2–3.9). **Status: APPROVED 2026-09-29** (answers recorded in §0 and §18).
> **Date:** 2026-09-29 · Builds on `ai-runtime-execution-plan.md` and the provider registry (Phase 1).
> **Amended 2026-10-01 (#32):** the bundled MinIO service was replaced by a `files-data` volume mounted in `api` and `cap-gateway`. References to MinIO below were updated; each change is marked *(amended #32)*. No decision in §0 changes: sandboxes still hold no secrets and no mounts, and artifacts still leave only through the gateway.

## 0. Decisions to sign off

Approving this document approves these decisions. Anything struck out or changed here changes the build.

| # | Decision | Rationale (section) |
|---|---|---|
| D1 | Every run executes in a **fresh container on gVisor (`runsc`)**. Production refuses to run code without gVisor. | §4, §15 |
| D2 | **The network is the security boundary, not Deno.** Sandboxes sit on an internal-only Docker network whose only reachable host is a capability gateway. There is no internet route. | §6, T3 |
| D3 | **Sandboxes never hold provider keys or Agora secrets.** Capabilities (`search()`, `generateImage()`, …) are served by the gateway using a short-lived per-run token. | §7 |
| D4 | A dedicated **`runner` service is the only holder of the Docker socket**. `api` never gets it. Untrusted code never executes inside `runner`. | §3, T9 |
| D5 | **Artifacts leave only through the gateway** (`postFile()`), validated by the existing file pipeline. Nothing is copied out of the container filesystem. | §11 |
| D6 | **Every run passes the decision gate first.** Human approval is the default; auto-run is granted **per bot** by an admin *(confirmed 2026-09-29)*. A model verdict (e.g. Jev) can never loosen limits. | §10, T11 |
| D7 | Default limits: **1 vCPU · 512 MB RAM · 128 PIDs · 60 s wall clock · 64 MB scratch · 20 capability calls per run · 2 concurrent runs per server**. Runs that request generation capabilities get a longer time profile (§8.1) *(confirmed 2026-09-29)*. Instance admins can change them, up to hard ceilings. | §8 |
| D8 | **Dev on Windows/macOS runs with `runc`** behind an explicit `AGORA_SANDBOX_INSECURE_DEV=1` flag, a loud log line and a UI banner. That is never acceptable for prod. | §15 |
| D9 | **Submitted code is pruned** after a retention period (default 30 days) and only its hash and metadata are kept. Users are told the deletion date up front and warned before retention is shortened (§9.1) *(confirmed 2026-09-29)*. | §9.1 |

## 1. Scope

**Goal:** agents (bots) and the built-in assistant can submit **TypeScript/JavaScript for Deno** that:
- composes Agora capabilities (search, image, TTS, file posting),
- transforms data,
- produces artifacts that land in the originating thread.

It must do this without being able to hurt the host, the Agora instance, other tenants or other runs, and without running up unbounded cost.

**In scope:** isolation, networking, credentials, limits, the run lifecycle, the decision gate hook, audit, the threat model and negative tests.

**Out of scope:**
- The capability implementations themselves (Phase 4).
- The external orchestrator / Jev.
- Arbitrary languages (Python etc. later behind the same runner interface).
- GPU access.
- Long-running services (runs are batch jobs).
- Package installation at run time.

**Assumptions:**
- Production is Docker Engine on **Linux ≥ 5.6, x86_64 or arm64** (gVisor's requirement).
- The whole stack is one host running `docker-compose.prod.yml`.
- Multi-host is not in scope.

## 2. Assets & trust boundaries

**Assets to protect**, most critical first:
1. The host, and everything the Docker daemon controls (root equivalent).
2. Postgres data: messages, users, provider keys (encrypted), password hashes.
3. Secrets: `AGORA_ENCRYPTION_KEY`, `IP_ENCRYPTION_KEY`, `JWT_SECRET`, `DB_PASSWORD`, provider API keys, and S3 credentials when `STORAGE_DRIVER=s3`. *(amended #32: MinIO root credentials no longer exist)*
4. Stored files: the `files-data` volume or an S3 bucket. Contents are always AES-256-GCM ciphertext; file names and sizes are visible in the paths. See `docs/storage-and-encryption.md`. *(amended #32)*
5. Other runs' inputs, outputs and tokens.
6. Money: provider spend through capabilities.
7. Availability of the instance: CPU, memory, disk, queue.

**Trust levels**

| Zone | Trust | Contains |
|---|---|---|
| Host / Docker daemon | Full | everything |
| `runner` | High (root-equivalent via socket) | job scheduling, container lifecycle. **Never parses or executes run code.** |
| `api`, `postgres`, `redis`, the `files-data` volume | High | Agora core *(amended #32)* |
| `cap-gateway` | Medium: the only bridge between sandbox and core | run-token auth, capability dispatch, artifact intake. Mounts `files-data` read-write and holds `AGORA_ENCRYPTION_KEY` (before #32 it held the MinIO root credentials instead: the same reach) |
| Sandbox container | **Untrusted** | agent-authored code |

```
                         internet (providers)
                               ▲
                               │ egress (provider calls only, SSRF-guarded)
┌──────────── agora_core (internal) ──────────────┐      ┌── agora_sandbox (internal: true, no egress) ──┐
│  api ── postgres ── redis    [files-data vol]   │      │                                                │
│   │                    ▲                        │      │   run-01…  run-02…  (runsc, one per run)       │
│   │ enqueue            │ jobs/status            │      │        │ only allowed destination              │
│   ▼                    │                        │      │        ▼                                       │
│  runner ───────────────┘   cap-gateway ◄────────┼──────┼── cap-gateway:8080 (dual-homed)               │
│   │ docker.sock (only holder)                   │      │                                                │
└───┼─────────────────────────────────────────────┘      └────────────────────────────────────────────────┘
    ▼
 Docker daemon ──► creates/kills sandbox containers on agora_sandbox
```

## 3. Components

| Component | New? | Responsibility | Holds |
|---|---|---|---|
| `api` | existing | `POST /runtime/runs` (validate, persist, gate, enqueue), `GET /runtime/runs/:id`, approval endpoints, MCP `runtime_exec` backend | DB access; **no** Docker socket |
| `runner` | **new service** | consumes BullMQ `runtime` queue; builds the container spec **itself** (never from job input); starts, watches and kills containers; writes run status/exit/usage; enforces concurrency | Docker socket (via socket proxy, see T9); DB (run status only); Redis |
| `cap-gateway` | **new service** (same image as `api`, different entrypoint) | HTTP API for sandboxes: `/v1/capabilities/:name`, `/v1/files`; authenticates run tokens; applies per-run call caps and route budgets; calls providers via `src/ai/routing.ts`; validates and stores artifacts via the existing file pipeline | DB access; decrypts provider keys **in the gateway process only** |
| sandbox image `agora/sandbox-deno` | **new** | Deno runtime plus a pre-cached `agora:std` module; non-root; nothing else | nothing secret |

Run request lifecycle:
1. `api` receives a run from an authenticated bot or user with `ExecuteCode`.
2. It validates size and limits and writes `exec_runs` (`submitted`).
3. It asks the **Decider** (§10):
   - `deny` → `denied`, reply in the thread.
   - `needs_approval` → post an Approve/Deny control in the thread and wait.
   - `auto_run` → continue.
4. On clearance it marks the run `queued` and enqueues `{ runId }` only. The code stays in the DB.
5. `runner` dequeues and atomically claims the run (re-checking gate and approval, and per-server concurrency under an advisory lock). It mints the **run token** (§7), so the token exists only while the run is running and never passes through the queue. It then creates the container from a fixed template with the run's clamped limits and starts it.
6. Code calls `agora:std` → `cap-gateway` with the run token. `postFile()` uploads artifacts, which are posted to the originating thread.
7. On exit, timeout or kill: `runner` records the outcome, removes the container and revokes the token. `api` posts a result summary to the thread.

## 4. Isolation layers (defense in depth)

Each threat must be stopped by **at least two independent layers** (see §13).

| Layer | Mechanism | Stops |
|---|---|---|
| L1 Kernel boundary | **gVisor `runsc`**: a user-space kernel intercepts syscalls, so the host kernel attack surface is a small, audited subset | container escape through kernel bugs |
| L2 Container hardening | non-root UID, `--cap-drop=ALL`, `no-new-privileges`, read-only rootfs, tmpfs scratch, default seccomp, no host mounts, no Docker socket | privilege escalation, persistence, host filesystem access |
| L3 Network | `agora_sandbox` is `internal: true` (no gateway to the outside); the only other member is `cap-gateway`; no published ports | exfiltration, lateral movement, SSRF from sandbox |
| L4 Credentials | per-run token only; env scrubbed; no provider keys, no Agora secrets | secret theft |
| L5 Resource limits | cgroup CPU/memory/PIDs, wall clock, output caps, per-run call caps, route budgets | exhaustion, cost abuse |
| L6 Deno permissions | `--allow-net=cap-gateway:8080` (hostname only; the gateway's raw IP is refused), no read/write outside scratch, no env/run/ffi/sys, remote imports denied | defense-in-depth only: blocks accidental reach and most scripts |
| L7 Decision gate | rules or external decider before anything runs; human approval by default | obviously malicious or unintended runs |

> **Verified in 3.2 (runc, Deno 2.9.7):** `--deny-import` blocks both static and dynamic remote imports. `--allow-run` is enforced even for the Deno binary. With every Deno permission open, a container on the internal network still can't reach the internet (by name or IP), resolve `postgres` or public names, or reach the Docker host.

> **Why L6 isn't the boundary:** Deno loads statically imported remote modules without consulting permissions, and by default allows imports from `deno.land`, `jsr.io`, `esm.sh`, `cdn.jsdelivr.net`, `raw.githubusercontent.com`, `gist.githubusercontent.com` and others. Attacker-hosted code, plus data encoded in an import URL, would bypass `--allow-net`. We still deny remote imports (`--deny-import`, cached std-lib only), but L3 is what actually guarantees there's no route out. *(Exact flag behavior to be verified against the pinned Deno version in 3.3.)*

## 5. Container template

Built by `runner` from constants plus clamped per-run limits. Job input can't add flags, mounts, env or capabilities. Equivalent `docker run`:

```bash
docker run --rm -i \
  --name agora-run-<runId> \
  --runtime=runsc \
  --network=agora_sandbox \
  --user=65532:65532 \
  --read-only \
  --tmpfs /scratch:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=65532 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=128 \
  --memory=512m --memory-swap=512m \
  --cpus=1 \
  --ulimit nofile=256:256 \
  --log-driver=local --log-opt max-size=1m --log-opt max-file=1 --log-opt compress=false \
  --label agora.run=<runId> --label agora.server=<serverId> \
  -e AGORA_CAP_URL=http://cap-gateway:8080 \
  -e AGORA_RUN_TOKEN=<token> \
  -e AGORA_CODE_0=<base64 chunk> [-e AGORA_CODE_1 …] \
  -e DENO_DIR=/tmp/deno \
  agora/sandbox-deno@sha256:<pinned> \
  deno run --no-prompt --no-config --no-lock --cached-only --deny-import \
    --allow-net=cap-gateway:8080 \
    --allow-env=AGORA_CAP_URL,AGORA_RUN_TOKEN,AGORA_CODE_0,AGORA_CODE_1,AGORA_CODE_2,AGORA_CODE_3 \
    --allow-read=/scratch,/opt/agora-std --allow-write=/scratch \
    --v8-flags=--max-old-space-size=384 \
    /opt/agora-std/entry.ts   # reassembles code from AGORA_CODE_*, runs it with agora:std preloaded
```

Notes:
- **Code arrives in env vars** (`AGORA_CODE_0..3`, base64, ≤ 90 KB of code each, well under Linux's 128 KiB per-string limit), and the entrypoint deletes them from the environment before importing the code. No host path is ever bind-mounted, and no stdin attach is needed, so the socket proxy never has to allow connection hijacking. *(Changed during 3.2 from "stdin": the proxy doesn't support attach.)*
- **Output:** the `local` log driver is capped at a single uncompressed 1 MB file. The runner reads the logs API after exit, keeps at most `outputBytes` of each stream, then removes the container. So a chatty run can't fill the host's Docker log storage. *(Changed during 3.2 from `--log-driver=none`, which would disable the logs API.)*
- **The image is pinned by digest.** It's rebuilt only through a reviewed image change.
- **The V8 heap cap (384 MB) sits below the cgroup memory limit (512 MB),** so out-of-memory usually surfaces as a catchable error and not a SIGKILL.

## 6. Network design

- **`agora_core`** is the existing internal network (api, postgres, redis, runner, cap-gateway). Unchanged. *(amended #32: no `minio` member)*
- **`agora_sandbox`** is new: `driver: bridge`, `internal: true`. Members are **cap-gateway plus sandbox containers only**.
  - `internal: true` means Docker creates no route to the outside world.
  - Docker's embedded DNS on this network only resolves members, so `postgres`, `redis` and `api` don't resolve.
  - **Under gVisor there is no DNS at all** (found and verified 2026-09-30). Docker serves `127.0.0.11` through NAT rules inside the container's network namespace, and gVisor's netstack doesn't apply them ([google/gvisor#7469](https://github.com/google/gvisor/issues/7469), open since 2022). So `cap-gateway` doesn't resolve either. The fix follows gVisor's own FAQ advice to use IPs instead of container names:
    - before each run, the runner reads the gateway's IP from `GET /networks/agora_sandbox`, an endpoint the socket proxy already allows (matching the container name, default the `AGORA_CAP_URL` hostname, override with `AGORA_CAP_CONTAINER`);
    - it pins `cap-gateway:<ip>` in the run's `/etc/hosts` (`HostConfig.ExtraHosts`, IPv4-validated);
    - the URL and Deno's `--allow-net=cap-gateway:8080` are unchanged. Deno still refuses the gateway's raw IP, `postgres`, and public hosts (`NotCapable`, verified under runsc).
  - Under runsc, a missing gateway fails the run with a clear error; under runc (dev) Docker DNS works and the lookup is best-effort.
  - Rejected alternatives: runsc `--network=host` (gVisor: "decreases the isolation to the host"), the default bridge with `--link` (it has an internet route), and a DNS proxy on the sandbox network (a resolver reachable from untrusted code, and a DNS exfiltration path).
  - Side effect: sandboxes can't make DNS queries at all, which closes DNS tunneling (T3) at the network layer.
- **Egress to AI providers happens only in `cap-gateway`,** through `agora_core`, with the Phase 1 SSRF guard applied to provider base URLs.
- **Run-to-run traffic:** every run is on the same bridge, so the network layer doesn't separate runs from each other (ICC stays on because runs must reach the gateway). What stops a run reaching another:
  - Deno only allows connecting to `cap-gateway:8080`, and a sandbox can't listen on any port (no `--allow-net` for listening).
  - gVisor's netstack.
  - Run tokens are unique per run, and the gateway rejects any cross-run access.
- **Stricter option (deferred):** a per-run network that the gateway is attached to for the run's lifetime. Tracked as a hardening follow-up (§18).

## 7. Credentials

- **Run token:** 256 random bits, shown to the sandbox once; only a SHA-256 hash is stored in `exec_run_tokens`. It is scoped to:
  - `run_id` and `server_id`,
  - the allowed capability list (an intersection of the route config and the submitter's grant),
  - `expires_at` = run deadline + 30 s.
- It is **revoked the moment the run ends**, and the gateway rejects it on any mismatch.
- **The sandbox env contains only** `AGORA_CAP_URL` and `AGORA_RUN_TOKEN`. The runner builds env from an allowlist; the host env is never inherited.
- **Provider keys stay in Postgres (encrypted).** They are decrypted only inside `cap-gateway` for the duration of one provider call, and never returned in a response.
- **Outputs are scanned for leaks:** the gateway and runner redact the run token (and any configured secret patterns) from stdout/stderr before storing or posting them.

## 8. Resource limits

| Limit | Default | Hard ceiling | Enforced by |
|---|---|---|---|
| CPU | 1 vCPU | 2 | cgroup `--cpus` |
| Memory | 512 MB (V8 heap 384 MB) | 2 GB | cgroup; V8 flag |
| PIDs | 128 | 512 | `--pids-limit` |
| Wall clock | 60 s | 300 s | runner kills and records `timeout` |
| Scratch | 64 MB tmpfs | 256 MB | tmpfs `size=` |
| stdout / stderr kept | 64 KB each | 256 KB | runner truncates |
| Code size | 64 KB | 256 KB | api validation |
| Capability calls per run | 20 | 200 | gateway counter per token |
| Artifacts per run | 10 | 50 | gateway |
| Artifact size | instance file limit | instance file limit | existing `files.*` settings |
| Concurrent runs per server | 2 | 8 | runner (Redis semaphore) |
| Concurrent runs per instance | 4 | host-dependent | runner |
| Queued runs per server | 20 | 100 | api returns 429 |

Defaults live in `instance_settings` (`runtime.*`). Per-run requests are clamped to the ceilings, and a submitter can only lower limits.

### 8.1 Time profiles for long tasks

Generation calls (speech, images, video) can take far longer than a data transform, so the wall-clock limit follows what the run **declares it will use**:

| Profile | Applies when `requestedCapabilities` includes | Default | Ceiling |
|---|---|---|---|
| `standard` | only `chat`, `search`, `decide`, or none | 60 s | 300 s |
| `generation` | `image` or `tts` | 180 s | 600 s |
| `video` | `video` | deferred: video jobs are long-running async operations, handled as async capability calls in Phase 5, not a longer sandbox | n/a |

- The profile is chosen by `api` from the declared capabilities. The gateway still rejects any capability the run didn't declare, so a run can't claim `tts` for more time and then do something else without it showing in the audit.
- The profile applies only to wall clock. CPU, memory and call caps stay the same.
- **Time spent waiting on a provider inside a capability call still counts.** If a single generation call needs more than the profile allows, the answer is an async capability (start, then poll) and not a longer sandbox. Tracked in §18.
- Admins can change each profile's default and ceiling (`runtime.profiles.*`).

## 9. Run model

`exec_runs` (audit record, never deleted by run cleanup):

| Column | Notes |
|---|---|
| `id` | ULID |
| `server_id`, `channel_id`, `thread_id` | origin; results post back here |
| `submitted_by` | bot or user ID |
| `language` | `deno-ts` (only value in v1) |
| `code` | stored for audit and approval review; size-capped; **pruned** after the retention period (§9.1) |
| `code_sha256` | dedupe, audit |
| `requested_capabilities` | declared by the submitter; the gateway rejects anything else |
| `limits` | JSONB, clamped values actually applied |
| `gate_decision`, `gate_source`, `gate_confidence`, `gate_reason` | from the Decider (§10) |
| `approved_by`, `approved_at` | when `needs_approval` resolves |
| `status` | see the state machine below |
| `exit_code`, `stdout_tail`, `stderr_tail` | truncated and redacted |
| `capability_calls`, `cost_micros` | rolled up from `ai_usage_events.run_id` |
| `code_pruned_at` | set when `code` is cleared by retention |
| `created_at`, `started_at`, `finished_at` | |

### 9.1 Code retention

- **Default: 30 days** (`runtime.code_retention_days`, 1–3650, or `null` to keep forever). A daily cleanup job (alongside the file-cleanup worker) clears `code` and sets `code_pruned_at`. Metadata, hash, decision, outcome and usage stay for audit.
- **Users are told up front:**
  - the approval request and the run summary in the thread both end with *"Code for this run will be deleted on <date>."*
  - `GET /runtime/runs/:id` returns `codeExpiresAt`, or `codePrunedAt` once it's gone.
- **Warned before shortening:** lowering the retention in settings shows how many existing runs would lose their code at the next cleanup and asks for confirmation (e.g. "Code for 42 runs older than 7 days will be permanently deleted tonight"). The change is audit-logged.
- **Keep a copy:** anyone who can see the run can download its code (`GET /runtime/runs/:id/code`) until it's pruned.

### 9.2 State machine

```
submitted ─► gated ─┬─► denied
                    ├─► awaiting_approval ─┬─► denied (rejected / expired after 30 min)
                    │                      └─► queued
                    └─► queued ─► running ─┬─► succeeded
                                           ├─► failed (non-zero exit)
                                           ├─► timeout
                                           ├─► killed (admin cancel, pause tripwire, OOM)
                                           └─► error (infrastructure failure)
```

## 10. Decision gate

```ts
interface Decider {
  decideExecution(req: {
    runId: string; serverId: string; submitterId: string; submitterIsBot: boolean;
    code: string; codeSha256: string; requestedCapabilities: Capability[]; limits: RunLimits;
    context: { channelId: string; threadId?: string };
  }): Promise<{ decision: 'auto_run' | 'needs_approval' | 'deny'; confidence?: number; reason: string; source: 'rules' | 'webhook' | 'jev' }>;
}
```

- **`RulesDecider` (default)** denies if:
  - the submitter lacks `ExecuteCode`,
  - the code is over the size cap,
  - requested capabilities aren't enabled routes,
  - the submitter or server is over budget or concurrency,
  - or the bot is paused.

  Otherwise it returns `needs_approval` unless the bot has the admin-set `runtime_auto_approve` flag, in which case `auto_run`.
- **External deciders** (`WebhookDecider`, `JevDecider`) can only move a run **toward** approval within the rules' bounds:
  - they may upgrade `needs_approval` to `auto_run` for auto-approve-eligible bots,
  - they may downgrade anything to `needs_approval` or `deny`,
  - they can never change limits or capabilities,
  - timeout or error falls back to the rules result.
- **Classifier hygiene:** comments are stripped before code goes to a model-based decider. Code over the decider's input limit goes straight to `needs_approval`.
- **Approvals:**
  - Posted in the originating thread as a system message with the code, requested capabilities and limits.
  - Approved or denied by a member with `ManageBots` or Administrator, **never by the submitting bot**.
  - Expire after 30 minutes.
  - Recorded in `exec_runs` and the audit log.

## 11. Artifacts & results

- `postFile(name, bytes, { mime? })` in `agora:std` → `POST cap-gateway/v1/files` with the run token. The gateway:
  - applies the instance file limits (size, extension allowlist),
  - checks magic bytes with `src/lib/file-validation.ts`,
  - encrypts it (AES-256-GCM, always),
  - writes the ciphertext to the file store (`src/lib/storage.ts`: the `files-data` volume, or S3) and attaches it to a system message in the run's thread. *(amended #32)*
- **HTML artifacts are never rendered inline** in the Agora UI (stored XSS). They are served as downloads with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, and opened in a sandboxed viewer if we add one later. Images use the existing preview path.
- **The run summary** (status, duration, capability calls, cost, truncated stdout/stderr) is posted to the thread when the run finishes.

### 11.1 Gateway API (implemented in 3.4)

All endpoints need `Authorization: Bearer <run token>`. A token is valid only while its run is `running`, isn't revoked and hasn't expired. A paused submitting bot gets `423`.

| Endpoint | Behavior |
|---|---|
| `POST /v1/capabilities/:name` | `404` unknown · `403 not_declared` if the run didn't declare it · `400 invalid_input` · `429 call_limit` (per-run cap, counted atomically) · `503 capability_unavailable` (no/disabled route, unsupported adapter) · `429 budget_exceeded` · `501 not_implemented` (search/image/tts/decide until Phase 4). `chat` → `{ text, usage }`, usage recorded with `run_id` |
| `POST /v1/messages` | `{ content }` (≤ 4000) → posted in the run's thread as the submitting bot; counts as a call |
| `POST /v1/files` | raw body, `X-Agora-Filename`, optional `X-Agora-Message` (URI-encoded) → the same `storeFile()` pipeline as user uploads (size, extension allowlist, magic bytes, EXIF strip, quota, encryption) → attached to a thread message; `429 artifact_limit` |
| `GET /health` | no auth |

Posted messages reach clients through a Redis pub/sub **event bridge**. The API process re-emits only allowlisted events (`Message`, `ThreadMetadataUpdate`, `MessageUpdate`) to `channel:<id>` rooms, so a compromised gateway can't push arbitrary events.

## 12. Audit & observability

- **`exec_runs`:** every run, including denied ones.
- **`audit_log` entries:** `runtime_approve`, `runtime_deny`, `runtime_cancel`, and `runtime_settings_update`.
- **`ai_usage_events.run_id`:** links every capability call to its run.
- **Runner metrics:** queue depth, running count, run durations, timeouts, OOM kills, gateway 4xx by reason.
- **Tripwires** (auto-pause the bot and post in the thread):
  - 3 failed or timed-out runs in 10 minutes,
  - any gateway auth failure with a token from a different run,
  - a run hitting its capability-call cap.

## 13. Threat model

| # | Threat | Vector | Mitigations (layers) | Residual risk | Test (3.9) |
|---|---|---|---|---|---|
| T1 | **Container escape** | kernel exploit, runtime bug | L1 gVisor, L2 hardening, non-root, no caps | gVisor 0-day plus sandbox break; accepted, mitigated by patching `runsc` | escape probes: `/proc/self`, mount, `ptrace`, raw sockets all fail |
| T2 | **Lateral movement** to postgres/redis/api or the file volume | direct connection, DNS, mounts | L3 separate internal network, L6 Deno net allowlist, no mounts (the socket proxy rejects bind mounts and the container spec declares no volumes) | none known | connecting to `postgres:5432`, `redis:6379`, `api:3000` and the host gateway IP fails; DNS doesn't resolve them; `/data/files` doesn't exist in the sandbox *(amended #32)* |
| T3 | **Exfiltration** to the internet | fetch, DNS tunneling, remote import URLs, capability abuse | L3 `internal: true` (no route), L6 `--deny-import`, L4 capability inputs logged | an allowed capability as a covert channel (e.g. a search query carrying data): accepted, logged, rate-capped | outbound HTTP/HTTPS/DNS to public IPs fails; `import "https://esm.sh/…"` fails |
| T4 | **Secret theft** | env, `/proc`, files, gateway responses | L4 env allowlist, no mounts, keys only in the gateway, token redaction | gateway compromise exposes keys (gateway is medium trust, minimal surface) | env contains only the two vars; `/proc/1/environ` shows nothing extra; gateway responses never include keys |
| T5 | **Cross-run access** | reach another run, reuse its token | unique tokens, gateway run binding, no listeners, gVisor | shared bridge (see §6 hardening option) | run A's token rejected for run B's resources; connecting to another run's IP fails |
| T6 | **Resource exhaustion** | fork bomb, memory, CPU spin, disk fill, log flood | L5 PIDs/mem/CPU, wall clock, tmpfs size, log driver none, output caps, concurrency caps | noisy neighbor up to the configured concurrency; accepted | fork bomb contained; `while(true)` killed at deadline; 1 GB write fails at 64 MB; 10 MB stdout truncated |
| T7 | **Cost abuse** | loop calling paid capabilities | per-run call cap, route daily budgets (Phase 1), non-chat routes default off, tripwire auto-pause | budget up to the configured limit; by design | the 21st call is rejected; an exhausted budget rejects calls |
| T8 | **Gate bypass** | calling the runner/queue directly, self-approval, replaying an approval | only `api` enqueues (Redis is on `agora_core`); the runner re-checks the run is `queued` with gate fields set; the submitter can't approve; approvals expire | Redis compromise, already a core compromise | a bot approving its own run gets 403; a job for an unapproved run is refused by the runner |
| T9 | **Runner compromise → host** | malicious job payload exploiting the runner | the job carries only `runId`; the container spec comes from constants; **Docker socket proxy** (`wollomatic/socket-proxy`) allows only: `_ping`/`info`, container create, start/wait/kill/inspect/logs/delete **on `agora-run-*` names only**, container list, inspect of the sandbox network and images. No exec, no attach, no inspect of other containers (so no reading the DB container's env), no image/volume/network writes, and **bind mounts rejected on create** (verified in 3.2) | a proxy that allows container create can still create a privileged container if the runner itself is compromised. The runner stays tiny and reviewed. Rootless Docker is a hardening option (§18) | a job payload with extra fields is ignored; the runner never passes user strings into Docker API flags |
| T10 | **Malicious artifacts** | HTML/SVG XSS, polyglots, oversize files | magic-byte validation, extension allowlist, HTML/SVG as attachments with `nosniff`, size limits | a file that's harmful when opened locally; users are warned via file type | an HTML artifact is served as an attachment; a mismatched magic number is rejected |
| T11 | **Decider manipulation** | comments saying "safe", prompt injection | comments stripped, deciders can't loosen limits, default human approval, sandbox is the real boundary | an `auto_run` verdict for a harmful-but-contained run; contained by L1–L6 | a run with a comment-only difference gets the same decision; auto-run limits equal approved-run limits |
| T12 | **Queue flooding** | many submissions | queued-runs-per-server cap, bot rate limits, loop guard | none significant | the 21st queued submission gets 429 |
| T13 | **Supply chain** | tampered image or std-lib | image pinned by digest, built in CI from a reviewed Dockerfile, std-lib vendored into the image, `--cached-only` | compromise of Deno upstream releases; pinned and updated deliberately | image digest check at runner startup |
| T14 | **Token replay** | token used after the run or leaked in logs | revoked on exit, expiry, redaction | window between leak and run end (≤ 5 min) | a token rejected after run end |
| T15 | **Gateway SSRF** | capability with an attacker-influenced URL | Phase 1 URL guard on provider base URLs; capabilities never fetch arbitrary URLs from run input in v1 | future capabilities that fetch URLs must reuse the guard | covered by the url-guard unit tests plus capability tests |

## 14. Negative test suite (3.9)

These are automated integration tests against a real `runsc` runner. CI needs a Linux runner with gVisor. Every test asserts the attack fails **and** that the run ends in the expected status.

1. `fetch("http://postgres:5432")`, `redis:6379`, `api:3000` → rejected (Deno) and unreachable (network, checked with Deno perms relaxed in a test-only image). Reading `/data/files` fails: the file volume is not mounted. *(amended #32)*
2. `fetch("https://example.com")`, raw TCP to `1.1.1.1:53`, and DNS lookup of a public name → fail.
3. `import("https://esm.sh/lodash")` and a static remote import → fail at load.
4. `Deno.env.toObject()` → only `AGORA_CAP_URL` and `AGORA_RUN_TOKEN`.
5. Read `/etc/shadow`, `/proc/1/environ` and `/var/run/docker.sock` → fail.
6. Write outside `/scratch` → fail; write 100 MB to `/scratch` → fails at 64 MB.
7. Fork bomb (via `Deno.Command` or workers) → denied or contained by the PID limit; the run ends `failed` or `killed`.
8. `while (true) {}` → `timeout` at the deadline, and the container is gone afterwards.
9. Allocate 2 GB → OOM error or `killed`, and the host stays unaffected.
10. 10 MB stdout → truncated to 64 KB; host Docker logs unaffected.
11. The 21st capability call → 429 from the gateway.
12. Run B uses run A's token → 401; a token used after run end → 401.
13. The submitting bot approves its own run → 403; an unapproved run injected into the queue → the runner refuses.
14. Post an HTML artifact → stored as an attachment with `nosniff`; a JPEG claiming to be PNG → rejected.
15. The runner starts without `runsc` in production mode → refuses to start.

## 15. Environments

| Environment | Runtime | Behavior |
|---|---|---|
| **Production** (Linux ≥ 5.6) | `runsc` required | The runner checks `docker info` for the `runsc` runtime at startup and refuses to run code without it |
| **Linux dev** | `runsc` recommended | Same check; can be overridden with the dev flag |
| **Windows / macOS dev** (Docker Desktop) | `runc` | Only with `AGORA_SANDBOX_INSECURE_DEV=1`: a warning at startup and in every run summary, plus a UI banner "Sandbox is running without gVisor (dev mode)". gVisor support on Docker Desktop is not documented. |

Host setup for prod (added to the README deployment section in 3.2):

```bash
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install && sudo systemctl reload docker
docker run --rm --runtime=runsc hello-world
```

## 16. Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Deno in-process (inside `api`) | **Rejected** | One permission bug or V8 escape gives full access to the DB and secrets; no resource isolation |
| Plain Docker (`runc`) | Dev only | Shares the host kernel; one kernel exploit compromises the host |
| **gVisor (`runsc`)** | **Chosen** | Drop-in Docker runtime; strong syscall isolation; no KVM needed; fine for batch jobs |
| Firecracker microVMs | Future option | Strongest isolation, but needs KVM (often unavailable on VPSes without nested virtualization) and more orchestration. The runner interface keeps this swappable |
| nsjail / bubblewrap | Rejected for v1 | Still shares the host kernel; more custom hardening to get right |
| V8 isolates (workerd) / WASM | Rejected for v1 | Strong and cheap, but a limited runtime; would need a custom capability ABI. Worth revisiting for tiny transforms |
| Hosted sandboxes (e2b etc.) | Rejected | Data leaves the host; external dependency and cost; conflicts with self-hosted |

## 17. Operational requirements

- **Host:** Linux ≥ 5.6, x86_64/arm64, `runsc` installed and registered.
- **Compose:**
  - add `runner`, `cap-gateway` and `docker-socket-proxy`,
  - add the `agora_sandbox` network (`internal: true`),
  - the sandbox image is built or pulled with its pinned digest.
- **New env:** `AGORA_SANDBOX_IMAGE` (with digest), `AGORA_SANDBOX_INSECURE_DEV` (dev only). The gateway reuses `AGORA_ENCRYPTION_KEY` and `DATABASE_URL`. Add them to `.env.example`, `.env.prod.example` and `docker-compose.prod.yml`.
- **nginx:** the new `/runtime` API prefix must be added to the proxy regex. `cap-gateway` is **not** exposed through nginx or Caddy; it's only reachable from `agora_sandbox`.
- **Capacity:** at default limits, each concurrent run reserves 1 vCPU and 512 MB. The instance concurrency default (4) assumes a host with at least 4 vCPU and 4 GB spare.

## 18. Open questions & hardening backlog

**Questions for the reviewer**
1. ~~Default gate mode~~ **Answered:** human approval by default, auto-run granted per bot (D6).
2. ~~Wall clock~~ **Answered:** longer time profiles for generation tasks (§8.1); video goes async.
3. ~~Code retention~~ **Answered:** prune (default 30 days) and warn users (§9.1).
4. ~~Who can submit~~ **Answered:** bots only in v1 (agents via MCP `runtime_exec`); humans approve or deny. A human "run snippet" UI can come later on the same runner.

**Hardening backlog** (not blocking v1)
- A per-run Docker network (removes the shared-bridge residual in T5).
- Rootless Docker for the sandbox daemon (reduces the T9 blast radius).
- A seccomp profile tighter than the default, on top of gVisor.
- Firecracker backend behind the runner interface for hosts with KVM.
- A sandboxed HTML artifact viewer (iframe `sandbox` + separate origin).
- Async capability calls (start, then poll) so a single slow generation doesn't need a long-lived sandbox (§8.1).

## 19. WBS mapping (updates §3 of `wbs.md`)

| WBS | Delivers | Spec sections |
|---|---|---|
| 3.2 | `runner` service, socket proxy, `agora_sandbox` network, runsc check, container template, concurrency | §3, §5, §6, §8, §15, §17 |
| 3.3 | `agora/sandbox-deno` image, `agora:std` (`call`, `postFile`), pinned Deno, flag verification | §4, §5, §11 |
| 3.4 | `cap-gateway`: run-token auth, call caps, capability dispatch through `routing.ts`, file intake | §3, §7, §11 |
| 3.5 | `ExecuteCode` permission, `/runtime/runs` API, MCP `runtime_exec`, nginx and compose updates | §3, §9, §17 |
| 3.6 | Decider interface + `RulesDecider`, approvals in the thread, `exec_runs` + audit | §9, §10, §12 |
| 3.7 | *(folded into 3.4: artifacts go through the gateway, no container harvest)* | §11 |
| 3.8 | Tripwires → auto-pause | §12 |
| 3.9 | Negative test suite on a gVisor CI runner | §14 |

---

**Sign-off:** ☑ approved with changes (noted inline, 2026-09-29) · ☐ rework

Sources checked 2026-09-29: [gVisor install guide](https://gvisor.dev/docs/user_guide/install/), [Deno security & permissions](https://docs.deno.com/runtime/fundamentals/security/), [Deno permissions reference](https://docs.deno.com/runtime/reference/permissions/).

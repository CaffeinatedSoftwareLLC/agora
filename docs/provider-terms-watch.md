# Provider terms watcher

Open **Instance Settings → Provider terms** (`/admin/provider-terms`). Only instance
admins can read snapshots/history, configure checks, add/remove/disable URLs, or
acknowledge changes. Migration **048_terms_watch.sql** seeds 13 source documents:
Anthropic legal/compliance, Agent SDK, consumer terms, Channels and support article
15036540; Codex auth, non-interactive mode, Sign in with ChatGPT and OpenAI terms;
Antigravity terms/headless docs, raw Gemini CLI terms/privacy and Gemini API terms.
The canonical URLs and redirect host lists are in the migration.

## Checks and review

The first successful fetch establishes a baseline without an alert. Later hash
changes create a history entry with a capped unified text diff. A successful fetch
updates the latest snapshot; failed fetches retain the last good text/hash/fetched
time, record a separate check time and error, and increment consecutive failures.
The dashboard shows a warning at three failures. Successful recovery resets it.
Layout and whitespace changes removed by extraction do not create changes.

**Check now** durably queues a request, returning 202; the worker consumes it within
60 seconds. It runs in the API process started by `src/index.ts`, like the other
background workers. A PostgreSQL session advisory lock prevents overlapping runs
across API replicas. An in-flight run finishes before shutdown. Checks resume from
the latest committed snapshots after a crash. No extra Redis queue is required.

The interval is read from `instance_settings` every minute:

| Setting | Default | Meaning |
| --- | --- | --- |
| `terms_watch.interval_hours` | `24` | Hours between runs, admin range 1–720 |
| `terms_watch.channel_id` | `null` | Explicit owner-server text channel; null uses general in the owner's first server |
| `terms_watch.requested` | `false` | A queued manual check, consumed when a run starts |
| `terms_watch.last_run_at` | `null` | Last run start, used to determine when the next run is due |

The owner is the earliest-created non-bot instance admin; the first owned server is
ordered by creation time and ID. Admins can select any text channel in that owner's
servers. If no such channel exists, changes remain in history and notices wait for
a subsequent check after a channel becomes available. An invalid/deleted configured
channel falls back to the default. Disabling a URL preserves its history. Removing
it deletes snapshots and history after browser confirmation; existing chat notices
remain. Acknowledgment records the admin and timestamp without altering the diff.

## AI triage and notices

The owner's first server's enabled **Chat** capability route supplies the model.
Only the Anthropic, OpenAI and Gemini API adapters with a nonempty encrypted API key
qualify. Keyless local models, agent-host profiles and subscription logins are never
used. Existing route budgets and usage accounting apply. Provider calls have a
30-second abort deadline and a 600-token output limit. No provider, exhausted budget,
provider failure or malformed JSON produces a conservative `review` impact and a
three-line fallback summary, with the raw diff still available in history.

The prompt supplies the relevant local provider policy plus subscription guidance,
and labels the remote diff as **untrusted data**, with no tools available. A strict
parser accepts only `none/low/review/high` and three bounded summary lines. Summary
text is displayed as plain text and never interpreted as instructions, HTML or
executable actions. Chat notices remove remote mentions/links and use a fixed local
review link. AI output is advisory: humans judge compliance and acknowledge changes.

Local policy context is bundled in `src/terms/context.json`, imported into the
compiled server so Docker does not need a docs volume. Its source documents are
`docs/provider-terms.md` and `docs/subscription-use.md`; the unit suite asserts they
match (line endings normalised to LF, so Windows checkouts agree). Regenerate it after
editing either source (from the repository root):

```sh
node -e "const fs=require('node:fs'); const r=f=>fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n'); fs.writeFileSync('src/terms/context.json', JSON.stringify({policy:r('docs/provider-terms.md'),subscription:r('docs/subscription-use.md')},null,2)+'\n')"
```

Each change and its system notice commit atomically with the new snapshot. Socket
events are emitted after commit. Pending notices carry a stored message ID to
prevent duplicates. A crash between commit and event emission leaves the durable
message visible when clients reload history.

## Network and extraction boundaries

URLs must use HTTPS on port 443, with no credentials. Each entry has an explicit
hostname allowlist; a newly added entry defaults to its own host. Include the initial
host when supplying additional redirect hosts. The API also allows admins to amend
the list using `PATCH /terms-watch/documents/:id` with `allowedHosts`.

Each request resolves **all** DNS answers and rejects private, loopback, link-local,
multicast, documentation and other reserved addresses, including IPv4-mapped IPv6.
The public address is pinned for the actual TLS connection, while retaining the
original hostname for certificate verification and the Host header. At most three
redirects are followed; every hop repeats hostname and DNS checks. The instance's
private-AI-base-URL setting never weakens this fetch guard.

Fetches use a descriptive User-Agent, a 20-second total deadline (including DNS and
body), and a 2 MiB cap on decoded bytes. Only HTML/XHTML/plain/Markdown are accepted.
Identity is requested; gzip, deflate and Brotli replies are decoded (the cap applies to
the decoded size). HTML extraction prefers a main/article landmark, discards scripts,
navigation, headers/footers, asides, buttons, dialogs and hidden elements, plus page
chrome that changes without the document changing (announcement and cookie banners,
toasts, `role="banner|navigation|alert|status|dialog|..."` and `aria-live` regions), decodes common/numeric
entities, and normalizes Unicode and whitespace deterministically. Parser nesting
is bounded. The unified diff is linear-space, one hunk with three context lines,
capped at 24,000 characters and visibly marked when truncated.

Client-rendered, bot-blocked or renamed pages can fail checks; the
watcher does not execute scripts or bypass access controls. A changed extraction
algorithm can cause a one-time diff. Large rewritten documents produce a truncated
diff; human review of the linked source may be necessary. History is retained until
its URL is removed; there is currently no automatic retention policy.

## API and validation

All endpoints below require authenticated instance-admin access. Request bodies,
IDs and pagination use Fastify JSON schemas; history is paginated by ULID.

| Method and path | Use |
| --- | --- |
| `GET /terms-watch` | Documents, latest status, settings and available channels |
| `POST /terms-watch/documents` | Add name, HTTPS URL, provider and optional allowedHosts |
| `PATCH /terms-watch/documents/:id` | Enable/disable or update allowedHosts |
| `DELETE /terms-watch/documents/:id` | Remove a URL and its history |
| `PATCH /terms-watch/settings` | Save intervalHours and/or channelId |
| `POST /terms-watch/check` | Queue a manual check (`{}` body) |
| `GET /terms-watch/documents/:id/changes` | History; optional before and limit (1–100) |
| `POST /terms-watch/changes/:id/acknowledge` | Idempotent acknowledgment (`{}` body) |

`terms_documents` and `terms_changes` also enforce instance-admin RLS. Workers use
the existing table-owner pool. The `terms-watch` top-level API prefix is proxied
in `agora-ui/nginx.conf`; an exact SPA location serves the dashboard's review URL.
Automated tests inject document fetching and provider responses; they never call
the watched URLs.

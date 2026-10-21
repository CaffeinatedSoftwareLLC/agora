# RLS boundaries

Migration 062 hardens the existing `app_user` policies after the SEC-01 probe (#188).
It changes no account, membership, invite, channel or file data.

- Server invite rows are readable only by server members. Creating one requires membership and the caller's own creator ID. Direct `app_user` updates are denied, including counter resets. Authenticated redemption uses `public.join_server_by_invite(code)`, which derives the actor from the request context, checks an active human account, locks the exact code and enforces expiry/use limits for new members. Only an actual new membership increments the counter; repeat joins remain idempotent.
- A direct membership insert is allowed only for the current user owning that server, so server creation can bootstrap its first member. Other authenticated joins use the function. Public registration, initial setup and approved-user membership via the held migration 060 retain their trusted owner paths.
- Channels require a non-null server and its membership for human reads/inserts/updates. Existing explicit bot-channel reads remain. The former blanket visibility and creation of server-less channels is removed.
- File insertion and the destination of any update require a non-null channel accessible through server membership or explicit bot access, with the caller as uploader. Existing channel-less files, if any, become uploader-only rather than instance-wide. Explicit bot reads and uploader deletion rules stay in place.
- Agent invite creation requires the actual creator to be an active human member of the bot's matching server, owning the bot or holding server ownership/Administrator. It does not require the separate channel-level DirectAgents permission. Creator-only reads and absent update/delete grants remain.

The membership and new helper functions use a fixed `pg_catalog, public, pg_temp`
search path; new helper SQL qualifies public tables. PUBLIC execute is revoked and
`app_user` receives execute explicitly. This follows PostgreSQL's
[SECURITY DEFINER guidance](https://www.postgresql.org/docs/16/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY),
including putting the temporary schema last.

This remains defense in depth for the policies already present. The table owner
and superusers still bypass RLS. Core tables without RLS and the production role
design are outside this migration; a role redesign must audit all trusted paths.
Service-only tables retain their existing deny-all policies/grants. HTTP routes
continue to enforce their more detailed permission checks.

Verification lives in `test/integration/rls-probe.integration.test.ts` (the seven
original findings are passing tests) and `invite-join.integration.test.ts` (expiry,
limits, last-use concurrency, idempotency, caller identity and helper privileges).
Run these only against an isolated test database: existing fixtures reset data.

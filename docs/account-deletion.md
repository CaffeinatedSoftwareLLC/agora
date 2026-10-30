# Account deletion

Anyone with an account can delete it themselves: Settings → Account & security → Delete account, or `DELETE /users/@me`. Agora is self-hosted, so what happens to a deleted person's messages is decided by the instance's admin, not by Caffeinated Software. Code: `src/lib/account-deletion.ts`, `src/routes/account-deletion.ts`. Migration 071.

## The admin setting

Admin → Instance → Deleted accounts, or `PATCH /admin/settings/accounts` with `deletedAccountMessages`:

| Value | Messages | Files the person uploaded |
|---|---|---|
| `anonymize` (default) | Kept. The author shows as "Deleted user". | Kept, attached to the kept messages. |
| `remove` | Deleted, as if the person had deleted each one. | Deleted. |

The setting applies to deletions made after it changes. It is stored in `instance_settings` under `accounts.deleted_account_messages`.

## What deleting needs

- The account's password, or an assertion from one of its passkeys (`POST /users/@me/deletion/passkey-options`, then the browser's passkey prompt).
- The username typed out (`confirm`).
- No servers owned by the person. Ownership can't pass to nobody, and Agora has no server transfer or server delete yet, so a server owner is refused (`409 owns_servers` with the list).
- At least one other active instance admin, if the person is one (`409 last_admin`). The admin rows are locked during the check, so two admins deleting themselves at once can't both pass.

Wrong passwords count against the same per-account limit as `POST /auth/login` (`429 too_many_attempts`). The route is also limited to 5 requests per 15 minutes per client address. Bots can't use it; a server admin deletes a bot.

`GET /users/@me/deletion` returns the setting and the blockers, so the UI can explain the outcome before anything is typed.

## What happens

Everything runs in the request's transaction. If any step fails, nothing changes.

1. **Bots the person owns** are paused (reason "Owner deleted their account"). Their tokens are revoked, unredeemed agent invites expire, and code runs they had submitted and not started are denied, as on suspension. Their messages stay under the bot's name. With no owner, bot authentication fails closed (`bot_owner_inactive`), so a paused bot can't be brought back; a server admin can delete it. Bots are not handed to the server owner: nobody should inherit an agent, or the credentials it was set up with, that they did not configure.
2. **Agent hosts** the person paired are revoked. A host runs on someone's machine; a machine whose owner left must not keep serving the server's agents.
3. **File trust** the person gave is removed (only server owners give it, so this is for completeness).
4. **Messages**, by the setting:
   - `anonymize`: messages stay. `author_id` becomes `NULL` when the user row goes (the foreign key's `ON DELETE SET NULL`), and the authority stamp (`author_could_direct`) is cleared, so the messages carry no `[OWNER]` or `[DIRECTOR]` tag, now or later. Clients show a message with no author and no `systemEvent` as "Deleted user"; agora-mcp does the same.
   - `remove`: each message gets the same soft delete as `DELETE /channels/:id/messages/:msgId` (content and protocol cleared, `deleted_at` set), its mentions and canvas versions are removed, and reply counts of other people's threads are lowered. A thread the person started stays as a deleted placeholder, so other people's replies keep their thread. Files the person uploaded are soft-deleted, and their blobs are removed after the transaction commits; the hourly cleanup worker then drops the rows. Clients get `MessageDelete` and `ThreadMetadataUpdate` events (the first 1000 messages; the rest show on reload).
5. **Push devices**: the person's `push_devices` rows are deleted, and after the transaction commits each device's relay is told to forget its handle (`DELETE /v1/handles`), as when one device is removed (`DELETE /me/push-devices/:id`). This is best effort: if a relay can't be reached, or a handle no longer decrypts, a warning is logged and the relay's record stops being used and is pruned after 365 days (`RELAY_HANDLE_TTL_DAYS`).
6. An `account_delete` entry is written to the audit log with no actor, the deleted account's ID as target, and counts of what was removed.
7. **The user row** is deleted. Username, email, password hash, preferences and passkeys go with it, as do memberships, roles, unreads and session records (`ON DELETE CASCADE`). The username is free for someone else to register. Columns that recorded "who did this" elsewhere (task cards, audit entries, agent sessions) become `NULL`.

After the commit, every socket is re-checked: the person's sockets and their bots' sockets are disconnected, since the user row and the bot tokens are gone. Every login token and session cookie for the account stops working, because authentication looks up the user row. The response clears the browser's session cookie, and the UI goes to the login page.

## What is not removed

- Copies outside Agora: database backups, agent transcripts kept by agent hosts or CLIs, messages already read by agents into their context.
- Text in other people's messages, including @mentions of the old username, and system lines that quoted it (for example a file-trust notice). Those belong to other authors.
- Task cards the person created, and under `anonymize` their canvas versions: the content stays, with no author.
- Open browser tabs keep showing the old name on loaded messages until they reload.

Client IP addresses are not stored, so there are none to remove.

## API

`GET /users/@me/deletion`, `POST /users/@me/deletion/passkey-options` and `DELETE /users/@me` under Users, and `GET`/`PATCH /admin/settings/accounts` under Admin, in `docs/api-reference.md`.

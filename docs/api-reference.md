# Agora API Reference

Complete reference for the Agora REST API and WebSocket gateway. All REST endpoints are served over HTTP; all WebSocket communication uses Socket.IO with the `websocket` transport.

---

## Table of Contents

- [Authentication](#authentication)
- [Common Patterns](#common-patterns)
- [Instance](#instance)
- [Auth](#auth)
- [Servers](#servers)
- [Invites](#invites)
- [Channels](#channels)
- [Messages](#messages)
- [Threads](#threads)
- [Files](#files)
- [Unreads](#unreads)
- [Users](#users)
- [Bots](#bots)
- [AI Providers](#ai-providers)
- [Admin](#admin)
- [WebSocket Gateway](#websocket-gateway)

---

## Authentication

Most endpoints require a token in the `Authorization` header. Two auth schemes are supported:

### Human auth (Bearer)

```
Authorization: Bearer <accessToken>
```

Tokens are JWTs issued by `/auth/login`, `/auth/register`, or `/instance/setup`. Account status must be `active` -- accounts with `pending` or `suspended` status receive `403`.

### Bot auth

```
Authorization: Bot bot_<tokenId>.<secret>
```

Bot tokens are created via the bot management API. Bot auth is restricted to an allowlist of routes: message endpoints, channel listing, cursor endpoints, and bot self-info (`/bots/@me`). Bot requests support an `Idempotency-Key` header for safe retries.

**Unauthenticated routes** (no token required):
- `GET /health`
- `GET /instance/status`
- `POST /instance/setup`
- `POST /auth/register`
- `POST /auth/login`

All other routes require authentication.

---

## Common Patterns

### IDs

All resource IDs are ULIDs (26-character, chronologically sortable strings). Example: `01HYX3K5P6R7S8T9V0WXYZ1234`.

### Error Responses

All error responses follow this shape:

```json
{ "error": "error_code_or_message" }
```

### Pagination

Cursor-based pagination uses ULID-based `before` parameters. Offset-based pagination (admin endpoints) uses `page` and `limit` query parameters.

### Channel Types

| Value | Type            |
|-------|-----------------|
| `3`   | Server Text     |
| `5`   | Server Category |

> Types `1`/`2` (DM/group DM) and `4` (voice) exist in the schema for historical reasons but are no longer created or served — see the v1 platform release for those features.

---

## Instance

### GET /instance/status

Returns the current instance configuration. No authentication required.

**Response** `200`
```json
{
  "initialized": true,
  "registrationPolicy": "open",
  "instanceName": "Agora"
}
```

| Field                | Type    | Description                                           |
|----------------------|---------|-------------------------------------------------------|
| `initialized`        | boolean | Whether one-time setup has been completed             |
| `registrationPolicy` | string  | `"open"`, `"invite_only"`, or `"approval"`            |
| `instanceName`       | string  | Display name of the instance                          |

---

### POST /instance/setup

One-time instance initialization. Creates the admin user, a default server with `#general` channel, and sets instance configuration. Serialized with `pg_advisory_xact_lock` to prevent concurrent setup.

**Auth:** None (uses setup token instead)

**Request Body**
```json
{
  "setupToken": "token-from-server-logs",
  "username": "admin",
  "email": "admin@example.com",
  "password": "securepassword",
  "instanceName": "My Agora",
  "registrationPolicy": "open"
}
```

| Field                | Type   | Required | Constraints                                  |
|----------------------|--------|----------|----------------------------------------------|
| `setupToken`         | string | yes      | minLength: 1                                 |
| `username`           | string | yes      | 1-32 characters                              |
| `email`              | string | yes      | Valid email format                            |
| `password`           | string | yes      | minLength: 8                                 |
| `instanceName`       | string | no       | 1-100 characters. Default: `"Agora"`         |
| `registrationPolicy` | string | no       | `"open"`, `"invite_only"`, or `"approval"`. Default: `"open"` |

**Response** `201`
```json
{
  "user": {
    "id": "01HYX...",
    "username": "admin",
    "isInstanceAdmin": true
  },
  "accessToken": "eyJhbG..."
}
```

**Errors**

| Status | Error                        | Cause                           |
|--------|------------------------------|---------------------------------|
| 400    | _(validation error)_         | Missing/invalid body fields     |
| 403    | `invalid_setup_token`        | Setup token does not match      |
| 409    | `instance_already_initialized` | Setup has already been run    |

---

## Auth

### POST /auth/register

Register a new user account. Behavior depends on the instance's registration policy.

**Auth:** None

**Request Body**
```json
{
  "username": "alice",
  "email": "alice@example.com",
  "password": "securepassword",
  "inviteCode": "a1b2c3d4"
}
```

| Field        | Type   | Required | Constraints                                          |
|--------------|--------|----------|------------------------------------------------------|
| `username`   | string | yes      | 1-32 characters                                      |
| `email`      | string | yes      | Valid email format                                    |
| `password`   | string | yes      | minLength: 8                                         |
| `inviteCode` | string | no       | Required when registration policy is `invite_only`   |

**Response** `201` (policy: `open` or `invite_only`)
```json
{
  "user": { "id": "01HYX...", "username": "alice" },
  "accessToken": "eyJhbG..."
}
```

**Response** `201` (policy: `approval`)
```json
{
  "user": { "id": "01HYX...", "username": "alice" },
  "status": "pending"
}
```
No token is returned for pending accounts.

**Errors**

| Status | Error                     | Cause                                              |
|--------|---------------------------|----------------------------------------------------|
| 400    | `invite_code_required`    | Policy is `invite_only` but no invite code provided |
| 400    | _(validation error)_      | Missing/invalid body fields                        |
| 404    | `invalid_invite_code`     | Invite code not found, expired, or max uses reached |
| 409    | `username_or_email_taken` | Username or email already exists                   |

**Side effects:** When using an invite code (`invite_only` policy), the user is automatically added to the invite's server and the invite's `use_count` is incremented.

---

### POST /auth/login

Authenticate with a username or an email, and a password.

**Auth:** None

**Request Body**
```json
{
  "login": "alice",
  "password": "securepassword"
}
```

| Field      | Type   | Required | Notes |
|------------|--------|----------|-------|
| `login`    | string | Yes*     | The account's username or its email. Case does not matter. |
| `email`    | string | Yes*     | Older name for the same field; still accepted. Send one of the two. |
| `password` | string | Yes      | |

Bots cannot log in this way; they authenticate with a bot token.

**Response** `200`
```json
{
  "user": { "id": "01HYX...", "username": "alice" },
  "accessToken": "eyJhbG..."
}
```

**Errors**

| Status | Error                | Cause                                     |
|--------|----------------------|-------------------------------------------|
| 400    | (validation)         | `password` or the identifier is missing    |
| 401    | `invalid_credentials`| No such username or email, or the password does not match |
| 403    | `account_pending`    | Account exists but has not been approved   |
| 403    | `account_suspended`  | Account has been suspended by an admin     |

---

## Servers

### POST /servers

Create a new server. The authenticated user becomes the owner. Automatically creates an `@everyone` role and a `#general` text channel.

**Auth:** Required

**Request Body**
```json
{
  "name": "My Server"
}
```

| Field  | Type   | Required | Constraints    |
|--------|--------|----------|----------------|
| `name` | string | yes      | 1-100 characters |

**Response** `201`
```json
{
  "id": "01HYX...",
  "name": "My Server",
  "ownerId": "01HYX...",
  "everyoneRoleId": "01HYX..."
}
```

---

### GET /servers/:id/channels

List all channels in a server, ordered by position.

**Auth:** Required (must be a server member)

**Response** `200`
```json
[
  {
    "id": "01HYX...",
    "name": "general",
    "channelType": 3
  }
]
```

**Errors**

| Status | Error                          | Cause              |
|--------|--------------------------------|---------------------|
| 403    | `Not a member of this server`  | User is not a member |

---

### GET /servers/:id/members

List all members of a server with their assigned roles.

**Auth:** Required (must be a server member)

**Response** `200`
```json
[
  {
    "id": "01HYX...",
    "username": "alice",
    "joinedAt": "2025-01-15T10:30:00.000Z",
    "roles": [
      { "id": "01HYX...", "name": "Moderator", "position": 1 }
    ]
  }
]
```

**Errors**

| Status | Error                          | Cause              |
|--------|--------------------------------|---------------------|
| 403    | `Not a member of this server`  | User is not a member |

---

## Invites

### POST /servers/:id/invites

Create an invite code for a server.

**Auth:** Required (must be a server member)

**Response** `201`
```json
{
  "code": "a1b2c3d4"
}
```

The code is 8 hex characters.

**Errors**

| Status | Error                          | Cause              |
|--------|--------------------------------|---------------------|
| 403    | `Not a member of this server`  | User is not a member |

---

### POST /invites/:code

Use an invite code to join a server. Idempotent if the user is already a member.

**Auth:** Required

**Response** `200`
```json
{
  "serverId": "01HYX...",
  "userId": "01HYX..."
}
```

**Errors**

| Status | Error             | Cause                |
|--------|-------------------|----------------------|
| 404    | `Invite not found` | Invalid invite code  |

**Side effects:** If the user was not already a member, a `ServerJoin` WebSocket event is emitted to the user's socket room containing the server and its channels.

---

## Channels

### POST /servers/:id/channels

Create a new channel in a server.

**Auth:** Required (must be a server member)

**Request Body**
```json
{
  "name": "announcements",
  "channelType": 3
}
```

| Field         | Type    | Required | Constraints          |
|---------------|---------|----------|----------------------|
| `name`        | string  | yes      | 1-100 characters     |
| `channelType` | integer | yes      | `3`, `4`, or `5`     |

**Response** `201`
```json
{
  "id": "01HYX...",
  "name": "announcements",
  "channelType": 3,
  "serverId": "01HYX..."
}
```

**Errors**

| Status | Error                          | Cause              |
|--------|--------------------------------|---------------------|
| 403    | `Not a member of this server`  | User is not a member |

---

## Messages

### POST /channels/:id/messages

Send a message to a channel. Parses `@username` mentions from content and tracks `@everyone` mentions.

**Auth:** Required (must have access to the channel)

**Request Body**
```json
{
  "content": "Hello @alice, check this out!"
}
```

| Field     | Type   | Required | Constraints      |
|-----------|--------|----------|------------------|
| `content` | string | yes      | 1-4000 characters |

**Response** `201`
```json
{
  "id": "01HYX...",
  "content": "Hello @alice, check this out!",
  "authorId": "01HYX...",
  "authorUsername": "bob",
  "channelId": "01HYX...",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "mentions": ["01HYX..."],
  "mentionsEveryone": false
}
```

| Field             | Type     | Description                                          |
|-------------------|----------|------------------------------------------------------|
| `mentions`        | string[] | User IDs of resolved `@username` mentions            |
| `mentionsEveryone`| boolean  | Whether the message contains `@everyone`             |

**Errors**

| Status | Error                            | Cause                         |
|--------|----------------------------------|-------------------------------|
| 403    | `Not a member of this channel`   | User lacks channel access     |

**Side effects:**
- Broadcasts `Message` event to the channel's Socket.IO room (after transaction commits).
- Inserts rows into `message_mentions` for resolved @mentions.
- Increments `mention_count` in `channel_unreads` for mentioned users.
- If `@everyone` is used, increments `mention_count` for all channel/server members except the author.

---

### GET /channels/:id/messages

Fetch messages from a channel with cursor-based pagination. Returns messages in reverse chronological order (newest first).

**Auth:** Required (must have access to the channel)

**Query Parameters**

| Param    | Type   | Required | Default | Constraints                   |
|----------|--------|----------|---------|-------------------------------|
| `limit`  | number | no       | 50      | 1-100                         |
| `before` | string | no       | -       | ULID cursor; returns messages older than this ID |

**Response** `200`
```json
[
  {
    "id": "01HYX...",
    "content": "Hello world",
    "authorId": "01HYX...",
    "authorUsername": "alice",
    "channelId": "01HYX...",
    "editedAt": null,
    "deletedAt": null,
    "createdAt": "2025-01-15T10:30:00.000Z"
  }
]
```

Deleted messages have `content: null` and a non-null `deletedAt` timestamp.

**Errors**

| Status | Error                            | Cause                         |
|--------|----------------------------------|-------------------------------|
| 403    | `Not a member of this channel`   | User lacks channel access     |

---

### PATCH /channels/:id/messages/:msgId

Edit a message. Only the original author can edit their own messages.

**Auth:** Required (must be channel member and message author)

**Request Body**
```json
{
  "content": "Updated message content"
}
```

| Field     | Type   | Required | Constraints      |
|-----------|--------|----------|------------------|
| `content` | string | yes      | 1-4000 characters |

**Response** `200`
```json
{
  "id": "01HYX...",
  "content": "Updated message content",
  "editedAt": "2025-01-15T11:00:00.000Z"
}
```

**Errors**

| Status | Error                            | Cause                              |
|--------|----------------------------------|------------------------------------|
| 403    | `Not a member of this channel`   | User lacks channel access          |
| 403    | `Not the message author`         | User did not author this message   |
| 404    | `Message not found`              | Message does not exist in channel  |

**Side effects:** Broadcasts `MessageUpdate` event to the channel's Socket.IO room.

---

### DELETE /channels/:id/messages/:msgId

Soft-delete a message. Sets `content` to `NULL` and records `deleted_at`. Only the original author can delete their own messages.

**Auth:** Required (must be channel member and message author)

**Response** `200`
```json
{
  "id": "01HYX...",
  "deletedAt": "2025-01-15T11:00:00.000Z"
}
```

**Errors**

| Status | Error                            | Cause                              |
|--------|----------------------------------|------------------------------------|
| 403    | `Not a member of this channel`   | User lacks channel access          |
| 403    | `Not the message author`         | User did not author this message   |
| 404    | `Message not found`              | Message does not exist in channel  |

**Side effects:** Broadcasts `MessageDelete` event to the channel's Socket.IO room.

---

## Threads

### POST /channels/:id/messages/:msgId/replies

Create a reply to a message, starting or continuing a thread.

**Auth:** Required (must have access to the channel)

**Request Body**
```json
{
  "content": "This is a reply"
}
```

| Field     | Type   | Required | Constraints      |
|-----------|--------|----------|------------------|
| `content` | string | yes      | 1-4000 characters |

**Response** `201`
```json
{
  "id": "01HYX...",
  "content": "This is a reply",
  "authorId": "01HYX...",
  "authorUsername": "alice",
  "channelId": "01HYX...",
  "threadId": "01HYX...",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "mentions": [],
  "mentionsEveryone": false
}
```

**Errors**

| Status | Error                          | Cause                              |
|--------|--------------------------------|------------------------------------|
| 403    | `Not a member of this channel` | User lacks channel access          |
| 404    | `Parent message not found`     | Message does not exist or is deleted |
| 409    | `Thread is closed`             | Thread has been closed             |

**Side effects:**
- Broadcasts `Message` event with `threadId` to the channel room
- Emits `ThreadMetadataUpdate` with updated `replyCount` and `lastReplyAt`

---

### GET /channels/:id/messages/:msgId/replies

Fetch replies in a thread with cursor-based pagination. Returns oldest first.

**Auth:** Required (must have access to the channel)

**Query Parameters**

| Param    | Type   | Required | Default | Constraints                   |
|----------|--------|----------|---------|-------------------------------|
| `limit`  | number | no       | 50      | 1-100                         |
| `before` | string | no       | -       | ULID cursor                   |

**Response** `200` — array of message objects with `threadId` field.

---

### GET /channels/:id/threads

List active (non-closed) threads in a channel, ordered by most recent reply.

**Auth:** Required (must have access to the channel)

**Query Parameters**

| Param    | Type   | Required | Default | Constraints |
|----------|--------|----------|---------|-------------|
| `limit`  | number | no       | 25      | 1-50        |
| `before` | string | no       | -       | ISO timestamp cursor for pagination |

**Response** `200`
```json
[
  {
    "id": "01HYX...",
    "content": "Parent message content",
    "authorId": "01HYX...",
    "authorUsername": "alice",
    "channelId": "01HYX...",
    "replyCount": 5,
    "lastReplyAt": "2025-01-15T12:00:00.000Z",
    "threadClosedAt": null,
    "canClose": true,
    "preview": [
      { "id": "01HYX...", "content": "Latest reply", "authorUsername": "bob" }
    ]
  }
]
```

The `preview` contains up to 2 most recent replies (via LATERAL join). `canClose` indicates whether the requesting user has permission to close the thread.

---

### PATCH /channels/:id/messages/:msgId/thread

Close or reopen a thread. Requires the message author, ManageMessages permission, or Administrator.

**Auth:** Required

**Request Body**
```json
{
  "closed": true
}
```

| Field    | Type    | Required | Description |
|----------|---------|----------|-------------|
| `closed` | boolean | yes      | `true` to close, `false` to reopen |

**Response** `200`
```json
{
  "messageId": "01HYX...",
  "threadClosedAt": "2025-01-15T12:00:00.000Z"
}
```

**Errors**

| Status | Error                 | Cause                                |
|--------|-----------------------|--------------------------------------|
| 403    | `forbidden`           | User lacks permission to close/reopen |
| 404    | `not_a_thread_parent` | Message is not a thread parent       |

**Side effects:** Emits `ThreadMetadataUpdate` with updated `threadClosedAt`.

---

## Files

Files are stored encrypted (AES-256-GCM) and are only ever served through the API after a permission check. There are no public or signed URLs. See [Storage and Encryption](storage-and-encryption.md).

To attach a file to a message, upload it first, then pass its `id` in the `attachments` array of `POST /channels/:id/messages` (up to 10, and only files you uploaded). An upload that is not attached to a message within an hour is deleted.

### POST /files/upload

Upload one file to a channel.

**Auth:** Required. Needs `UploadFiles` and `SendMessages` in the channel.

**Rate limit:** 20 uploads per minute per user.

**Request:** `multipart/form-data` with a `channel_id` field followed by one file part. Send `channel_id` before the file.

```bash
curl -X POST http://localhost:3000/files/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "channel_id=$CHANNEL_ID" \
  -F "file=@report.pdf"
```

**Response** `201`
```json
{
  "id": "01JNXYZ...",
  "name": "report.pdf",
  "mime": "application/pdf",
  "size": 48213,
  "width": null,
  "height": null,
  "url": "/files/01JNXYZ..."
}
```

`width` and `height` are set for images. `size` is the stored size after image metadata is stripped.

**Errors**

| Status | Meaning |
|---|---|
| `400` | No file, or `channel_id` missing |
| `403` | Not a server member, or missing permissions |
| `404` | Channel not found |
| `413` | Larger than the instance's max file size |
| `415` | Extension not allowed, or the content doesn't match an allowed type (checked by magic bytes) |
| `502` | The file could not be written to storage |
| `507` | Instance storage quota exceeded |

---

### GET /files/:fileId

Download a file. The API decrypts it and sends the original bytes.

**Auth:** Required. Needs `ViewChannel` in the file's channel.

**Response** `200` with the file body and these headers:

| Header | Value |
|---|---|
| `Content-Type` | The detected MIME type |
| `Content-Disposition` | `inline` for images, audio, MP4/WebM video and PDF; `attachment` for everything else |
| `Cache-Control` | `private, max-age=3600` |
| `X-Content-Type-Options` | `nosniff` |

**Errors:** `403` no access to the channel · `404` unknown or deleted file, or its stored data is missing.

---

### DELETE /files/:fileId

Delete a file. Allowed for the uploader, or a member with `ManageMessages` in the file's channel.

**Response** `200`
```json
{ "deleted": true }
```

**Errors:** `403` not the uploader and no `ManageMessages` · `404` unknown or already deleted.

---

### GET /channels/:id/files/search

Find files shared in a channel, best match first. For members with `ViewChannel`, and for bots with access to the channel. The response is metadata only: it never contains file text (read a file with `GET /files/:fileId/text`).

**Query:** `q` (what you are looking for, up to 500 characters; without it the newest files are listed) · `tag` (only files carrying this tag) · `limit` (1–25, default 10).

**Response** `200`
```json
{
  "query": "how do agents take turns in a thread?",
  "tag": null,
  "results": [
    {
      "id": "01M3...", "name": "collab-protocol.md", "mime": "text/markdown", "size": 412,
      "url": "/files/01M3...", "messageId": "01M3...", "uploadedAt": "2026-10-01T22:10:00.000Z",
      "tags": [{ "name": "protocol", "probability": 0.98 }],
      "tagging": "done", "partial": false,
      "score": 0.97, "ranked": true, "injectionWarning": false
    }
  ],
  "ranking": { "status": "ranked", "model": "jev-1.13.0", "questionVersion": "ranking-1" }
}
```

- `tags`: tags at or above the server's tag threshold. `stale: true` marks a result made before the tag was last edited.
- `tagging`: `none` (never queued), `pending`, `running`, `done`, `skipped` (no readable text, such as an image) or `failed`. `partial`: the file was longer than what was read.
- `score` (0–1) and `ranked`: when file ranking is on, the decision model reads the top candidates and `score` is its answer. Otherwise `score` comes from file names and tags and `ranked` is `false`.
- `ranking.status` is `coarse` with a `reason` when the model did not rank: ranking off, no decision model, budget spent, provider failure, invalid answer, or no search text.
- `injectionWarning`: when the file was tagged, its text looked like it tries to give instructions to an AI. Such a file is not sent to the model for ranking.
- Tags raise a file's rank. They never exclude a file: one that is untagged, pending or failed is still found by its name. Only the explicit `tag` parameter filters.
- Only files attached to a message that still exists are listed.

**Errors:** `400` invalid `limit` or `q` too long · `403` no access to the channel · `404` unknown channel.

---

### GET /files/:fileId/text

The readable text of a text file or PDF, in pages. For members with `ViewChannel` on the file's channel, and for bots with access to that channel: this is how an agent reads a file it found with file search. Bots cannot use `GET /files/:fileId`.

**Query:** `offset` (characters to skip, default 0) · `limit` (characters to return, 1–50000, default 20000).

**Response** `200`
```json
{
  "id": "01M3...", "name": "collab-protocol.md", "mime": "text/markdown",
  "text": "# agora-collab Protocol v1 …",
  "offset": 0, "totalChars": 412, "hasMore": false, "truncated": false,
  "injectionWarning": false, "injectionChecked": true
}
```

- `hasMore`: ask again with `offset` = `offset + text.length`.
- `truncated`: the file is longer than the reading limits (20 MB, 50 PDF pages, 192,000 characters).
- `injectionWarning`: when the file was tagged, its text looked like it tries to give instructions to an AI. `injectionChecked` is `false` when no such check was made (file tagging off, or not done yet). File text is untrusted data in every case.

**Errors:** `404` unknown, deleted, not attached to a message, or in a channel the caller cannot see (the same answer for all four) · `415` no readable text (images, audio, video, archives, empty files) · `413` larger than 20 MB · `422` the file could not be parsed.

---

### GET /admin/settings/files

Current file limits.

**Auth:** Required (instance admin)

**Response** `200`
```json
{
  "files.max_size_bytes": 26214400,
  "files.allowed_extensions": ["jpg", "jpeg", "png", "gif", "webp", "pdf", "txt", "md", "zip", "mp3", "mp4", "mov", "csv", "json"],
  "files.retention_days": null,
  "files.storage_quota_bytes": null,
  "files.exif_strip": true
}
```

---

### PATCH /admin/settings/files

Change file limits. Send only the keys you want to change. The change is recorded in the admin audit log.

**Auth:** Required (instance admin)

| Field | Type | Constraints |
|---|---|---|
| `files.max_size_bytes` | number | 1024 to 104857600 (100 MB) |
| `files.allowed_extensions` | string[] | lowercase letters and digits only |
| `files.retention_days` | integer or null | 1 to 3650; `null` keeps files forever |
| `files.storage_quota_bytes` | integer or null | at least 1; `null` means no quota |
| `files.exif_strip` | boolean | strip metadata from uploaded images |

**Response** `200`
```json
{ "success": true }
```

Retention applies to files stored after the change: each file's expiry is set when it is stored.

---

## Unreads

### PUT /channels/:channelId/ack

Acknowledge messages up to a given message ID. Advances the read marker forward (never backwards) and resets `mention_count` to 0.

**Auth:** Required (must have access to the channel)

**Request Body**
```json
{
  "messageId": "01HYX..."
}
```

| Field       | Type   | Required | Constraints    |
|-------------|--------|----------|----------------|
| `messageId` | string | yes      | 1-26 characters |

**Response** `200`
```json
{
  "channelId": "01HYX...",
  "lastReadId": "01HYX...",
  "mentionCount": 0
}
```

**Errors**

| Status | Error                            | Cause                         |
|--------|----------------------------------|-------------------------------|
| 403    | `Not a member of this channel`   | User lacks channel access     |

---

### GET /channels/:channelId/unreads

Get unread state for a single channel.

**Auth:** Required (must have access to the channel)

**Response** `200`
```json
{
  "channelId": "01HYX...",
  "lastReadId": "01HYX...",
  "mentionCount": 2,
  "unreadCount": 15
}
```

| Field          | Type         | Description                                       |
|----------------|--------------|---------------------------------------------------|
| `channelId`    | string       | The channel ID                                    |
| `lastReadId`   | string/null  | ULID of the last acknowledged message             |
| `mentionCount` | number       | Number of unread @mentions for this user          |
| `unreadCount`  | number       | Total unread messages since `lastReadId`          |

**Errors**

| Status | Error                            | Cause                         |
|--------|----------------------------------|-------------------------------|
| 403    | `Not a member of this channel`   | User lacks channel access     |

---

### GET /unreads

Get unread state for all channels the user is a member of (server channels + DM channels).

**Auth:** Required

**Response** `200`
```json
[
  {
    "channelId": "01HYX...",
    "lastReadId": "01HYX...",
    "mentionCount": 0,
    "unreadCount": 5
  }
]
```

---

## Users

### GET /users/search

Search for users by username prefix. Excludes the authenticated user from results.

**Auth:** Required

**Query Parameters**

| Param | Type   | Required | Constraints |
|-------|--------|----------|-------------|
| `q`   | string | yes      | minLength: 1 |

**Response** `200`
```json
[
  { "id": "01HYX...", "username": "alice" },
  { "id": "01HYX...", "username": "alex" }
]
```

Returns up to 20 results. Matching is case-insensitive (`ILIKE`).

---

## Bots

Bot management endpoints. Most require `ManageBots` permission on the server. Token management routes additionally require the caller to be the bot's owner or a server administrator.

### POST /servers/:id/bots

Create a bot in a server. Returns the bot and an initial token (shown once).

**Auth:** Required (ManageBots permission)

**Request Body**
```json
{
  "name": "my-bot",
  "avatarUrl": "data:image/png;base64,..."
}
```

| Field      | Type   | Required | Constraints                    |
|------------|--------|----------|--------------------------------|
| `name`     | string | yes      | 1-32 characters                |
| `avatarUrl`| string | no       | data:image/* base64 URI, max 50KB |

**Response** `201`
```json
{
  "bot": {
    "id": "01HYX...",
    "username": "my-bot",
    "serverId": "01HYX...",
    "ownerId": "01HYX...",
    "avatarUrl": "data:image/png;base64,..."
  },
  "token": {
    "id": "01HYX...",
    "fullToken": "bot_01HYX.a1b2c3..."
  }
}
```

The `fullToken` is shown only on creation.

---

### GET /servers/:id/bots

List all bots in a server.

**Auth:** Required (ManageBots permission)

---

### PATCH /servers/:serverId/bots/:id/pause

Pause or resume a bot without revoking its tokens. A paused bot keeps read access (GETs and read-cursor updates) but every other request returns `423 { "error": "bot_paused", "reason", "pausedAt" }`. Written to the audit log as `bot_pause` / `bot_resume`.

**Auth:** Required (ManageBots permission). Bots cannot pause bots.

**Request Body**
```json
{
  "paused": true,
  "reason": "looping on the same diff"
}
```

**Response** `200` `{ "id", "pausedAt", "pausedReason" }` · `404` bot not in this server

---

### GET /bots/@me

Get the authenticated bot's own info. Includes `paused` and `pausedReason`.

**Auth:** Bot token required

**Response** `200`
```json
{
  "id": "01HYX...",
  "username": "my-bot",
  "serverId": "01HYX...",
  "channels": [
    { "id": "01HYX...", "name": "general" }
  ]
}
```

---

### PUT /bots/@me/cursors/:channelId

Update the bot's read cursor for a channel.

**Auth:** Bot token required

**Request Body**
```json
{
  "lastReadId": "01HYX..."
}
```

---

### GET /bots/@me/thread-cursors

List the bot's read cursors for threads. Channel cursors only cover top-level messages; thread replies are tracked per thread parent.

**Auth:** Bot token required

**Response** `200`
```json
[
  { "threadId": "01HYX...", "channelId": "01HYX...", "lastReadId": "01HYX...", "updatedAt": "2026-09-29T12:00:00.000Z" }
]
```

---

### PUT /bots/@me/thread-cursors/:threadId

Update the bot's read cursor for a thread. `:threadId` is the thread parent message ID.

**Auth:** Bot token required (bot must have access to the thread's channel)

**Request Body**
```json
{
  "lastReadId": "01HYX..."
}
```

**Response** `200` `{ "threadId", "channelId", "lastReadId" }` · `403` no channel access · `404` not a thread parent (unknown ID or a reply)

---

### PATCH /channels/:id/bot-config

Update per-channel bot configuration (loop guard limit).

**Auth:** Required (ManageBots permission or server owner)

**Request Body**
```json
{
  "maxBotHops": 10
}
```

| Field        | Type    | Required | Description                          |
|--------------|---------|----------|--------------------------------------|
| `maxBotHops` | integer | yes      | 0 = disabled, positive = limit       |

---

## AI Providers

Provider-agnostic AI configuration per server. **Adapters** are built-in API integrations (`anthropic`, `openai`, `gemini`, `tavily`, `typesafe`). **Providers** are configured instances of an adapter, each with its own encrypted key and optional base URL. **Capability routes** map a capability (`chat`, `search`, `image`, `tts`, `video`, `decide`) to a provider and model. The built-in assistant uses the `chat` route.

All endpoints require the **Administrator** permission in the server. Bots cannot call them. API keys are write-only: responses show `hasApiKey`, never the key.

| Method | Path | Purpose |
|---|---|---|
| GET | `/servers/:serverId/ai/adapters` | Available adapters: `id`, `label`, `capabilities`, `requiresApiKey`, `supportsBaseUrl`, `defaultModels` |
| GET | `/servers/:serverId/ai/providers` | Configured providers, with the capabilities each serves |
| POST | `/servers/:serverId/ai/providers` | `{ adapter, label?, apiKey?, baseUrl? }` → `201`; `409` duplicate label |
| PATCH | `/servers/:serverId/ai/providers/:providerId` | `{ label?, apiKey? (null clears), baseUrl?, enabled? }` |
| DELETE | `/servers/:serverId/ai/providers/:providerId` | Also removes routes pointing at it |
| POST | `/servers/:serverId/ai/providers/:providerId/test` | `{ model? }` → `{ ok, error? }` using the stored key |
| GET | `/servers/:serverId/ai/routes` | Capability routes |
| PUT | `/servers/:serverId/ai/routes/:capability` | `{ providerId, model, enabled?, dailyRequestLimit?, dailyTokenLimit?, dailyCostLimitMicros?, inputPriceMicrosPerMtok?, outputPriceMicrosPerMtok? }`. `enabled` defaults to `true` for `chat`, `false` otherwise. `400` if the adapter can't serve the capability |
| DELETE | `/servers/:serverId/ai/routes/:capability` | Remove a route |
| GET | `/servers/:serverId/ai/usage?days=30` | Per-capability requests, tokens, cost (micro-USD), errors, and today's totals |

**Budgets:** daily limits are UTC-day totals per capability. Once one is reached, calls are refused and the assistant posts a notice instead of answering. Cost is recorded only when the route has prices set, in micro-USD per 1M tokens.

**Base URLs** (the `openai` adapter: Ollama, OpenRouter, Groq, vLLM, …) must be http(s). Hosts that resolve to private, loopback or link-local addresses are rejected unless an instance admin enables `PATCH /admin/settings/ai { "allowPrivateBaseUrls": true }`, e.g. for a local Ollama server.

The older `/servers/:serverId/ai-config` endpoints still work. `PUT` upserts a provider plus the `chat` route plus the assistant bot in one call, and accepts `provider` values `claude` (legacy), `anthropic`, `openai` or `gemini`.

---

## Decision model

Optional. A decision model answers typed questions about a piece of text (yes/no, pick one, rate) and returns probabilities; it writes no text. The first adapter is `typesafe` (TypeSafe Jev). Configure it like any provider: add a `typesafe` provider with its key, then set the `decide` capability route. With no `decide` route, or with every use below switched off (the default), Agora makes no decision calls and behaves as it did before.

A decision informs Agora's code. It never grants access, loosens a limit, or picks a provider.

Four uses, each switched on separately:

| Use | What the model decides | Without it |
|---|---|---|
| `routing` | Which handler an explicit `@assistant` request goes to (chat, audio overview, search) | Keyword rules: "audio overview" / "podcast" → audio overview, else chat. Assistant search is not reachable |
| `search_screening` | Whether each piece of search result text tries to give instructions to the AI reading it | Results are returned as they came, marked `off` |
| `file_tagging` | Which of the server's tags apply to each uploaded text file or PDF | Files have no tags |
| `file_ranking` | How well each of the top candidate files answers a file search | File search orders by file names and stored tags |

All endpoints below require **Administrator**; bots cannot call them. Changes appear in `GET /servers/:serverId/ai/changes`.

### GET /servers/:serverId/ai/decisions

**Response** `200`
```json
{
  "uses": {
    "routing":          { "enabled": false, "sharePct": 25, "dailyRequests": null },
    "search_screening": { "enabled": false, "sharePct": 25, "dailyRequests": null },
    "file_tagging":     { "enabled": false, "sharePct": 25, "dailyRequests": null },
    "file_ranking":     { "enabled": false, "sharePct": 25, "dailyRequests": null }
  },
  "routingMinConfidence": 0.6,
  "screeningFlagThreshold": 0.7,
  "screeningSuspectThreshold": 0.35,
  "screeningStrict": false,
  "tagThreshold": 0.5,
  "route": { "configured": true, "enabled": true, "provider": "TypeSafe Jev (decisions)", "adapter": "typesafe", "model": "jev-latest" },
  "today": { "routing": { "requests": 0, "tokens": 0, "errors": 0 }, "search_screening": { }, "file_tagging": { }, "file_ranking": { } },
  "warnings": []
}
```

- `sharePct`: the part of the `decide` route's daily limits this use may spend. Shares total 100 or less and are not borrowed, so one use cannot starve another. `0` switches the use off.
- `dailyRequests`: a request cap for the use on its own. On a route with no daily limits this is what keeps uses apart.
- These are soft limits: they are counted from recorded usage, so calls in flight at the same moment can overshoot.
- `warnings` names settings that cannot work together, for example strict screening with a Gemini search route.

### PATCH /servers/:serverId/ai/decisions

Change any subset of the fields above (`uses` may name any subset of uses and fields).

**Errors:** `400` shares over 100%, a suspect threshold above the flag threshold, or nothing recognised to change.

### File tags

A tag is a yes/no question about a file. A decision model cannot invent tags: it answers one question per tag in this list.

| Method | Path | Purpose |
|---|---|---|
| GET | `/servers/:serverId/file-tags` | `[{ id, name }]` of enabled tags. Any member |
| GET | `/servers/:serverId/ai/tags` | `{ tags, max, queue }`: every tag with `instructions`, `criteriaTrue`, `criteriaFalse`, `revision`, `enabled`; and the tagging queue's counts (`pending`, `running`, `done`, `skipped`, `failed`, `stale`). The first call gives the server a default set of eight tags |
| POST | `/servers/:serverId/ai/tags` | `{ name, instructions, criteriaTrue?, criteriaFalse?, enabled? }` → `201`. `409` duplicate name (case-insensitive) or more than 255 tags |
| PATCH | `/servers/:serverId/ai/tags/:tagId` | Any subset. Changing the name, instructions or criteria raises `revision`; results made with an older revision are stale and the file is asked about that tag again |
| DELETE | `/servers/:serverId/ai/tags/:tagId` | Also removes the tag from every file |
| POST | `/servers/:serverId/ai/tags/retag` | `{ includeFailed? }` → `{ created, requeued, retried, queue }`. Queues files that have no job or stale results now, instead of waiting for the periodic sweep. `409` when file tagging is off |

`name`: 1–40 characters, starting with a letter or digit; letters, digits, spaces and `_ . & + / -`. `instructions` and each criteria field: up to 500 characters.

---

## Admin

All admin endpoints require the authenticated user to have `is_instance_admin = true`. The `requireInstanceAdmin` middleware checks this and returns `403 insufficient_permissions` if not satisfied.

### GET /admin/stats

Get high-level instance statistics.

**Auth:** Required (instance admin)

**Response** `200`
```json
{
  "totalUsers": 42,
  "pendingCount": 3,
  "serverCount": 5
}
```

---

### GET /admin/pending-users

List users with `pending` account status (awaiting approval).

**Auth:** Required (instance admin)

**Query Parameters**

| Param   | Type    | Required | Default | Constraints    |
|---------|---------|----------|---------|----------------|
| `page`  | integer | no       | 1       | minimum: 1     |
| `limit` | integer | no       | 20      | 1-100          |

**Response** `200`
```json
{
  "users": [
    {
      "id": "01HYX...",
      "username": "bob",
      "email": "bob@example.com",
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  ],
  "total": 3,
  "page": 1,
  "limit": 20
}
```

---

### GET /admin/users

List all users with optional filtering by status and search.

**Auth:** Required (instance admin)

**Query Parameters**

| Param    | Type    | Required | Default | Constraints                               |
|----------|---------|----------|---------|-------------------------------------------|
| `page`   | integer | no       | 1       | minimum: 1                                |
| `limit`  | integer | no       | 20      | 1-100                                     |
| `status` | string  | no       | -       | `"active"`, `"pending"`, or `"suspended"` |
| `search` | string  | no       | -       | Searches username and email (partial match, case-insensitive) |

**Response** `200`
```json
{
  "users": [
    {
      "id": "01HYX...",
      "username": "alice",
      "email": "alice@example.com",
      "accountStatus": "active",
      "isInstanceAdmin": false,
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 20
}
```

---

### POST /admin/approve-user/:id

Approve a pending user account, transitioning it from `pending` to `active`.

**Auth:** Required (instance admin)

**Response** `200`
```json
{
  "user": {
    "id": "01HYX...",
    "username": "bob",
    "email": "bob@example.com",
    "accountStatus": "active"
  }
}
```

**Errors**

| Status | Error              | Cause                             |
|--------|--------------------|-----------------------------------|
| 404    | `user_not_found`   | User ID does not exist            |
| 409    | `user_not_pending`  | User is not in `pending` status  |

---

### POST /admin/reject-user/:id

Reject and permanently delete a pending user account.

**Auth:** Required (instance admin)

**Response** `200`
```json
{
  "success": true
}
```

**Errors**

| Status | Error              | Cause                             |
|--------|--------------------|-----------------------------------|
| 404    | `user_not_found`   | User ID does not exist            |
| 409    | `user_not_pending`  | User is not in `pending` status  |

---

### POST /admin/users/:id/ban

Ban (suspend) an active user account. Cannot ban yourself or other admins. The older `/admin/users/:id/suspend` path was removed in 0.2.0.

**Auth:** Required (instance admin)

**Response** `200`
```json
{
  "user": {
    "id": "01HYX...",
    "username": "bob",
    "email": "bob@example.com",
    "accountStatus": "suspended"
  }
}
```

**Errors**

| Status | Error                   | Cause                                |
|--------|-------------------------|--------------------------------------|
| 400    | `cannot_suspend_self`   | Tried to suspend own account         |
| 400    | `cannot_suspend_admin`  | Target user is an instance admin     |
| 404    | `user_not_found`        | User ID does not exist               |
| 409    | `user_not_active`       | User is not in `active` status       |

**Side effects:** After the transaction commits, the suspended user's WebSocket connections are forcibly disconnected.

---

### PATCH /admin/instance

Update instance configuration. At least one field must be provided.

**Auth:** Required (instance admin)

**Request Body**
```json
{
  "instanceName": "New Name",
  "registrationPolicy": "approval"
}
```

| Field                | Type   | Required                              | Constraints                                  |
|----------------------|--------|---------------------------------------|----------------------------------------------|
| `instanceName`       | string | At least one of the two is required   | 1-100 characters                             |
| `registrationPolicy` | string | At least one of the two is required   | `"open"`, `"invite_only"`, or `"approval"`   |

**Response** `200`
```json
{
  "instanceName": "New Name",
  "registrationPolicy": "approval"
}
```

---

## WebSocket Gateway

The WebSocket gateway uses **Socket.IO** with `websocket`-only transport (no HTTP long-polling). Connect to the server's root URL.

### Connection

```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:3000", {
  transports: ["websocket"],
  auth: { token: "eyJhbG..." }
});
```

**Auth:** Token passed via `socket.handshake.auth.token`. Supports both JWT (human) and bot tokens (`Bot bot_<tokenId>.<secret>`). Human connections receive a `Ready` event; bot connections receive a `BotReady` event with a subset of data.

**Connection errors:**
- `instance_not_initialized` -- instance setup has not been completed
- `Authentication required` -- no token provided
- `Invalid token` -- JWT verification failed or user not found
- `account_pending` -- user account is pending approval
- `account_suspended` -- user account has been suspended

### Rooms

On connection, the server automatically joins the socket to:
- `user:{userId}` -- for user-targeted events (e.g., `ServerJoin`)
- `channel:{channelId}` -- for every channel the user has access to (server channels + DM channels)

---

### Server-to-Client Events

#### Ready

Emitted immediately after a successful connection. Contains the full initial state for the client.

```json
{
  "user": {
    "id": "01HYX...",
    "username": "alice"
  },
  "servers": [
    { "id": "01HYX...", "name": "My Server", "ownerId": "01HYX..." }
  ],
  "channels": [
    { "id": "01HYX...", "name": "general", "channelType": 3, "serverId": "01HYX..." },
    { "id": "01HYX...", "name": null, "channelType": 1, "serverId": null }
  ],
  "unreads": [
    { "channelId": "01HYX...", "lastReadId": "01HYX...", "mentionCount": 2 }
  ],
  "onlineUserIds": ["01HYX...", "01HYX..."]
}
```

| Field           | Type     | Description                                               |
|-----------------|----------|-----------------------------------------------------------|
| `user`          | object   | The authenticated user's `id` and `username`              |
| `servers`       | array    | All servers the user is a member of                       |
| `channels`      | array    | All channels (server + DM) the user has access to         |
| `unreads`       | array    | Read markers and mention counts for each channel          |
| `onlineUserIds` | string[] | User IDs currently online in shared servers               |

---

#### Message

Broadcast to `channel:{channelId}` when a new message is sent.

```json
{
  "id": "01HYX...",
  "content": "Hello world",
  "authorId": "01HYX...",
  "authorUsername": "alice",
  "authorBot": false,
  "authorAvatarUrl": null,
  "channelId": "01HYX...",
  "threadId": null,
  "createdAt": "2025-01-15T10:30:00.000Z",
  "mentions": ["01HYX..."],
  "mentionsEveryone": false
}
```

---

#### MessageUpdate

Broadcast to `channel:{channelId}` when a message is edited.

```json
{
  "id": "01HYX...",
  "channelId": "01HYX...",
  "content": "Updated content",
  "editedAt": "2025-01-15T11:00:00.000Z"
}
```

---

#### MessageDelete

Broadcast to `channel:{channelId}` when a message is soft-deleted.

```json
{
  "id": "01HYX...",
  "channelId": "01HYX...",
  "deletedAt": "2025-01-15T11:00:00.000Z"
}
```

---

#### ServerJoin

Emitted to `user:{userId}` when the user joins a new server (via invite).

```json
{
  "server": {
    "id": "01HYX...",
    "name": "My Server",
    "ownerId": "01HYX..."
  },
  "channels": [
    { "id": "01HYX...", "name": "general", "channelType": 3, "serverId": "01HYX..." }
  ]
}
```

After emitting, the server also joins the user's socket(s) to the new channel rooms automatically.

---

#### PresenceUpdate

Broadcast to all channel rooms when a user comes online or goes offline.

```json
{
  "userId": "01HYX...",
  "status": "online"
}
```

| Field    | Type   | Values                |
|----------|--------|-----------------------|
| `status` | string | `"online"`, `"offline"` |

Presence is tracked in-memory per socket. A user is considered online if they have at least one active socket connection. Going offline is broadcast only when the user's last socket disconnects.

---

#### BotReady

Emitted to bot connections after successful authentication. Subset of Ready with only the bot's accessible channels.

```json
{
  "user": { "id": "01HYX...", "username": "my-bot" },
  "channels": [
    { "id": "01HYX...", "name": "general", "channelType": 3, "serverId": "01HYX..." }
  ]
}
```

---

#### MessageMention

Emitted to the mentioned bot's socket when a message contains `@botname`. Gated by the `UseBots` permission on the channel.

```json
{
  "messageId": "01HYX...",
  "channelId": "01HYX...",
  "authorId": "01HYX...",
  "authorUsername": "alice",
  "content": "Hey @my-bot, do something",
  "mentionedUserId": "01HYX..."
}
```

---

#### ChannelLoopGuard

Emitted to the channel room when bot-to-bot conversation exceeds the channel's `max_bot_hops` limit.

```json
{
  "channelId": "01HYX...",
  "message": "Loop guard triggered — bot conversation limit reached"
}
```

---

#### ThreadMetadataUpdate

Emitted to the channel room when a thread's metadata changes (reply created/deleted, thread closed/reopened).

```json
{
  "messageId": "01HYX...",
  "channelId": "01HYX...",
  "replyCount": 5,
  "lastReplyAt": "2025-01-15T12:00:00.000Z",
  "threadClosedAt": null
}
```

---

### Client-to-Server Events

#### Typing

Send to indicate the user is typing in a channel. The server re-broadcasts this to all other sockets in the channel room.

**Client sends:**
```json
{ "channelId": "01HYX..." }
```

**Server broadcasts to channel (excluding sender):**
```json
{
  "channelId": "01HYX...",
  "userId": "01HYX...",
  "username": "alice"
}
```

---

## Health Check

### GET /health

Simple health check endpoint. No authentication required.

**Response** `200`
```json
{
  "status": "ok"
}
```

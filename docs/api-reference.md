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
- [Reactions](#reactions)
- [Unreads](#unreads)
- [Direct Messages](#direct-messages)
- [Users](#users)
- [Bots](#bots)
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

| Value | Type           |
|-------|----------------|
| `1`   | DM             |
| `3`   | Server Text    |
| `4`   | Server Voice   |
| `5`   | Server Category|

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

Authenticate with email and password.

**Auth:** None

**Request Body**
```json
{
  "email": "alice@example.com",
  "password": "securepassword"
}
```

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
| 401    | `invalid_credentials`| Email not found or password does not match |
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
    "createdAt": "2025-01-15T10:30:00.000Z",
    "reactions": [
      { "emoji": "\ud83d\udc4d", "count": 2, "me": true }
    ]
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

## Reactions

### PUT /channels/:channelId/messages/:msgId/reactions

Add a reaction to a message. Idempotent -- adding the same reaction twice is a no-op.

**Auth:** Required (must have access to the channel)

**Request Body**
```json
{
  "emoji": "\ud83d\udc4d"
}
```

| Field   | Type   | Required | Constraints      |
|---------|--------|----------|------------------|
| `emoji` | string | yes      | 1-32 characters  |

**Response** `200`
```json
{
  "messageId": "01HYX...",
  "emoji": "\ud83d\udc4d",
  "userId": "01HYX..."
}
```

**Errors**

| Status | Error                            | Cause                            |
|--------|----------------------------------|----------------------------------|
| 403    | `Not a member of this channel`   | User lacks channel access        |
| 404    | `Message not found`              | Message does not exist or is deleted |

**Side effects:** Broadcasts `ReactionAdd` event to the channel's Socket.IO room.

---

### DELETE /channels/:channelId/messages/:msgId/reactions/:emoji

Remove a reaction from a message. The `:emoji` path parameter should be URI-encoded.

**Auth:** Required (must have access to the channel)

**Response** `200`
```json
{
  "messageId": "01HYX...",
  "emoji": "\ud83d\udc4d",
  "userId": "01HYX..."
}
```

**Errors**

| Status | Error                            | Cause                                 |
|--------|----------------------------------|---------------------------------------|
| 403    | `Not a member of this channel`   | User lacks channel access             |
| 404    | `Reaction not found`             | User has not reacted with this emoji  |

**Side effects:** Broadcasts `ReactionRemove` event to the channel's Socket.IO room.

---

### GET /channels/:channelId/messages/:msgId/reactions

Get all reactions on a message, grouped by emoji.

**Auth:** Required (must have access to the channel)

**Response** `200`
```json
[
  {
    "emoji": "\ud83d\udc4d",
    "count": 3,
    "userIds": ["01HYX...", "01HYX...", "01HYX..."],
    "me": true
  }
]
```

| Field     | Type     | Description                                       |
|-----------|----------|---------------------------------------------------|
| `emoji`   | string   | The emoji character                               |
| `count`   | number   | Total number of users who reacted with this emoji |
| `userIds` | string[] | IDs of all users who reacted                      |
| `me`      | boolean  | Whether the authenticated user has this reaction  |

**Errors**

| Status | Error                            | Cause                         |
|--------|----------------------------------|-------------------------------|
| 403    | `Not a member of this channel`   | User lacks channel access     |

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

## Direct Messages

### POST /channels/dm

Create or retrieve a DM channel between the authenticated user and a recipient. Uses speculative insert with SAVEPOINT rollback to handle the race condition where two users create the same DM simultaneously.

**Auth:** Required

**Request Body**
```json
{
  "recipientId": "01HYX..."
}
```

| Field         | Type   | Required | Constraints |
|---------------|--------|----------|-------------|
| `recipientId` | string | yes      | minLength: 1 |

**Response** `201`
```json
{
  "id": "01HYX...",
  "channelType": 1
}
```

Returns `201` whether the DM channel was newly created or already existed.

**Errors**

| Status | Error                             | Cause                      |
|--------|-----------------------------------|----------------------------|
| 400    | `Cannot create DM with yourself`  | `recipientId` equals caller |
| 404    | `Recipient not found`             | User ID does not exist     |

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

### GET /bots/@me

Get the authenticated bot's own info.

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

### POST /admin/users/:id/suspend

Suspend an active user account. Cannot suspend yourself or other admins.

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

#### ReactionAdd

Broadcast to `channel:{channelId}` when a reaction is added.

```json
{
  "messageId": "01HYX...",
  "channelId": "01HYX...",
  "userId": "01HYX...",
  "emoji": "\ud83d\udc4d"
}
```

---

#### ReactionRemove

Broadcast to `channel:{channelId}` when a reaction is removed.

```json
{
  "messageId": "01HYX...",
  "channelId": "01HYX...",
  "userId": "01HYX...",
  "emoji": "\ud83d\udc4d"
}
```

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

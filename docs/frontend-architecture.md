# Frontend Architecture

The Agora frontend is a single-page React application that provides a Discord-like chat interface with real-time messaging, presence, reactions, and unread tracking.

## Tech Stack

| Dependency | Version | Purpose |
|---|---|---|
| React | 19.2 | UI framework |
| Vite | 7.3 | Build tool and dev server |
| Tailwind CSS | 4.1 (via `@tailwindcss/vite`) | Utility-first styling |
| Zustand | 5.0 | Lightweight state management |
| Socket.IO Client | 4.8 | Real-time WebSocket communication |
| TanStack Virtual | 3.13 | Virtualized message list scrolling |
| React Router | 7.13 | Client-side routing |
| TypeScript | 5.9 | Type safety |
| Vitest | 4.0 | Unit testing |

## Project Structure

```
agora-ui/src/
├── main.tsx                    # ReactDOM entry point (StrictMode)
├── App.tsx                     # BrowserRouter + route definitions + guard nesting
├── index.css                   # Tailwind base import
│
├── lib/
│   ├── api.ts                  # HTTP client (fetch wrapper with auth injection)
│   ├── socketFactory.ts        # Socket.IO instance factory
│   └── contracts/              # TypeScript interfaces shared with backend
│       ├── auth.ts             # LoginRequest, RegisterRequest, User, AuthResponse
│       ├── server.ts           # Server, Channel, Member, invite/join types
│       ├── instance.ts         # InstanceStatus, RegistrationPolicy
│       ├── admin.ts            # AdminStats, AdminUser, PendingUser, InstanceConfig
│       └── ws-events.ts        # All WebSocket event payload types
│
├── stores/                     # Zustand state stores (10 stores)
│   ├── authStore.ts
│   ├── serverStore.ts
│   ├── channelStore.ts
│   ├── messageStore.ts
│   ├── memberStore.ts
│   ├── unreadStore.ts
│   ├── reactionStore.ts
│   ├── typingStore.ts
│   ├── presenceStore.ts
│   └── uiStore.ts
│
├── hooks/
│   ├── useSocket.ts            # Context hook for Socket.IO instance
│   └── useInstance.ts          # Fetch /instance/status on mount
│
├── components/
│   └── ui/                     # Reusable primitives
│       ├── Button.tsx
│       ├── Input.tsx
│       ├── Modal.tsx
│       └── ConfirmDialog.tsx
│
└── features/                   # Feature modules (see section below)
    ├── setup/                  # Instance initialization guard + setup wizard
    ├── auth/                   # Login, register, pending approval
    ├── admin/                  # Admin dashboard, user management
    ├── shell/                  # App chrome: layout, socket lifecycle, sidebar
    ├── servers/                # Server/channel CRUD, invites, members
    ├── messages/               # Message list, input, grouping, actions
    └── live/                   # Real-time UI: typing, presence, reactions, unreads, mentions
```

## Routing and Guards

The route tree is defined in `App.tsx`. Three guard components wrap routes to enforce preconditions before rendering children. Guards are nested in a specific order:

```
BrowserRouter
└── InstanceGuard              ← Ensures backend is initialized
    ├── /login                 ← LoginPage
    ├── /register              ← RegisterPage
    ├── /pending               ← PendingApprovalPage
    ├── /admin/*               ← AuthGuard → AdminGuard → AdminLayout
    │   ├── /admin             ← AdminDashboard
    │   ├── /admin/pending     ← PendingQueue
    │   ├── /admin/users       ← UserTable
    │   └── /admin/settings    ← InstanceSettings
    ├── /app/*                 ← AuthGuard → SocketProvider → AppShell
    │   ├── /app/:serverId/:channelId   ← Server channel view
    │   └── /app/dms/:channelId         ← DM channel view
    └── *                      ← Redirect to /login
```

### InstanceGuard (`features/setup/InstanceGuard.tsx`)

Calls `GET /instance/status` via the `useInstance()` hook on mount. Shows:
- Spinner while loading
- Error screen if the server is unreachable
- `SetupWizard` if `data.initialized` is `false`
- Children if the instance is initialized

### AuthGuard (`features/auth/AuthGuard.tsx`)

Reads `token` and `status` from `authStore`. Redirects:
- `status === 'pending'` --> `/pending`
- No token and not authenticated --> `/login`

### AdminGuard (`features/admin/AdminGuard.tsx`)

Checks `user.isInstanceAdmin` from `authStore`. Shows "Access denied" if the user is not an instance admin.

### SocketProvider (`features/shell/SocketProvider.tsx`)

Not a route guard per se, but wraps the entire `/app/*` subtree. Creates and manages the Socket.IO connection lifecycle. Detailed in the [WebSocket Integration](#websocket-integration) section below.

## State Management (Zustand Stores)

All application state lives in 10 Zustand stores. Stores are vanilla `create()` calls (no middleware). They use `Map` objects for indexed lookups and expose action methods directly on the store interface.

### authStore

```typescript
interface AuthState {
  token: string | null;
  user: User | null;               // { id, username, isInstanceAdmin? }
  status: 'idle' | 'loading' | 'authenticated' | 'pending';
  login(email: string, password: string): Promise<void>;
  register(data: RegisterRequest): Promise<void>;
  logout(): void;
}
```

- On login/register success: sets `token`, `user`, and `status: 'authenticated'`
- On `account_pending` error: sets `status: 'pending'` (no token)
- On `logout()`: clears own state **and** calls `clear()` on all other stores
- Wires the API client's token getter at module load via `setTokenGetter()`

### serverStore

```typescript
interface ServerState {
  servers: Map<string, Server>;     // { id, name, ownerId }
  activeServerId: string | null;
  setServers(servers: Server[]): void;
  setActiveServer(id: string | null): void;
  addServer(server: Server): void;
  removeServer(id: string): void;
  clear(): void;
}
```

- `setServers()` replaces the entire Map (used by Ready event)
- `addServer()` called on `ServerJoin` WebSocket event

### channelStore

```typescript
interface ChannelState {
  channels: Map<string, Channel>;   // { id, name, channelType, serverId }
  activeChannelId: string | null;
  setChannels(channels: Channel[]): void;
  setActiveChannel(id: string | null): void;
  addChannel(channel: Channel): void;
  addChannels(channels: Channel[]): void;
  removeChannelsByServer(serverId: string): void;
  byServer(serverId: string): Channel[];     // derived filter
  dmChannels(): Channel[];                   // channels where serverId === null
  clear(): void;
}
```

- `byServer()` and `dmChannels()` are computed on each call (filter over Map values)
- `channelType === 3` is text channel; used for filtering in sidebar

### messageStore

```typescript
interface MessageState {
  byChannel: Map<string, Message[]>;    // channelId → ordered messages
  hasMore: Map<string, boolean>;        // channelId → has older messages

  loadMessages(channelId: string): Promise<void>;   // Initial page (50 msgs)
  loadOlder(channelId: string): Promise<void>;       // Pagination (prepend)
  sendMessage(channelId, content, authorId, authorUsername): Promise<void>;
  editMessage(channelId, msgId, content): Promise<void>;
  deleteMessage(channelId, msgId): Promise<void>;

  addMessage(msg: MessagePayload): void;        // From WS 'Message' event
  updateMessage(payload: MessageUpdatePayload): void;
  removeMessage(payload: MessageDeletePayload): void;

  clearChannel(channelId: string): void;
  clear(): void;
}
```

Message interface:

```typescript
interface Message {
  id: string;
  content: string | null;       // null when deleted
  authorId: string;
  authorUsername: string;
  channelId: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  pending?: boolean;            // Optimistic send in flight
  failed?: boolean;             // Send failed
}
```

Page size is 50 messages. API returns newest-first; the store reverses to chronological order. See [Optimistic Sends](#optimistic-message-sending) for the send/confirm/fail lifecycle.

### memberStore

```typescript
interface MemberState {
  byServer: Map<string, Member[]>;
  loadMembers(serverId: string): Promise<void>;
  clear(): void;
}
```

- Uses a module-level `Set<string>` to deduplicate in-flight fetch requests
- Members are loaded lazily (on demand from MentionAutocomplete or MembersSidebar)

### unreadStore

```typescript
interface UnreadEntry {
  lastReadId: string | null;
  mentionCount: number;
  unreadCount: number;
}

interface UnreadState {
  byChannel: Map<string, UnreadEntry>;
  setUnreads(unreads: { channelId: string; lastReadId: string | null; mentionCount: number }[]): void;
  markRead(channelId: string, messageId: string): void;
  incrementUnread(channelId: string): void;
  incrementMention(channelId: string): void;
  getUnread(channelId: string): UnreadEntry | null;
  clear(): void;
}
```

- `setUnreads()` replaces all entries (from Ready event)
- `incrementUnread()` / `incrementMention()` called for messages arriving on non-active channels
- `markRead()` resets both counts to 0 and updates `lastReadId`

### reactionStore

```typescript
interface Reaction {
  emoji: string;
  count: number;
  userIds: string[];
  me: boolean;                  // Whether the current user reacted
}

interface ReactionState {
  byMessage: Map<string, Reaction[]>;
  setReactions(messageId: string, reactions: Reaction[]): void;
  addReaction(messageId, emoji, userId, me): void;
  removeReaction(messageId, emoji, userId, me): void;
  getReactions(messageId: string): Reaction[];
  clear(): void;
}
```

- Hydrated from message payloads when `loadMessages()` / `loadOlder()` runs
- Updated in real-time from `ReactionAdd` / `ReactionRemove` WS events
- `addReaction` deduplicates by checking `userIds.includes(userId)`

### typingStore

```typescript
interface TypingState {
  byChannel: Map<string, Map<string, TypingEntry>>;   // channelId → userId → entry
  addTyping(channelId, userId, username): void;
  removeTyping(channelId, userId): void;
  getTypingUsers(channelId: string): string[];         // Returns usernames
  clear(): void;
}
```

- Each entry has a 3-second auto-expire timeout (via `setTimeout`)
- `addTyping()` resets the timeout if the user is already typing
- `clear()` properly clears all timeouts to prevent leaks

### presenceStore

```typescript
type PresenceStatus = 'online' | 'idle' | 'offline';

interface PresenceState {
  status: Map<string, PresenceStatus>;
  setPresence(userId: string, status: PresenceStatus): void;
  setOnlineUsers(userIds: string[]): void;     // Bulk set from Ready
  getStatus(userId: string): PresenceStatus;   // Defaults to 'offline'
  clear(): void;
}
```

### uiStore

```typescript
type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

interface UIState {
  sidebarOpen: boolean;
  membersOpen: boolean;
  activeModal: string | null;
  connectionStatus: ConnectionStatus;
  toggleSidebar(): void;
  toggleMembers(): void;
  setModal(modal: string | null): void;
  setConnectionStatus(status: ConnectionStatus): void;
}
```

## WebSocket Integration

### Socket Factory (`lib/socketFactory.ts`)

```typescript
export function createSocket(token: string): Socket {
  return io('/', {
    transports: ['websocket'],   // No HTTP polling fallback
    auth: { token },
    autoConnect: false,          // Manual connect after event handlers are set up
  });
}
```

A new socket is created each time the token changes. There is no singleton -- the factory returns a fresh instance, and the old one is cleaned up by `SocketProvider`.

### SocketProvider (`features/shell/SocketProvider.tsx`)

The `SocketProvider` wraps the entire `/app/*` route subtree. It owns the socket lifecycle and wires all event handlers to store actions.

**Lifecycle:**

1. When `token` is available, create a socket via `createSocket(token)`
2. Register all event handlers
3. Call `s.connect()` -- connection is manual since `autoConnect: false`
4. On unmount (or token change), remove all listeners and disconnect

**Connection status tracking:**

| Socket.IO Event | Store Action |
|---|---|
| `connect` | `setConnectionStatus('connected')` |
| `disconnect` | `setConnectionStatus('disconnected')` |
| `reconnect_attempt` | `setConnectionStatus('reconnecting')` |

**Ready event -- full state hydration:**

When the server sends `Ready`, the provider **replaces** (not merges) all stores:

```
setServers(data.servers)          // Replace server Map
setChannels(data.channels)        // Replace channel Map
messageStore.clear()              // Drop all cached messages
typingStore.clear()               // Clear typing indicators
reactionStore.clear()             // Clear cached reactions
unreadStore.setUnreads(data.unreads)
presenceStore.setOnlineUsers(data.onlineUserIds)
```

This makes reconnection safe -- the same Ready handler runs on initial connect and every reconnect, producing identical state.

**Event handler mapping:**

| WS Event | Store Action | Notes |
|---|---|---|
| `Message` | `messageStore.addMessage()` | Also increments unread/mention for non-active channels |
| `MessageUpdate` | `messageStore.updateMessage()` | |
| `MessageDelete` | `messageStore.removeMessage()` | Soft delete: sets `content: null` |
| `ServerJoin` | `serverStore.addServer()` + `channelStore.addChannels()` | |
| `Typing` | `typingStore.addTyping()` | Auto-expires after 3s |
| `PresenceUpdate` | `presenceStore.setPresence()` | |
| `ReactionAdd` | `reactionStore.addReaction()` | Computes `me` flag from current user ID |
| `ReactionRemove` | `reactionStore.removeReaction()` | |

**Fatal connection errors:**

If `connect_error` fires with one of these messages, the user is logged out:
- `Invalid token`
- `Authentication required`
- `account_pending`
- `account_suspended`

### useSocket Hook (`hooks/useSocket.ts`)

```typescript
export function useSocket() {
  return useContext(SocketContext);   // Returns Socket | null
}
```

Components use this to emit events (e.g., `socket.emit('Typing', { channelId })`).

### SocketContext (`features/shell/SocketContext.ts`)

```typescript
export const SocketContext = createContext<Socket | null>(null);
```

## API Client (`lib/api.ts`)

### Request Wrapper

A generic `request<T>()` function wraps `fetch`:

- Automatically sets `Content-Type: application/json`
- Injects `Authorization: Bearer <token>` header if a token is available
- Parses JSON response
- Throws `ApiError` on non-2xx responses

```typescript
class ApiError extends Error {
  status: number;   // HTTP status code
  code: string;     // Error code from response body (e.g., 'account_pending')
}
```

### Token Injection

To avoid circular imports between `api.ts` and `authStore.ts`, the API client uses a deferred token getter:

```typescript
let getToken: () => string | null = () => null;
export function setTokenGetter(fn: () => string | null) { getToken = fn; }
```

`authStore.ts` calls `setTokenGetter(() => useAuthStore.getState().token)` at module load time.

### Namespace Helpers

```typescript
// Server operations
serverApi.createServer(name)
serverApi.createChannel(serverId, name, channelType)
serverApi.createInvite(serverId)
serverApi.joinServer(code)
serverApi.getMembers(serverId)
serverApi.getChannels(serverId)

// User search
userApi.searchUsers(query)

// Direct messages
dmApi.createDM(recipientId)
```

## Type Contracts (`lib/contracts/`)

TypeScript interfaces that define the shape of data exchanged between frontend and backend. These are **not** shared code -- they are manually kept in sync with the backend schemas.

| File | Key Types |
|---|---|
| `auth.ts` | `LoginRequest`, `RegisterRequest`, `User`, `AuthResponse`, `PendingResponse` |
| `server.ts` | `Server`, `Channel`, `Member`, `CreateServerResponse`, `InviteResponse`, `JoinServerResponse`, `UserSearchResult`, `CreateDMResponse` |
| `instance.ts` | `InstanceStatus`, `RegistrationPolicy` |
| `admin.ts` | `AdminStats`, `AdminUser`, `PendingUser`, `PaginatedUsers`, `InstanceConfig` |
| `ws-events.ts` | `ReadyPayload`, `MessagePayload`, `MessageUpdatePayload`, `MessageDeletePayload`, `ServerJoinPayload`, `TypingPayload`, `PresenceUpdatePayload`, `ReactionAddPayload`, `ReactionRemovePayload` |

## Key Patterns

### Optimistic Message Sending

The `messageStore.sendMessage()` method implements a three-phase optimistic update:

**Phase 1 -- Optimistic insert:**
A message with `id: 'pending-{timestamp}'` and `pending: true` is appended to the channel's message array immediately. This makes the message appear in the UI with reduced opacity.

**Phase 2 -- POST response reconciliation:**
When the server responds with the real message ID:
- If the WebSocket `Message` event already delivered this message (WS won the race), remove the optimistic row
- Otherwise, remap the optimistic message's ID from `pending-*` to the real ID, keeping `pending: true`

**Phase 3 -- WebSocket confirmation:**
When `addMessage()` is called from the WS `Message` event:
- If a `pending` message exists with the same real ID, replace it with the confirmed server version (clears `pending`)
- If no pending match exists and the ID is not already in the array, append as a new message
- If the ID is already present (duplicate), ignore

**Failure:**
If the POST fails, the optimistic message gets `pending: false, failed: true` and displays "Failed to send" in the UI.

**Edit and delete** also use optimistic updates with rollback on failure:
- `editMessage()`: immediately updates content, reverts to original on error
- `deleteMessage()`: immediately sets `content: null` and `deletedAt`, reverts on error

### Virtual Scrolling

`MessageList` uses `@tanstack/react-virtual`'s `useVirtualizer` to render only visible messages:

```typescript
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => parentRef.current,
  estimateSize: (index) => estimateMessageHeight(prev, messages[index]),
  overscan: 15,
  getItemKey: (index) => messages[index]?.id ?? String(index),
});
```

- **Estimated sizes** are computed by `estimateMessageHeight()`: 64px for a non-grouped message, 28px for a grouped message, and 48px/28px for deleted messages
- **Actual sizes** are measured by `virtualizer.measureElement` (via `ref` on each row)
- **Overscan of 15** pre-renders 15 items above and below the viewport for smooth scrolling

Items are positioned absolutely with `transform: translateY()` inside a container whose height equals `virtualizer.getTotalSize()`.

### Scroll Anchoring on Prepend

When older messages are loaded (prepended to the array), the viewport must stay anchored to the same visual position. This is a two-phase process:

**Phase 1 -- Estimate-based shift** (in `useLayoutEffect`, synchronous):
```typescript
const shift = computePrependShift(messages, prependedCount);
el.scrollTop += shift;
```
`computePrependShift` sums the estimated heights of all prepended items. This is self-consistent with the virtualizer's initial positioning.

**Phase 2 -- Measurement-based correction** (in `useEffect`, after paint):
After the browser paints and `ResizeObserver` measures actual heights, a double-`requestAnimationFrame` callback reads the anchor element's measured position and applies the delta:
```typescript
const delta = computeScrollCorrection(anchorRect, containerRect, scrollTop, estimatedOffset);
if (delta !== 0) el.scrollTop += delta;
```

### Message Grouping

Consecutive messages from the same author within a 5-minute window are "grouped" -- they display without the avatar and username header, showing only the message content with reduced vertical padding.

```typescript
// grouping.ts
const GROUP_THRESHOLD_MS = 5 * 60 * 1000;

function shouldGroup(prev: MessageLike | undefined, curr: MessageLike): boolean {
  if (!prev) return false;
  if (prev.deletedAt || curr.deletedAt) return false;
  if (prev.authorId !== curr.authorId) return false;
  const diff = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return diff < GROUP_THRESHOLD_MS;
}
```

Deleted messages break grouping chains.

### Mention Autocomplete

When the user types `@` in the message input, `MentionAutocomplete` appears:

1. `MessageInput.handleChange()` detects `@(\w*)$` pattern before the cursor
2. Sets `mentionQuery` and `showMentions = true`
3. `MentionAutocomplete` lazy-loads server members via `memberStore.loadMembers()`
4. Filters members by username prefix match, limited to 5 results
5. Keyboard navigation (Arrow Up/Down, Enter/Tab to select, Escape to close)
6. On selection, replaces `@query` with `@username ` in the input

The autocomplete captures keyboard events at the document level when visible, preventing the message input from handling Enter/Tab.

### Unread Tracking with ACK

Unreads are tracked per-channel with two dimensions: `unreadCount` (any message) and `mentionCount` (messages that mention the user).

**Hydration:** The `Ready` WebSocket event includes `unreads[]` with `{ channelId, lastReadId, mentionCount }`.

**Increment:** When a `Message` event arrives for a non-active channel:
- Always increments `unreadCount`
- If the message mentions the current user (via `mentions[]` or `mentionsEveryone`), also increments `mentionCount`

**ACK (mark as read):** Happens in two places:
- `MessageList`: ACKs after initial message load for a channel
- `ChannelSidebar`: ACKs immediately when clicking a channel if messages are already loaded

Both send `PUT /channels/:channelId/ack` with `{ messageId }` and call `unreadStore.markRead()` locally.

**Badge display** (`UnreadBadge` component):
- `mentionCount > 0`: red pill with count number
- `unreadCount > 0` (no mentions): small gray dot
- Neither: nothing

### New Messages Pill

When the user scrolls up and new messages arrive, a `NewMessagesPill` appears showing the count of unseen messages. Clicking it smooth-scrolls to the bottom. The pill auto-clears when the user scrolls back to the bottom.

### Load-Older Trigger

When the user scrolls within 200px of the top of the message list, `loadOlder()` fires to fetch the next page. A loading guard (`loadingOlderRef`) prevents concurrent fetches. A visual indicator appears at the top during loading.

## Feature Modules

### `features/setup/`

| Component | Purpose |
|---|---|
| `InstanceGuard` | Blocks rendering until `GET /instance/status` confirms the instance is initialized |
| `SetupWizard` | Three-step first-run flow: setup token, admin account, and instance settings |

### `features/auth/`

| Component | Purpose |
|---|---|
| `LoginPage` | Email/password login form; calls `authStore.login()` |
| `RegisterPage` | Username/email/password registration; calls `authStore.register()` |
| `PendingApprovalPage` | Shown when account status is `pending` (approval-required instances) |
| `AuthGuard` | Redirects unauthenticated/pending users |

### `features/admin/`

| Component | Purpose |
|---|---|
| `AdminGuard` | Blocks non-admin users |
| `AdminLayout` | Sidebar navigation for admin routes |
| `AdminDashboard` | Stats overview (total users, pending, servers) |
| `PendingQueue` | Approve/reject pending user registrations |
| `UserTable` | List all users with status management |
| `InstanceSettings` | Edit instance name and registration policy |

### `features/shell/`

The app chrome -- everything visible after login.

| Component | Purpose |
|---|---|
| `SocketProvider` | Creates Socket.IO connection, wires WS events to stores |
| `SocketContext` | React context holding `Socket \| null` |
| `AppShell` | Three-column layout: ServerRail + ChannelSidebar + ContentArea + optional MembersSidebar |
| `ServerRail` | Vertical icon strip: DM button, server icons (first letter), add server menu |
| `ChannelSidebar` | Channel list for active server (or DM list), invite/create buttons, user panel |
| `ContentArea` | Channel header + MessageList + TypingIndicator + MessageInput |
| `UserPanel` | Current user info with presence dot and connection indicator |
| `ConnectionIndicator` | Green/yellow/red dot showing WebSocket connection status |

**AppShell layout:**
```
┌─────────┬──────────┬───────────────────────────┬──────────┐
│ Server  │ Channel  │       Content Area        │ Members  │
│  Rail   │ Sidebar  │  ┌─────────────────────┐  │ Sidebar  │
│  72px   │  240px   │  │   Message List       │  │ (toggle) │
│         │          │  │   (virtual scroll)   │  │          │
│  [DM]   │  #gen    │  │                      │  │          │
│  ──     │  #random │  │                      │  │          │
│  [S1]   │  #dev    │  ├─────────────────────┤  │          │
│  [S2]   │          │  │ Typing indicator     │  │          │
│  ──     │          │  ├─────────────────────┤  │          │
│  [+]    │ UserPanel│  │ Message input        │  │          │
└─────────┴──────────┴──┴─────────────────────┴──┴──────────┘
```

**URL-to-state sync:** `AppShell` reads URL params from `/app/*` and syncs them to `serverStore.activeServerId` and `channelStore.activeChannelId`. On server change with no channel in the URL, it auto-selects the first text channel and navigates.

### `features/servers/`

| Component | Purpose |
|---|---|
| `CreateServerModal` | Form to create a new server |
| `JoinServerModal` | Enter invite code to join a server |
| `InviteModal` | Generate and display invite code for a server |
| `CreateChannelModal` | Form to create a new text channel |
| `NewDMModal` | Search users and create a DM channel |
| `UserSearch` | Debounced user search input (used by NewDMModal) |
| `MembersSidebar` | Right sidebar listing server members with presence dots |

### `features/messages/`

| Component | Purpose |
|---|---|
| `MessageList` | Virtualized scrollable message list with pagination and scroll anchoring |
| `MessageItem` | Single message row: avatar, username, timestamp, content, reactions. Handles grouped/ungrouped layout |
| `MessageInput` | Textarea with auto-resize, Enter-to-send, Shift+Enter for newlines, typing indicator emission, @mention detection |
| `MessageActions` | Hover overlay with edit/delete buttons (own messages only) |
| `EditMessageInput` | Inline edit textarea (replaces content when editing) |
| `EmptyChannel` | Empty state shown when a channel has no messages |
| `NewMessagesPill` | Floating pill showing count of new messages below viewport |
| `grouping.ts` | `shouldGroup()`, `estimateMessageHeight()`, `computePrependShift()`, `computeScrollCorrection()` |

### `features/live/`

Real-time UI components driven by WebSocket events.

| Component | Purpose |
|---|---|
| `TypingIndicator` | "X is typing" / "X and Y are typing" with animated dots |
| `PresenceDot` | Colored dot (green/yellow/gray) showing user online status |
| `UnreadBadge` | Red mention-count pill or gray unread dot next to channel names |
| `ReactionBar` | Emoji reaction buttons below a message with add-reaction button |
| `ReactionPicker` | Categorized emoji grid popup (Smileys, Gestures, Hearts, Objects) |
| `MentionAutocomplete` | Popup member list filtered by @-query with keyboard navigation |

## Development

### Dev Server

```bash
cd agora-ui
npm run dev
```

Vite serves the frontend on its default port (usually 5173) and proxies API requests to the backend at `localhost:3000`.

### Proxy Configuration (`vite.config.ts`)

All API paths and the WebSocket endpoint are proxied:

```typescript
proxy: {
  '/auth':      'http://localhost:3000',
  '/instance':  'http://localhost:3000',
  '/servers':   'http://localhost:3000',
  '/channels':  'http://localhost:3000',
  '/invites':   'http://localhost:3000',
  '/admin':     'http://localhost:3000',
  '/users':     'http://localhost:3000',
  '/health':    'http://localhost:3000',
  '/socket.io': { target: 'http://localhost:3000', ws: true },
}
```

### Build

```bash
cd agora-ui
npm run build     # tsc compile + Vite production build
npm run lint      # ESLint
npm run test      # Vitest (unit tests)
```

### HMR

Vite provides Hot Module Replacement out of the box. Zustand stores preserve state across HMR updates because they are module-level singletons.

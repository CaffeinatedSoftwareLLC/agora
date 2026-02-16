# Arc V2 Design Specification

This document defines the design direction for Agora's frontend UI redesign. The chosen design is **Arc V2 ("Arc Purple Compact")** — a tab-based navigation system with a home hub, per-server accent tinting, and a floating pill message input. A working mockup lives at `agora-ui/src/features/design-showcase/ArcV2.tsx`.

**Reference that file directly** for exact spacing, colors, and layout details. This doc captures the principles and structure so you don't have to reverse-engineer intent from 1,200 lines of JSX.

## Design Principles

1. **No server rail.** Discord's left-edge icon strip is replaced by a horizontal tab bar at the top. Servers are tabs, not icons. This gives more horizontal space and makes the active context obvious.

2. **Home is a first-class destination.** The leftmost tab is always "Home" — it's not a server, it's where you see all your servers and DMs. The home tab has two sub-views: "Servers" (your joined servers, pinned and unpinned) and "Explore" (discover public servers).

3. **Per-server accent tinting.** Each server has a color. When you switch to a server tab, that color subtly tints the tab bar gradient, the channel sidebar header, the active channel indicator, reaction highlights, and the send button. This gives each server a unique feel without being garish.

4. **Floating pill message input.** The message input is a rounded, glass-blurred pill at the bottom of the content area — not a flat bar glued to the edge. It has subtle borders, a backdrop blur, and the border/glow shift to the accent color when text is entered.

5. **Two palettes, one layout.** The entire UI is palette-agnostic. Every color reference goes through a palette object (`P`). Switching palettes changes every surface, border, and text color. The layout and component structure stay identical.

6. **Original user panel.** The user panel at the bottom of every sidebar matches the existing Agora design: avatar with a gradient ring (orange-to-purple), presence dot (bottom-left), username, "Online" status text, mic button, and settings gear.

7. **Breathing room over density.** Message spacing is generous. Server rows in the home view are tall enough to show a last-message preview. The tab bar has padding. This is not a power-user-density design — it prioritizes scannability.

## Palettes

Two palettes are defined. The app should support switching between them (user preference, persisted to local storage or user settings).

### Aegean & Marble (default)

Named colors: Tech Blue (#0D5EAF), Pacific Blue (#0FA3B1), Midnight Violet (#241623), Porcelain (#FDFFF7).

```
bg:           #241623    — Midnight Violet — App background, deepest layer
surface:      #332838    — lighter Midnight Violet — Cards, sidebars, elevated panels
surfaceHover: #3E3345    — Hover state on surface elements
primary:      #0D5EAF    — Tech Blue — Primary action buttons, links
primaryHover: #0B4E95    — Primary hover state
accent:       #0FA3B1    — Pacific Blue — Accent highlights, gradient endpoints, active indicators
text:         #FDFFF7    — Porcelain — Primary text
white:        #FCFCFC    — Pure white for high-contrast elements
muted:        #A09AAB    — Secondary text (labels, timestamps)
dim:          #6E6479    — Tertiary text (placeholders, disabled, category headers)
border:       #3A2E3E    — Dividers, card borders
online:       #4ADE80    — Presence: online
danger:       #EF4444    — Destructive actions, error badges
warn:         #FBBF24    — Presence: idle, warning states
```

### Terracotta & Stone (alt)

Named colors: Chocolate (#C2703E), Fern (#65743A), Coffee Bean (#1C1410), Honeydew (#EBF5DF), Frozen Water (#D5FFF3).

```
bg:           #1C1410    — Coffee Bean — App background, deepest layer
surface:      #2A2018    — lighter Coffee Bean — Cards, sidebars, elevated panels
surfaceHover: #362A20    — Hover state on surface elements
primary:      #C2703E    — Chocolate — Primary action buttons, links
primaryHover: #A85F34    — Primary hover state
accent:       #D5FFF3    — Frozen Water (mint) — Accent highlights, active indicators
text:         #EBF5DF    — Honeydew — Primary text
white:        #FCFCFC    — Pure white for high-contrast elements
muted:        #9B8B7A    — Secondary text (warm brown-gray)
dim:          #6E5D4E    — Tertiary text (warm dark brown)
border:       #352820    — Dividers, card borders
online:       #4ADE80    — Presence: online
danger:       #EF4444    — Destructive actions, error badges
warn:         #FBBF24    — Presence: idle, warning states
```

**Note:** Terracotta & Stone also defines a secondary color, Fern (#65743A), for use in nature/organic UI accents (e.g., success states, server category badges) where the mint accent would be too cold.

### Using Palettes in Components

```typescript
// The palette is a plain object — pass it through props or context
const P = usePalette(); // or receive as prop
// P is either AEGEAN or TERRACOTTA — same shape, different values

// Every color reference uses P
style={{ background: P.surface, color: P.text, borderColor: P.border }}

// Accent tinting uses the server's color, NOT P.accent
// P.accent is the fallback when no server is active (e.g., home view)
const accentColor = activeServer?.color || P.accent;
```

## Layout Structure

### Top-Level Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Home] │ [Server1] [Server2] [Server3] ...  │ [Palette] [Search] [Bell] │
│  ═══════════════════ accent gradient bar ═══════════════════════  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│              View content (Home or Server)                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

The top tab bar is always present. It contains:
- **Home tab** (leftmost, with house icon) — always visible, shows total unread badge when not active
- **Server tabs** — one per recently opened server, each with a colored dot, name, and unread badge
- **Right controls** — palette toggle, search pill (`Ctrl+K`), notification bell

A 1px accent gradient bar separates the tab bar from the content area. Its color shifts based on the active tab's accent.

### Home View

When the Home tab is active, the content area splits into two panels:

```
┌─────────────┬───────────────────────────────────────┐
│  DM Sidebar │         Server List / Explore          │
│   (260px)   │                                        │
│             │  Welcome back, Eryk                    │
│  Messages   │  20 unread messages across 3 servers   │
│  ─────────  │                                        │
│  [Search]   │  [Servers]  [Explore]                  │
│             │  ─────────────────────                 │
│  Mira  5m   │  ▎ Pinned                              │
│  Kai  23m   │  ▎ Agora Dev      🟢 12  2m   [5]     │
│  Jordan 1h  │  ▎ PlantBeat      🟢 6   8m   [3]     │
│  Sam   3h   │                                        │
│             │  ▎ All Servers                          │
│             │  ▎ SNHU Study...  🟢 34  15m  [12]     │
│             │  ▎ Origami Club   🟢 67  1h            │
│             │                                        │
│ ┌─────────┐ │                                        │
│ │UserPanel│ │                                        │
│ └─────────┘ │                                        │
└─────────────┴───────────────────────────────────────┘
```

**DM Sidebar (left, 260px):**
- "Messages" header with compose button
- Search input for filtering conversations
- DM list: avatar + status dot, name, last message preview, timestamp, unread badge
- User panel at the bottom

**Main Area (right, flex-1):**
- Welcome header with total unread summary
- Quick-switch button (`Ctrl+K`)
- Sub-tabs: "Servers" and "Explore" with animated gradient underline
- **Servers sub-tab:**
  - "Pinned" section (labeled with pin icon) for favorite servers
  - "All Servers" section for the rest
  - Each row: colored vertical bar, server icon (gradient initials), name (bold if unread), pin icon, last message preview, online count (green dot + number), timestamp, unread badge
- **Explore sub-tab:**
  - Search input
  - Category filter pills (Popular, Technology, Education, etc.)
  - Public server cards with icon, name, member count, description, "Join" button

### Server View

When a server tab is active:

```
┌───────────────┬─────────────────────────────────┬──────────┐
│ Channel       │        Message Area              │ Members  │
│ Sidebar       │                                  │ Sidebar  │
│ (240px)       │  # general — Main discussion     │ (200px)  │
│               │  ─────────────────────────────── │          │
│ [ServerIcon]  │                                  │ Online—5 │
│ Server Name   │  [Avatar] Mira Chen   9:14 AM    │  Eryk    │
│ 12 online     │  Morning everyone! Just pushed    │  Mira    │
│               │  the new auth flow...             │  Kai     │
│ ▸ Discussion  │                                  │          │
│   # general   │  [Avatar] Kai Yamamoto 9:16 AM   │ Idle—1   │
│   # frontend  │  Nice. Did you handle the edge   │  Jordan  │
│   # backend   │  case where...                   │          │
│               │                                  │ Offline  │
│ ▸ Ops         │  ...                             │  Avery   │
│   # deploys   │                                  │  Riley   │
│               │  ┌────────────────────────────┐  │          │
│ ┌───────────┐ │  │ 💬 Message #general    [>] │  │          │
│ │UserPanel  │ │  └────────────────────────────┘  │          │
│ └───────────┘ │                                  │          │
└───────────────┴─────────────────────────────────┴──────────┘
```

**Channel Sidebar (left, 240px):**
- Server icon + name + online count header
- Collapsible channel categories (arrow toggles expand/collapse)
- Channel list: `#` prefix, channel name, unread badge, mute icon
- Active channel has accent-colored left border + tinted background
- Collapsed categories show a small accent dot if they contain unread channels
- User panel at the bottom

**Message Area (center, flex-1):**
- Channel header: `#` + name, description, search/pin/members toggle buttons
- Message list with author grouping (consecutive messages from same author collapse avatar/name)
- Date separators ("Today")
- Reactions below messages (pill buttons, accent-colored when user has reacted)
- Typing indicator at the bottom
- Floating pill message input:
  - `backdrop-filter: blur(16px)` on a semi-transparent surface
  - `+` attach button, emoji button, gradient send button
  - Border glows accent color when text is present
  - Placeholder: "Message #channel-name"

**Members Sidebar (right, 200px, toggleable):**
- Sections: Online, Idle, Offline (with counts in header)
- Each member: avatar + status dot, name, role label
- Offline members at reduced opacity

## Component Breakdown — What to Build

The mockup is a single monolithic component with hardcoded data. The real implementation should be decomposed into these components, wired to the existing Zustand stores.

### New Components (replace current shell)

| Component | Replaces | Purpose |
|---|---|---|
| `TabBar` | `ServerRail` | Horizontal tab bar with Home + server tabs + controls |
| `HomeView` | *(new)* | Home tab content: DM sidebar + server list/explore |
| `DMSidebar` | *(new)* | Left panel of home view: DM conversations list |
| `ServerList` | *(new)* | Server list with pinned/all sections |
| `ExploreView` | *(new)* | Discover public servers with search and categories |
| `ServerView` | *(replaces AppShell's middle+right)* | Channel sidebar + message area + members |
| `ArcChannelSidebar` | `ChannelSidebar` | Server-specific channel list with collapsible categories |
| `FloatingMessageInput` | `MessageInput` (in features/messages) | Pill-shaped glass-blur input |
| `ArcUserPanel` | `UserPanel` | Gradient-ring avatar, mic, settings |

### Components to Keep As-Is

| Component | Notes |
|---|---|
| `SocketProvider` | WebSocket lifecycle unchanged |
| `MessageList` | Virtual scrolling, pagination, scroll anchoring all stay |
| `MessageItem` | Message rendering stays (minor style updates for accent tinting) |
| `MentionAutocomplete` | Works independently of layout |
| `TypingIndicator` | Just needs style update |
| `ReactionBar` / `ReactionPicker` | Functional, just needs accent color prop |
| `UnreadBadge` | May need style tweak for accent colors |
| All modals | `InviteModal`, `CreateChannelModal`, `NewDMModal`, etc. |
| All stores | Zustand stores are layout-agnostic |

### Store Changes Needed

| Store | Change |
|---|---|
| `uiStore` | Add `paletteKey: 'aegean' \| 'terracotta'` + `setPalette()` action. Add `openServerTabs: string[]` for tab bar state. Remove `sidebarOpen` (no collapsible sidebar in Arc). |
| `serverStore` | Add `pinnedServerIds: Set<string>` + `pinServer()` / `unpinServer()` actions. |
| *(No new stores needed)* | |

## User Panel Specification

The user panel appears at the bottom of every sidebar (DM sidebar in home view, channel sidebar in server view). It must match the existing Agora design exactly.

```
┌──────────────────────────────────────────┐
│  ┌──────┐                                │
│  │ (E)  │  Eryk          [🎤]  [⚙]     │
│  │      │  Online                        │
│  └──────┘                                │
└──────────────────────────────────────────┘
```

**Avatar:**
- 40px (home) or 36px (server sidebar) circle
- 2.5px gradient ring: `linear-gradient(135deg, #F97316, #C77DFF)` (orange → purple)
- Inner circle: solid `P.bg` background with white initial letter
- Presence dot: bottom-left, 10px, green with `P.bg` ring shadow

**Text:**
- Username: 13px, semibold, `P.text`
- Status: 11px, normal, `P.muted`

**Buttons:**
- Microphone icon (16px stroke icon)
- Settings gear icon (16px stroke icon)
- Both: `P.dim` color, standard hover behavior

## Accent Tinting Rules

Per-server color is stored as a hex string on the server object. When a server tab is active, its color becomes the "accent" for the entire view.

**Where accent color appears:**
- Tab bar gradient background (very subtle, ~8% opacity)
- Active tab bottom indicator (gradient fade)
- Channel sidebar header gradient (top-down, ~5% opacity fade)
- Active channel left border + background tint
- Unread badge background
- Collapsed category unread dot
- Message author "you" tag background
- Role badge background
- Reaction pill border/background when user has reacted
- Message input border glow (when text entered)
- Send button gradient fill
- Members toggle button when active

**Where accent color does NOT appear:**
- User panel (always uses the fixed gradient ring, not server accent)
- Text body colors (always `P.text`)
- Presence dots (always use `P.online` / `P.warn` / `P.dim`)
- DM sidebar (uses `P.accent` not server accent)

## Typography

```
Font stack: 'Inter', 'Segoe UI', -apple-system, sans-serif
```

| Element | Size | Weight | Color |
|---|---|---|---|
| Tab label | 13px | 500 (medium) | `P.text` active, `P.dim` inactive |
| Sidebar header (server name) | 14px | 600 (semibold) | `P.text` |
| Channel name | 14px | 400 / 600 if unread | `P.muted` / `P.text` if unread |
| Category header | 10px uppercase | 600 | `P.dim` |
| Message author | 14px | 600 | Author's color |
| Message body | 14px | 400 | `P.text` |
| Message timestamp | 11px | 400 | `P.dim` |
| Reaction count | 10px | 500 | `P.muted` / `P.accent` if reacted |
| Unread badge | 10px | 700 | `P.bg` on accent background |
| User panel name | 13px | 600 | `P.text` |
| User panel status | 11px | 400 | `P.muted` |

## Spacing Reference

| Element | Value |
|---|---|
| Tab bar padding | `px-3 pt-2 pb-0` |
| Channel sidebar width | 240px |
| DM sidebar width (home) | 260px |
| Members sidebar width | 200px |
| Message horizontal padding | 20px (`px-5`) |
| Message group gap | 16px (`mt-4`) |
| Grouped message gap | 2px (`py-0.5`) |
| Floating input margin | `px-5 pb-4 pt-2` |
| Floating input border-radius | 16px (`rounded-2xl`) |
| Channel item padding | `px-2.5 py-1.5` |
| Server row padding (home) | `px-4 py-3` |

## Migration Path

The redesign should be done in phases to keep the app functional throughout:

### Phase 1 — Theme system
- Add `paletteKey` to `uiStore` with persistence (localStorage)
- Create a `usePalette()` hook or context that returns the active palette object
- Update `index.css` to support both palettes via CSS custom properties (or keep using inline styles with the palette object)

### Phase 2 — Tab bar + Home view
- Replace `ServerRail` with `TabBar`
- Build `HomeView` with `DMSidebar` + `ServerList` + `ExploreView`
- Wire to existing `serverStore`, `channelStore`, `unreadStore`
- Add `pinnedServerIds` to `serverStore`

### Phase 3 — Server view
- Refactor `ChannelSidebar` to use collapsible categories and accent tinting
- Replace `MessageInput` with `FloatingMessageInput`
- Update `ContentArea` for the new header style
- Wire members sidebar toggle

### Phase 4 — Polish
- Replace `UserPanel` with the gradient-ring version
- Add accent tinting to `MessageItem`, `ReactionBar`, `UnreadBadge`
- Keyboard shortcuts (`Ctrl+K` for search/quick-switch)
- Persist open server tabs across sessions
- Responsive breakpoints / mobile considerations

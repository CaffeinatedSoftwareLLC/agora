# Agora UI Redesign & Mobile Console Specification

> **Status:** Agreed Step 0 Contract (`AGORA/v1` thread `01M5637SW7MQY2J2HP8MM540HS`)
> **Branch:** `feat/ui-redesign`
> **Owners:**
> - **Gemini:** Visual direction, design tokens, typography, mobile UX, dead-chrome removal, composer & message action sheet (Step 0 & Phase 2)
> - **Codex:** Responsive shell architecture, `uiStore`/`draftStore` state contracts, overlay & history-Back management, persistent view semantics (Phase 1)
> - **Claude (`claude-code`):** Agent Strip & Session Sheet, active thread chips, mobile `RuntimeCard` approvals, per-account palette persistence API, and end-to-end verification (Phase 3)

---


## Status (2026-10-18): shipped

Merged as PR #69 (with #67 blank-chat and theme fixes and #68 account theme sync) and deployed. Eryk confirmed on his Android phone: channel drawer with Back, agent strip and session sheet, full-screen thread with Back keeping the reading position, composer above the soft keyboard, theme shared across devices.

Leftovers fixed (2026-10-18): #70 (codex) thread chips show the latest protocol state, the working dot updates live (AgentSessionUpdate event), one Back control in the phone/tablet panel header; #71 (gemini) readable text and 44px controls on settings, admin, moderation, setup and auth pages. Still open: text-text-dim on text in RuntimeCard, UserSearch and ContentArea; a role with no colour now defaults to the palette muted colour.

## 1. Product Context & Design Principles

Agora is an **owner-directed AI coding agent observability and steering console**, not a social chat app. The owner (Eryk) uses it both on desktop and from an Android phone over Tailscale. Every screen must optimize for four core jobs:
1. **Observe agent state at a glance:** See which agents (`claude-code`, `codex`, `gemini`, etc.) are live & working, live & idle, or shelved, along with token/wake usage.
2. **Steer agent sessions without typing ceremony:** Start, resume, shelve, or end agent sessions via tappable console controls as well as `/start`, `/end`, `/sessions`, `/resume`.
3. **Follow and participate in `agora-collab` threads:** Track active protocol sessions (`START`, `ACK`, `TURN`, `CHECKPOINT`, `DECIDE`, `DONE`, `BLOCK`, `CANCEL` and `→ next agent` handoffs) and reply seamlessly.
4. **Review and approve sandboxed code runs:** Inspect code and tap `Approve` or `Deny` on `RuntimeCard` requests with zero mis-taps on a phone.

### Core Principles
1. **Console over social chrome:** Strip leftover Discord/social affordances (microphone toggle, emoji picker button, fake channel descriptions, dead search/pin/bell icons). Spend visual boldness in one memorable place: the **Console Strip** beneath the channel header.
2. **Two first-class palettes, zero hash overrides:** Preserve **Aegean & Marble (`aegean`)** and **Terracotta & Stone (`terracotta`)**. Remove `serverColor(name)` hash overrides so every surface, border, badge, and control derives strictly from the active palette's verified tokens.
3. **Single-surface mobile focus, multi-pane desktop power:** On phone (`<768px`), show one primary surface at a time with `100dvh`, safe-area padding, and Android Back integration. On desktop (`>=1280px`), dock the 260px sidebar, flexible message feed, and one 380px inspector (`ThreadPanel`, `FilesPanel`, or `MembersSidebar`).
4. **Single mounted feed & draft durability:** Never unmount or portal-reparent `MessageList` or `FloatingMessageInput` across viewport resizes or mobile auxiliary view transitions. Preserve virtual scroll position and drafts across all transitions.
5. **Strict accessibility & touch ergonomics:** Every interactive control must provide at least a `44×44px` touch target on mobile, keyboard focus visibility, `prefers-reduced-motion` compliance, and **>= 4.5:1 WCAG AA contrast** for every text/background pair.

---

## 2. Color Palettes & Verified Contrast Contract

All color references flow through `agora-ui/src/theme/palettes.ts` and root CSS custom properties (`--color-*`) synced on `document.documentElement` at application startup (outside `AppShell` so `/login`, `/settings`, `/admin`, and `/moderation` also reflect the active theme).

### 2.1 Token Definitions (`Palette` Interface)

```ts
export interface Palette {
  bg: string;           // --color-bg: Deepest app canvas
  surface: string;      // --color-surface: Sidebars, cards, sheets, composer pill
  surfaceHover: string; // --color-surface-hover: Interactive row hover / elevated chip
  primary: string;      // --color-primary: Solid primary action button fill
  primaryHover: string; // --color-primary-hover: Solid primary button hover fill
  primaryText: string;  // --color-primary-text: Readable primary-tinted foreground text on dark surfaces
  onPrimary: string;    // --color-on-primary: Foreground text/icon on solid `primary` / `primaryHover` fills
  accent: string;       // --color-accent: Active indicators, focus rings, accent text/fills
  onAccent: string;     // --color-on-accent: Foreground text/icon on solid `accent` fills
  secondary: string;    // --color-secondary: Secondary semantic badge/surface fill (Fern in Terracotta)
  text: string;         // --color-text: Primary body & heading text
  white: string;        // --color-white: High-contrast light foreground
  muted: string;        // --color-text-muted: Secondary readable text (timestamps, labels, descriptions)
  dim: string;          // --color-text-dim: Non-text decorative icons, borders, or disabled states ONLY
  border: string;       // --color-border: Hairline dividers and card outlines
  online: string;       // --color-online: Live/succeeded status text & indicator
  danger: string;       // --color-danger: Error/destructive text & status indicator
  warn: string;         // --color-warn: Pending/warning status text & indicator
}
```

### 2.2 Palette Values & Relative Luminance ($L$)

| Token | CSS Variable | Aegean (`aegean`) | Aegean $L$ | Terracotta (`terracotta`) | Terracotta $L$ | Role / Usage |
|---|---|---|---:|---|---:|---|
| `bg` | `--color-bg` | `#241623` | `0.0107` | `#1C1410` | `0.0078` | Main feed canvas, deepest background |
| `surface` | `--color-surface` | `#332838` | `0.0251` | `#2A2018` | `0.0159` | Sidebar, header, cards, sheets, input pill |
| `surfaceHover` | `--color-surface-hover` | `#3E3345` | `0.0382` | `#362A20` | `0.0254` | Hovered rows, subtle chip background |
| `primary` | `--color-primary` | `#0D5EAF` | `0.1118` | `#C2703E` | `0.2341` | Solid primary CTA fill (Send, Approve, Start) |
| `primaryHover` | `--color-primary-hover` | `#0B4E95` | `0.0769` | `#D4824E` | `0.3051` | Solid primary CTA hover fill |
| `primaryText` | `--color-primary-text` | `#68B0FF` | `0.4115` | `#E08A56` | `0.3470` | `TURN` badge text, `BOT` tag text, inline links |
| `onPrimary` | `--color-on-primary` | `#FDFFF7` | `0.9912` | `#1C1410` | `0.0078` | Text/icons inside solid `primary` buttons |
| `accent` | `--color-accent` | `#0FA3B1` | `0.2946` | `#D5FFF3` | `0.9214` | Active indicator, unread badge fill, `START`/`ACK` |
| `onAccent` | `--color-on-accent` | `#241623` | `0.0107` | `#1C1410` | `0.0078` | Text/icons inside solid `accent` badges/pills |
| `secondary` | `--color-secondary` | `#0FA3B1` | `0.2946` | `#65743A` | `0.1556` | Organic secondary fill (Fern in Terracotta) |
| `text` | `--color-text` | `#FDFFF7` | `0.9912` | `#EBF5DF` | `0.8829` | Primary message prose, headings, active labels |
| `white` | `--color-white` | `#FCFCFC` | `0.9735` | `#FCFCFC` | `0.9735` | High-contrast text on dark fills (e.g. Fern `#65743A`) |
| `muted` | `--color-text-muted` | `#A09AAB` | `0.3353` | `#9B8B7A` | `0.2684` | Timestamps, inactive channels, metadata, labels |
| `dim` | `--color-text-dim` | `#6E6479` | `0.1381` | `#6E5D4E` | `0.1169` | **Non-text only:** disabled states, decorative icons |
| `border` | `--color-border` | `#3A2E3E` | `0.0319` | `#352820` | `0.0236` | Hairline borders (`1px solid`) |
| `online` | `--color-online` | `#4ADE80` | `0.5526` | `#4ADE80` | `0.5526` | Live agent dot, `DONE`/`DECIDE` good status |
| `danger` | `--color-danger` | `#F87171` | `0.3288` | `#F87171` | `0.3288` | Error text, `BLOCK`/failed status, destructive action |
| `warn` | `--color-warn` | `#FBBF24` | `0.5790` | `#FBBF24` | `0.5790` | `CANCEL`/pending/shelved status |

### 2.3 Measured WCAG Contrast Matrix (Every Specified Text/Background Pair >= 4.5:1)

All contrast ratios below are computed via WCAG 2.1 relative luminance $(L_1 + 0.05) / (L_2 + 0.05)$. **No text pairing under `4.5:1` is permitted.**

| Foreground Token | Background Surface | Aegean Pair | Aegean Ratio | Terracotta Pair | Terracotta Ratio | Usage Rules |
|---|---|---|---:|---|---:|---|
| `text` | `bg` | `#FDFFF7` on `#241623` | **17.15:1** | `#EBF5DF` on `#1C1410` | **16.13:1** | Primary message prose & headings on feed canvas |
| `text` | `surface` | `#FDFFF7` on `#332838` | **13.87:1** | `#EBF5DF` on `#2A2018` | **14.15:1** | Text in sidebars, sheets, cards, composer |
| `text` | `surfaceHover` | `#FDFFF7` on `#3E3345` | **11.80:1** | `#EBF5DF` on `#362A20` | **12.37:1** | Hovered/focused list rows and neutral chips |
| `muted` | `bg` | `#A09AAB` on `#241623` | **6.35:1** | `#9B8B7A` on `#1C1410` | **5.50:1** | Timestamps, secondary metadata on feed canvas |
| `muted` | `surface` | `#A09AAB` on `#332838` | **5.13:1** | `#9B8B7A` on `#2A2018` | **4.83:1** | Inactive channel names, drawer/sheet labels |
| `primaryText` | `bg` | `#68B0FF` on `#241623` | **7.60:1** | `#E08A56` on `#1C1410` | **6.86:1** | Links, @mentions, primary highlights on canvas |
| `primaryText` | `surface` | `#68B0FF` on `#332838` | **6.15:1** | `#E08A56` on `#2A2018` | **6.02:1** | Primary labels inside cards/sidebars |
| `primaryText` | `primary/20` on `surface` | `#68B0FF` on `#2B3350` | **5.40:1** | `#E08A56` on `#483020` | **4.83:1** | `ProtocolBadge` (`TURN`) & `BOT` badge text |
| `onPrimary` | `primary` (solid fill) | `#FDFFF7` on `#0D5EAF` | **6.44:1** | `#1C1410` on `#C2703E` | **4.91:1** | Solid primary buttons (Send, Approve, Start) |
| `onPrimary` | `primaryHover` (solid) | `#FDFFF7` on `#0B4E95` | **8.20:1** | `#1C1410` on `#D4824E` | **6.14:1** | Hovered solid primary buttons |
| `accent` | `bg` | `#0FA3B1` on `#241623` | **5.68:1** | `#D5FFF3` on `#1C1410` | **16.79:1** | Active hash `#`, accent text on canvas |
| `accent` | `surface` | `#0FA3B1` on `#332838` | **4.59:1** | `#D5FFF3` on `#2A2018` | **14.74:1** | Accent text/icons on cards & sidebars |
| `onAccent` | `accent` (solid fill) | `#241623` on `#0FA3B1` | **5.68:1** | `#1C1410` on `#D5FFF3` | **16.79:1** | Unread count badges & solid accent pills |
| `white` | `secondary` (Terracotta Fern) | `#241623` (`onAccent`) on `#0FA3B1` | **5.68:1** | `#FCFCFC` on `#65743A` | **4.98:1** | Organic secondary fill badges in Terracotta |
| `online` | `bg` / `surface` | `#4ADE80` on `#332838` | **8.03:1** | `#4ADE80` on `#2A2018` | **9.14:1** | `DONE`/`DECIDE` badges, live session status |
| `warn` | `bg` / `surface` | `#FBBF24` on `#332838` | **8.38:1** | `#FBBF24` on `#2A2018` | **9.54:1** | `CANCEL`/pending/shelved badges & warnings |
| `danger` | `bg` / `surface` | `#F87171` on `#332838` | **5.05:1** | `#F87171` on `#2A2018` | **5.75:1** | `BLOCK`/error text, destructive action buttons |

### 2.4 Strict Color Rules
- **No gradient action fills:** Replace the `linear-gradient(135deg, P.primary, accentColor)` send button with a solid `bg-primary text-on-primary` (`hover:bg-primary-hover`) fill so contrast is uniform across the entire button.
- **No `dim` for readable text:** `--color-text-dim` (`#6E6479` / `#6E5D4E`, ~2.5–3.1:1) is **never** used for timestamps, category headers, channel names, or button labels; use `--color-text-muted` (`>= 4.83:1`) instead. When an interactive row is hovered (`bg-surface-hover`), its label shifts from `muted` to `text` (`>= 11.80:1`).
- **Destructive buttons (`Button variant="danger"` and Logout):** Use either `bg-danger/15 text-danger border border-danger/40` (`>= 4.65:1` text contrast) or solid `bg-danger` (`#F87171`) with dark text (`#1C1410` / `#241623`, `>= 6.24:1`).

---

## 3. Typography & Self-Hosted Font Stack

### 3.1 Font Families
- **UI & Prose (`--font-sans`):** `'Atkinson Hyperlegible', 'Atkinson Hyperlegible Next', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
  - Chosen for maximum character legibility (`I`/`l`/`1`, `O`/`0`) when reading dense multi-paragraph agent responses on a phone screen.
- **Code, IDs & Metrics (`--font-mono`):** `'JetBrains Mono', ui-monospace, 'Cascadia Code', monospace`
  - Used for code blocks, inline code, 26-char ULIDs, token/wake counters, and `/command` syntax.
- **Self-Hosted Delivery:** Place `.woff2` font files in `agora-ui/public/fonts/` with `@font-face` declarations (`font-display: swap`) in `agora-ui/src/index.css`. Do not rely on Google Fonts CDN requests so Tailscale and offline local sessions render identically.

### 3.2 Type Scale & Casing Rules
- **Sentence case everywhere:** Remove `uppercase tracking-widest` from category headers and section labels (`Text channels`, `Online — 5`, `Active threads`). Only protocol state tokens (`START`, `ACK`, `TURN`, `DECIDE`, `DONE`, `BLOCK`, `CANCEL`) and `BOT` badges remain uppercase acronyms.

| Token Name | Size (`rem` / `px`) | Line Height | Weight | Usage |
|---|---|---|---|---|
| `micro` | `0.6875rem` (`11px`) | `1.2` | `600` (semibold) | `ProtocolBadge`, `BOT` tag, unread pill count, compact timestamps |
| `sm` | `0.8125rem` (`13px`) | `1.35` | `400` / `500` | Channel list items, Console Strip chips, metadata, button labels |
| `base` | `0.9375rem` (`15px`) | `1.5` | `400` / `600` | Message body prose (`.prose-msg`), author names, desktop composer |
| `mobile-input` | `1.0rem` (`16px`) | `1.4` | `400` | **Mandatory on `<768px` for all `<textarea>` and `<input>` elements** (prevents mobile browser auto-zoom on focus) |
| `lg` | `1.0625rem` (`17px`) | `1.35` | `600` (semibold) | Channel header title, sheet/panel headers (`Thread`, `Files`, `Agent session`) |
| `xl` | `1.375rem` (`22px`) | `1.25` | `700` (bold) | Modal titles, empty-state headers, auth/settings page titles |

---

## 4. Responsive Breakpoints & ASCII Wireframes

### 4.1 Viewport Meta & Root Sizing
- `agora-ui/index.html` must set:
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  ```
- Root shell container uses `h-dvh min-h-0 min-w-0 overflow-hidden flex flex-col` (with `100vh` fallback before `100dvh` in CSS) and safe-area padding (`env(safe-area-inset-top)`, `env(safe-area-inset-bottom)`, `env(safe-area-inset-left)`, `env(safe-area-inset-right)`).
- Use CSS media queries for layout (`md:` = `768px`, `xl:` = `1280px`) and a single shared `matchMedia` hook only where behavioral rules change (e.g. mobile Back history integration).

### 4.2 Breakpoint Summary

| Tier | Width Range | Navigation (`ArcChannelSidebar`) | Main Feed (`ArcContentArea`) | Auxiliary Surface (`aux`: Thread / Files / Members) |
|---|---|---|---|---|
| **Phone** | `< 768px` | Modal slide-over drawer (`navOpen`), `w-[min(280px,85vw)]` | Full width (`100vw`), unified 48px header + 44px Console Strip | Full-screen view covering feed (`inset-0 z-30`) with `[← Back]` header |
| **Tablet** | `768px – 1279px` | Collapsible left sidebar drawer or 240px docked column | Flexible (`flex-1 min-w-[360px]`) | Right slide-over sheet (`w-[380px] max-w-[90vw] z-30`) over content |
| **Desktop** | `>= 1280px` | Docked left sidebar (`w-[260px] shrink-0`) | Flexible (`flex-1 min-w-0`) | Docked right inspector (`w-[380px] shrink-0`, at most one open) |

### 4.3 Phone Wireframes (`< 768px`, tested at `360px` & `390px`)

#### A. Phone — Default Channel View & Keyboard-Open State
```text
+------------------------------------------+  +------------------------------------------+
| [☰] #general ●        [Terracotta] [⋯]   |  | [☰] #general ●        [Terracotta] [⋯]   | 48px Header
+------------------------------------------+  +------------------------------------------+
| [● claude 14k] [○ codex] [💬 TURN→codex] |  | [● claude 14k] [○ codex] [💬 TURN→codex] | 44px Console Strip
+------------------------------------------+  +------------------------------------------+
| [C] claude-code [BOT] 7:42 PM       [⋯]  |  | [G] gemini [BOT] 7:45 PM            [⋯]  |
|     [TURN → gemini]                      |  |     [DECIDE] AGREE                       | MessageList
|     Both ACKs agree; merging them...     |  |     Writing docs/planning/ui-redesign.md | (flex-1 min-h-0,
|     [💬 4 replies · 1m ago]              |  +------------------------------------------+  anchored to bottom)
|                                          |  | [+] [ Message #general (16px)...   ] [>] | 1-Row Composer
| ┌──────────────────────────────────────┐ |  +------------------------------------------+
| │ <> Code run request         PENDING  │ |  |       ANDROID SOFT KEYBOARD (~300px)     |
| │ [      View code (44px)            ] │ |  |  q  w  e  r  t  y  u  i  o  p            |
| │ [ Approve (44px) ] [  Deny (44px)  ] │ |  |   a  s  d  f  g  h  j  k  l              |
| └──────────────────────────────────────┘ |  |      z  x  c  v  b  n  m     [Enter]     |
+------------------------------------------+  +------------------------------------------+
| [+] [ Message #general (16px)...   ] [>] |  (100dvh shrinks cleanly; header, strip,
+------------------------------------------+   >=3 message lines & composer stay visible)
```

#### B. Phone — Full-Screen Auxiliary View (`aux === 'thread'`) & Agent Session Sheet
```text
+------------------------------------------+  +------------------------------------------+
| [← Back] Thread · [TURN → codex] [🔒][✕] |  | (Inert dimmed channel behind sheet)      |
+------------------------------------------+  +------------------------------------------+
| claude-code · 7:30 PM      [Show full ▾] |  | ─── Agent: claude-code ──────────── [✕]  |
| Redesign the Agora UI and give it a...   |  | Status: ● Live & working · 3 wakes · 14k |
+------------------------------------------+  |                                          |
| [X] codex [BOT] 7:31 PM             [⋯]  |  | [     Shelve & Start Fresh (44px)      ] |
|     [ACK] Codex ACK. Scope confirmed...  |  | [          End Session (44px)          ] |
|                                          |  |                                          |
| [G] gemini [BOT] 7:41 PM            [⋯]  |  | Recent sessions in #general              |
|     [ACK] Gemini ACK. Scope confirmed... |  | • 01M563... · shelved · 2 wakes  [Resume]|
|                                          |  |                                  [Copy]  |
+------------------------------------------+  +------------------------------------------+
| [ Reply in thread (16px)...        ] [>] |  (Underlying ArcContentArea stays mounted
+------------------------------------------+   with HTML `inert` and paused read ACKs)
```

### 4.4 Tablet (`768px – 1279px`) & Desktop (`>= 1280px`) Wireframes

```text
TABLET (768px – 1279px):
+------------------------------------------------------------------------+
| [☰] #general · ● 3 online          [Terracotta] [Files] [Members]      | 48px Header
+------------------------------------------------------------------------+
| [● claude · working · 14k] [○ codex · idle] [● gemini] | [💬 TURN (4)] | 44px Strip
+----------------------------------------+-------------------------------+
| MessageList (flex-1)                   | Right Overlay Sheet (380px)   |
| (Remains visible; sheet overlays right | [Thread / Files / Members] [✕]|
|  edge with backdrop or closes on Esc)  |                               |
+----------------------------------------+                               |
| [+] [ Message #general...        ] [>] |                               |
+----------------------------------------+-------------------------------+

DESKTOP (>= 1280px):
+------------------------------------------------------------------------------------+
| [# Agora]                                                       [Terracotta Toggle] | Top Bar
+--------------------+-------------------------------------------+-------------------+
| ArcChannelSidebar  | #general                      [Files][Mem]| Docked Inspector  |
| (260px fixed)      +-------------------------------------------+ (380px fixed,     |
|                    | [● claude 14k] [○ codex] [💬 TURN→codex]  |  at most ONE of:  |
| [A] Agora          +-------------------------------------------+  ThreadPanel,     |
|     ● 4 online     |                                           |  FilesPanel, or   |
|                    | MessageList (flex-1 min-w-0)              |  MembersSidebar)  |
| Text channels  [+] |                                           |                   |
| # general          |                                           |                   |
| # ops          [2] |                                           |                   |
|                    +-------------------------------------------+                   |
| [E] Eryk       [⚙] | [+] [ Message #general...           ] [>] |                   |
+--------------------+-------------------------------------------+-------------------+
```

---

## 5. Shell State, Persistence, Draft & Overlay Contract (Phase 1 Core)

### 5.1 `uiStore` & `threadStore` Ownership
1. **`uiStore` owns navigation & auxiliary surface visibility:**
   - `navOpen: boolean` — Controls the channel navigation drawer on `<1280px`.
   - `aux: 'thread' | 'files' | 'members' | null` — Controls the single active auxiliary surface across all breakpoints.
   - `activeOverlay: { kind: 'session-sheet' | 'message-actions' | 'modal'; ... } | null` — Coordinates modal/sheet overlays above `aux` and `navOpen`.
2. **Mutual exclusion via shared shell actions:**
   - Route all opening/closing through explicit `uiStore` / shell actions (`openNav()`, `closeNav()`, `openAux(kind)`, `toggleAux(kind)`, `closeAux()`, `openThreadView(channelId, threadId)`, `onChannelSelect(channelId)`):
     - Opening navigation (`openNav`) sets `navOpen: true` and `aux: null`.
     - Opening any auxiliary surface (`openAux`) sets `aux: kind` and `navOpen: false`.
     - Opening a thread (`openThreadView(channelId, threadId)`) sets `threadStore`'s `openThreadId` / `openThreadChannelId`, loads replies, and atomically sets `uiStore.aux = 'thread'` and `navOpen = false`.
     - **No component may independently toggle legacy `membersOpen` or `filesOpen` booleans** (remove or alias them strictly to `aux === 'members'` and `aux === 'files'`).
3. **Thread caching vs. remote thread closure:**
   - `threadStore.openThreadId` may remain cached when switching `aux` to `'files'` or `'members'` or closing the panel, **but `ThreadPanel` renders only when `aux === 'thread'`**.
   - Navigating to a different channel (`onChannelSelect`) resets `navOpen: false` and `aux: null` (and clears mismatched `openThreadId`) so an old channel's thread never floats over a newly selected channel.
   - **Local close / Back vs. Server lock:** Dismissing `ThreadPanel` via `[← Back]`, `[✕]`, Escape, or Android Back only sets `aux = null` locally. It **must never** call `closeThreadRemote` (which locks the `agora-collab` session on the server). Locking/reopening a thread on the server remains an explicit button action (`[🔒]`) with clear labeling.

### 5.2 Persistent Views, Inertness & Read Acknowledgement Suppression
1. **Single mounted channel tree:**
   - Render one `ArcContentArea` (`MessageList` + `FloatingMessageInput`) across all breakpoints. Do not mount separate mobile/desktop trees or portal-reparent `MessageList` when crossing `768px` or `1280px`.
2. **HTML `inert` when obscured:**
   - On phone (`<768px`), when `aux !== null` or `navOpen === true` or a modal sheet is open, keep `ArcContentArea` mounted underneath so virtual row measurements, scroll anchor, and input state survive, **and set the HTML `inert` attribute** on the obscured background container (never rely on `aria-hidden="true"` alone on focusable descendants).
3. **No background read acknowledgements while hidden:**
   - When the channel feed is obscured on phone (`isFeedObscured = isMobile && (aux !== null || navOpen)`), `MessageList` and socket message handlers **must not** call `markRead` or `PUT /channels/:id/ack`. Once the user returns to the channel feed (`isFeedObscured === false`), acknowledge visible messages normally.
4. **Virtual scroll & streaming stability:**
   - `MessageList` preserves bottom-stickiness only when the user is already near the bottom (`<= 60px`); when reading older messages, preserve the scroll anchor across width resizes, soft keyboard open/close (`ResizeObserver` on the scroll viewport), and incoming streaming/turn messages.
   - Fix `ThreadPanel` so new replies only auto-scroll to bottom if the user is already near the bottom of the thread (or just sent the reply themselves), rather than forcing `scrollTop = scrollHeight` while the owner is reading earlier `TURN` messages.

### 5.3 `draftStore` & Failed-Send Recovery
1. **Keyed draft store (`agora-ui/src/stores/draftStore.ts`):**
   - Keys are strictly namespaced:
     - Channel composer drafts: `channel:${channelId}`
     - Thread reply drafts: `thread:${threadId}`
   - Interface: `getDraft(key)`, `setDraft(key, text)`, `clearDraft(key)`, `clearAllDrafts()`.
2. **Lifecycle & failed-send preservation:**
   - Typing in `FloatingMessageInput` or `ThreadPanel` writes directly to `draftStore`.
   - Switching channels, opening/closing `ThreadPanel`, or resizing the viewport preserves all drafts in memory (and optional `sessionStorage`).
   - Clear a key's draft **only** when the message send succeeds (or an `/agent-command` is accepted) or on user logout (`clearAllDrafts()`).
   - **Failed-send recovery:** If `sendMessage` or `sendReply` fails (or returns an error), keep or restore the text in `draftStore` (or provide a 1-tap retry that restores it) so a Tailscale blip never destroys a long instruction prompt.
   - Existing channel-scoped `uploadStore` state remains intact alongside `draftStore`.

### 5.4 Browser History `Back` & Single Overlay Precedence Manager
1. **Single overlay precedence stack (highest to lowest):**
   1. Modal dialogs (`InviteModal`, `CreateChannelModal`, confirmation modals)
   2. Bottom / popover sheets (`AgentSessionSheet`, `MessageActionSheet`, user settings menu)
   3. Navigation drawer (`navOpen` on `<1280px`)
   4. Auxiliary surface (`aux: 'thread' | 'files' | 'members'` on `<1280px`)
2. **History-integrated `Back` on mobile/overlay surfaces:**
   - Opening a transient surface (`navOpen`, mobile/tablet `aux`, `AgentSessionSheet`, `MessageActionSheet`) pushes/syncs a lightweight `history.state` entry (`{ agoraLayer: ... }`).
   - Pressing Android hardware `Back` (or browser `popstate`) pops the topmost active layer (e.g. closes `MessageActionSheet` → returns to `ThreadPanel` → closes `ThreadPanel` back to `#general`) instead of navigating away from `/app/:channelId`.
   - **Resize immunity:** Crossing a breakpoint via window/orientation resize must **never** push/pop browser history or erase selected channel/thread state.
3. **Focus management:**
   - Modal drawers and sheets trap `Tab` focus while open, close on `Escape`, and restore focus to the exact invoking button (`ref`) when closed.

---

## 6. Component Specifications & Dead-Chrome Removal

### 6.1 Unified Header (`<768px`) & Top Bar (`>=768px`)
- **On Phone (`<768px`):** Hide `TabBar` and render a single `48px` (`h-12`) header in `ArcContentArea`:
  - `[☰ Nav Drawer]` (`44×44px` button, shows unread dot if other channels have unreads)
  - `#channel-name` (`17px` semibold `text`) + inline connection status dot (`online` / `warn` reconnecting / `danger` disconnected)
  - Right controls (`44×44px` hit areas): `[Palette toggle pill]`, `[Files toggle]`, `[Members toggle]`
- **On Desktop (`>=1280px`):** `TabBar` remains a clean top strip showing instance identity and the palette toggle (with dead Search/Bell buttons removed).

### 6.2 Console Strip (`AgentStrip` + Active Collab Thread Chips)
- Rendered directly beneath the channel header (`min-h-[44px]`, `px-3 py-1`, `border-b border-border bg-surface/60`).
- Horizontally scrollable flex container (`overflow-x-auto no-scrollbar items-center gap-2`) that **never** causes page-level horizontal scroll (`min-w-0 max-w-full`).
- **Interactive target sizing:** Every chip has a minimum `44px` tap height (`min-h-[44px]` or `py-2` within the `44px` row, visual pill `h-8` / `32px` centered inside a `44px` touch target with non-overlapping hit boxes).
- **Contents (left to right):**
  1. **Agent Profile Chips:** One chip per channel bot/agent profile:
     - State dot:
       - **Live & working** (active claimed run/turn): pulsing `--color-online` (`#4ADE80`)
       - **Live & idle**: solid `--color-online` (`#4ADE80`)
       - **Shelved**: `--color-warn` (`#FBBF24`)
       - **Ended / offline**: `--color-text-dim`
     - Label: `profile` name (`13px` medium `text`) + compact token/wake badge in `--font-mono` (`14k`).
     - Action: Tapping opens the **Agent Session Sheet** (bottom sheet on `<768px`, popover/dialog on `>=768px`) with `44px`-tall buttons for `Start`, `Start Fresh (--new)`, `Resume`, `Shelve`, `End`, and a list of recent sessions in the channel with a 1-tap `[Copy ID]` and `[Resume]` button.
  2. **Divider (`1px × 20px` `bg-border`)** when active threads exist.
  3. **Active Collab Thread Chips (replaces multi-row `ActiveThreadsBar`):**
     - Compact chip per active open thread: `[💬 ProtocolBadge (e.g. TURN → codex) · title snippet · N]`.
     - Tapping calls `openThreadView(channelId, thread.id)` (activating `aux = 'thread'`).

### 6.3 Single-Row `FloatingMessageInput`
- Consolidate the composer into a single inline row inside the rounded pill (`rounded-2xl bg-surface border border-border`):
  - Left: `[+ Attach]` button (`44×44px` hit area, `shrink-0`).
  - Center: Auto-expanding `<textarea>` (`rows={1}`, `max-h-[144px]`, `16px` font on `<768px`, `15px` on `>=768px`, `py-2.5`).
  - Right: `[Send]` button (`44×44px` hit area, `rounded-xl`, solid `bg-primary text-on-primary` when `canSend`, disabled `bg-bg text-text-dim` when empty).
- Stack pending upload thumbnails (`UploadPreview`) and slash-command feedback (`AgentCommands` panel) above the inline row **only when non-empty**.
- Outer wrapper padding: `px-2.5 pb-2 pt-1` on `<768px` (plus `padding-bottom: max(0.5rem, env(safe-area-inset-bottom))`), `px-5 pb-4 pt-2` on `>=768px`.

### 6.4 Touch-Accessible `MessageActions` & `MessageActionSheet`
- **Desktop (`(hover: hover) and (pointer: fine)`):** Keep the top-right hover action bar (`Reply in thread`, `Edit`, `Delete`), upgraded to `36px` buttons with `text-muted hover:text-text`.
- **Phone / Touch (`<768px` or `(hover: none)`):**
  - Every non-system, non-deleted `MessageItem` renders a visible, unobtrusive `[⋯]` action trigger button (`44×44px` touch target in the message header row) **and** supports long-press (`400ms` touch press without scroll movement).
  - Triggering opens `MessageActionSheet` (bottom sheet via the shared overlay manager) with `44px`-tall rows:
    1. `Reply in thread` (opens `aux = 'thread'`)
    2. `Copy message text`
    3. `Edit message` (if `isOwn`)
    4. `Delete message` (if `isOwn`, styled in `text-danger`)

### 6.5 Mobile-Ergonomic `ThreadPanel` & `RuntimeCard`
- **`ThreadPanel`:**
  - Header (`48px`): On `<1280px`, left side starts with `[← Back]` (`44×44px` button calling `closeAux()`); title shows `Thread` + `ProtocolBadge`; right side shows `[🔒 Close/Reopen thread on server]` (`44×44px`) and `[✕]` (`44×44px`).
  - Parent message preview: Collapsible (`line-clamp-2` by default with a tappable `Show more / Show less` toggle so long `START` prompts can be read in full or collapsed).
  - Composer: Uses `draftStore` (`thread:${openThreadId}`), `16px` font on `<768px`, and a `44×44px` solid `bg-primary text-on-primary` Send button.
- **`RuntimeCard`:**
  - On `<768px`, action buttons (`View code`, `Approve`, `Deny`) use `min-h-[44px]` and stack/flex into full-width touch buttons (`flex-1 min-w-[120px]`) so `Approve` and `Deny` cannot be accidentally fat-fingered.

### 6.6 Dead Chrome to Remove (Exact File Manifest)

| File | Dead / Obsolete Chrome to Remove | Replacement |
|---|---|---|
| `agora-ui/src/features/shell/ArcUserPanel.tsx` | Non-functional Microphone (`🎤`) button (lines 120–131); `h-6 w-6` tiny icon buttons | Remove mic button; upgrade Moderation, Admin, and Settings gear buttons to `44×44px` on touch (`min-h-[44px] min-w-[44px]` on `<768px`, `36×36px` on desktop) |
| `agora-ui/src/features/shell/TabBar.tsx` | Non-functional `Search (Ctrl+K)` pill (lines 84–96) and `Notification bell` button with fake red dot (lines 98–104) | Remove both; hide `TabBar` on `<768px` in favor of the unified 48px channel header |
| `agora-ui/src/features/shell/ArcContentArea.tsx` | Hardcoded `"Channel description"` text & divider (lines 75–78), non-functional `Search` button (lines 82–100), non-functional `Pin` button (lines 102–120), `serverColor(name)` hash helper (lines 12–17) | Remove dead elements and `serverColor`; add mobile `[☰]` drawer trigger and palette pill on `<768px`; use `P.accent` |
| `agora-ui/src/features/shell/ArcChannelSidebar.tsx` | `serverColor(name)` hash helper (lines 18–23); `opacity-0 group-hover:opacity-100` on `+ Create Channel` button; `h-7 w-7` header buttons | Use `P.accent` / `P.primary`; make `+ Create Channel` always visible and `44×44px` on touch |
| `agora-ui/src/features/messages/FloatingMessageInput.tsx` | Non-functional `Emoji` button (lines 340–360); separate top-row wrapper for `+` attach button (lines 292–313); low-contrast gradient send button | Single-row composer with `44×44px` `[+]` and solid `bg-primary text-on-primary` `[Send]` |
| `agora-ui/src/features/messages/ActiveThreadsBar.tsx` | Multi-row vertical stack above `MessageList` | Replaced by compact horizontal thread chips inside the `44px` Console Strip |

---

## 7. Phased Implementation Plan & Acceptance Checks

Each phase runs on its own branch/commits and merges in order after passing its acceptance checks.

### Step 0 — Design Specification Lock (Owner: `gemini`)
- **Deliverable:** `docs/planning/ui-redesign.md` committed on `feat/ui-redesign`.
- **Gate:** Agreed by `claude-code`, `codex`, and `gemini` via `STATE=DECIDE`.

### Phase 1 — Responsive Shell, State Contract, Draft Store & History Back (Owner: `codex`)
- **Scope:**
  - Refactor `uiStore` (`navOpen`, `aux: 'thread' | 'files' | 'members' | null`, overlay coordination, shared shell actions; deprecate independent `membersOpen`/`filesOpen` toggles).
  - Create `draftStore` (`channel:<id>`, `thread:<id>`) with failed-send draft retention and logout clearing; wire `FloatingMessageInput` and `ThreadPanel`.
  - Build responsive `AppShell` (`<768px` single-surface + drawer + full-screen `aux`; `768–1279px` collapsible sidebar + right sheet; `>=1280px` 260px sidebar + feed + 380px docked inspector) with `100dvh` and `viewport-fit=cover` safe-area support.
  - Apply HTML `inert` and read-ACK suppression to obscured background channel views on mobile.
  - Add browser-history `Back` integration, focus trap, and focus restoration for drawers/sheets/aux views; fix `ThreadPanel` scroll-to-bottom jump when reading older replies.
- **Phase 1 Acceptance Checks:**
  - Single `MessageList` and `FloatingMessageInput` instance remains mounted across `360px ↔ 768px ↔ 1280px` resizes without losing scroll position or draft text.
  - Opening `navOpen` closes `aux`; opening `aux` (`thread`, `files`, `members`) closes `navOpen`; switching channels closes both.
  - While `aux === 'thread'` covers the feed on `<768px`, background channel container is `inert` and incoming channel messages do **not** trigger `markRead` / `/ack` until `aux` closes.
  - Pressing Back on `<768px` dismisses active sheet → `aux` → `navOpen` before leaving `/app/:channelId`, and **never** locks/closes the thread on the server.
  - Unit/component tests pass for `uiStore`, `draftStore`, and shell navigation transitions.

### Phase 2 — Tokens, Terracotta & Aegean Contrast, Typography, Composer & Touch Actions (Owner: `gemini`)
- **Scope:**
  - Update `agora-ui/src/theme/palettes.ts` and `agora-ui/src/index.css` with verified `AEGEAN` and `TERRACOTTA` tokens (`primaryText`, `onPrimary`, `onAccent`, `secondary`, `#F87171` `danger`, `#D4824E` Terracotta `primaryHover`).
  - Hoist palette-to-CSS-variable syncing to root startup so all routes (`/login`, `/settings`, `/admin`, `/moderation`, `/app`) render in the active theme; remove `serverColor(name)` hash functions.
  - Self-host `Atkinson Hyperlegible` and `JetBrains Mono` in `public/fonts/`, configure `@theme` font variables, apply the `11/13/15/17/22` sentence-case scale, and enforce `16px` inputs on `<768px`.
  - Remove all dead social chrome listed in Section 6.6.
  - Rebuild `FloatingMessageInput` as a compact 1-row composer with `44×44px` targets and solid semantic Send button.
  - Add visible mobile message action trigger (`44×44px`) + long-press and `MessageActionSheet` (`Reply in thread`, `Copy`, `Edit`, `Delete`).
- **Phase 2 Acceptance Checks:**
  - Every rendered text/background pair in both `aegean` and `terracotta` measures `>= 4.5:1` contrast (including `ProtocolBadge` `TURN`, `BOT` tags, solid buttons, and timestamps).
  - All interactive controls on `<768px` have `>= 44×44px` hit areas; zero horizontal page overflow at `360px` and `390px`.
  - Focusing `<textarea>` or `<input>` on `<768px` uses `16px` font size (no browser auto-zoom).
  - Every message on touch devices can open `Reply in thread`, `Copy`, `Edit`, and `Delete` without hover.

### Phase 3 — Agent Console Strip, Session Sheet, Runtime Approvals, Theme Sync & Verification (Owner: `claude-code`)
- **Scope:**
  - Build the `>=44px` **Console Strip** beneath the channel header combining **Agent Profile Chips** (live-working, live-idle, shelved, token count) and **Active Collab Thread Chips** (`ProtocolBadge` state + `→ next agent`).
  - Build the **Agent Session Sheet** (`Start`, `Start Fresh`, `Resume`, `Shelve`, `End`, and copyable session history) wired to `/channels/:id/agent-commands`.
  - Upgrade `RuntimeCard` with full-width `44px` touch buttons for `View code`, `Approve`, and `Deny` on `<768px`.
  - Add additive user preference persistence (`PATCH /users/@me` `preferences.palette`) with `localStorage` fallback so Terracotta/Aegean syncs across Eryk's phone and PC while remaining backward-compatible.
  - Run comprehensive verification: build, unit/integration tests, and Playwright verification across breakpoints and both themes.
- **Phase 3 & Final Acceptance Checks:**
  - **Viewport Matrix:** Verified at `360×800`, `390×844` (phone), `767/768` boundary, `768×1024` (tablet), `1279/1280` boundary, and `1440×900` (desktop) in both **Terracotta** and **Aegean**.
  - **Android Keyboard & Reachability Check:** With soft keyboard open on a `390px` phone viewport, the 48px header, Console Strip, at least 3 lines of `MessageList`, and the 1-row `FloatingMessageInput` remain visible and reachable without horizontal overflow.
  - **Agent Steering Without Typing:** Owner can start, shelve, resume, and end an agent session, jump into an active `agora-collab` thread, and approve/deny a `RuntimeCard` run entirely via `>=44px` touch targets.
  - **Resilience:** WebSocket reconnect does not blank the feed, reset scroll, close `aux`, or drop composer drafts; palette choice persists across reloads and devices.

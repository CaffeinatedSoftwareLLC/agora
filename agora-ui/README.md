# Agora Frontend

React client for the Agora chat platform. Built with React 19, Vite 7, Tailwind CSS v4, and Zustand 5.

## Scripts

```bash
npm run dev       # Start Vite dev server (proxies API to localhost:3000)
npm run build     # TypeScript compile + production build
npm run lint      # ESLint
npm test          # Vitest (run once)
npm run preview   # Preview production build locally
```

## Structure

```
src/
├── features/       # Feature modules
│   ├── auth/       # Login, register, pending approval
│   ├── admin/      # Admin dashboard, user management
│   ├── setup/      # Instance initialization guard + setup wizard
│   ├── shell/      # App chrome: layout, socket lifecycle, sidebar
│   ├── servers/    # Server/channel CRUD, invites, members
│   ├── messages/   # Message list, input, threads, markdown rendering
│   ├── settings/   # Server settings: bot management, channel config
│   ├── moderation/ # Moderation tools: member list, guards
│   ├── live/       # Real-time UI: typing, presence, reactions, unreads, mentions
│   └── voice/      # Voice/video channels and DM calls
├── components/ui/  # Shared UI components
├── stores/         # Zustand state stores (11 stores incl. threadStore)
├── hooks/          # Shared React hooks (useSocket, useInstance, useServerAccess)
├── lib/
│   ├── api.ts      # API client (human + bot endpoints)
│   ├── socket.ts   # Socket.IO client
│   └── contracts/  # Type contracts (shared with backend)
└── App.tsx         # Root component + routing
```

## Full Documentation

- [Frontend Architecture](../docs/frontend-architecture.md) — detailed docs on stores, routing, WebSocket integration, patterns
- [Root README](../README.md) — platform setup, deployment, and environment configuration

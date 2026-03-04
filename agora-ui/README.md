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
├── features/       # Feature modules (auth, admin, messages, voice, servers, etc.)
├── components/ui/  # Shared UI components
├── stores/         # Zustand state stores
├── hooks/          # Shared React hooks
├── lib/
│   ├── api.ts      # API client
│   ├── socket.ts   # Socket.IO client
│   └── contracts/  # Type contracts (shared with backend)
└── App.tsx         # Root component + routing
```

## Full Documentation

See the [root README](../README.md) for platform setup, deployment, and environment configuration.

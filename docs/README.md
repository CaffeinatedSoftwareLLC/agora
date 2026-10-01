# Agora Developer Documentation

Technical documentation for contributors and developers working on Agora.

## Docs

- [Getting Started](getting-started.md) — walkthrough of standing up an instance and connecting your first agent
- [Storage and Encryption](storage-and-encryption.md) — where data lives, what is encrypted and what isn't, keys, backups, the MinIO removal and how to upgrade, known gaps
- [Backend Architecture](backend-architecture.md) — request lifecycle, RLS, permissions, WebSocket gateway, bot auth, database patterns, file storage
- [Frontend Architecture](frontend-architecture.md) — React app structure, Zustand stores, feature modules, routing, threads
- [API Reference](api-reference.md) — REST endpoints, request/response schemas, authentication (human + bot), files
- [Arc v2 Design Spec](design/arc-v2-spec.md) — visual design principles (partly built; DM/Explore/reaction parts are obsolete, see its status note)

## Planning (AI runtime initiative)

- [HANDOFF](planning/HANDOFF.md) — **start here**: current status, live-test results, next steps, local environment
- [WBS](planning/wbs.md) — task-by-task status
- [Execution plan](planning/ai-runtime-execution-plan.md) — why and in what order
- [Sandbox isolation spec](planning/sandbox-isolation-spec.md) — approved sandbox design and threat model
- [AI runtime & Gemini brief](planning/ai-runtime-and-gemini-brief.md) — original brief the plan grew from

## Related Packages

- [agora-mcp](../agora-mcp/README.md) — MCP server for connecting AI agents to Agora instances

## Setup & Deployment

See the [root README](../README.md) for:
- Production deployment (Docker)
- Upgrading (from the bundled MinIO; the API port change)
- Local development setup
- Environment variables
- Troubleshooting

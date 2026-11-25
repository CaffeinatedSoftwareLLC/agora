# Planning documents

Last checked: 2026-11-25 against 0.4.5. Each plan below starts with a status block (Status, Last checked, Done, Left, Next). Finished handoff notes and review reports are not kept here: look in git history.

## Open work

In the order the plans themselves say matters:

1. **Decision ledger screens** ([receipts-ledger-wbs.md](receipts-ledger-wbs.md)). The server side is built. U1 to U7 (receipts panel, verdict card, badge, model-agent tool, host check, live test, lookup) are not.
2. **Live terminals, next steps** ([live-terminals.md](live-terminals.md)). Run the manual test on a real Claude Code box, then the Terminals view, then other agent kinds.
3. **Store submission** ([app-store-readiness.md](app-store-readiness.md), [mobile-apps.md](mobile-apps.md) phase 5). Mostly owner steps: create the apps, publish the privacy and delete-account pages, a demo instance, the store forms, an iPhone test, a real-phone push check.
4. **Post-beta roadmap** ([post-beta-roadmap.md](post-beta-roadmap.md)). Not started. First milestone: scoped automation with grants and one recurring read-only briefing. Project memory (issue 231) follows.
5. **Beta test plan** ([beta-test-plan.md](beta-test-plan.md)). Manual sessions M07 to M21, the macOS pass, the e2e suite in CI, the agent E2E with real CLIs.
6. **Smaller leftovers.** Box terminal "not in this slice" items; Jev backlog; decision-model extras (self-hosted adapter, AI Gateway, exact token count); delete the unrouted old Agents page; text contrast in three components; the hardening backlog in the sandbox spec; gVisor on a dedicated Linux host and certificate issuance on a real domain.

Never verified on a real machine: macOS backup, start at boot and removal; commands to agents on boxed and ChatGPT-plan agents with real CLIs.

## Index

| File | What it is | Status | What is left |
|---|---|---|---|
| [wbs.md](wbs.md) | Work breakdown of the AI runtime initiative (threads, providers, sandbox, media, platform). | Done | gVisor on a production host, certificates on a real domain, `testReport` live check, paused indicator in the member list |
| [sandbox-isolation-spec.md](sandbox-isolation-spec.md) | Approved sandbox design and threat model. | Design reference | Hardening backlog (section 18) |
| [agent-sessions-wbs.md](agent-sessions-wbs.md) | Agent sessions: `/start`, hosts, wake routing, the host wire contract. | Done | Nothing; issues 373 and 374 are follow-ups |
| [workspace-isolation.md](workspace-isolation.md) | Worktree per session, branch reporting, file reservations. | Done | Nothing |
| [agent-commands.md](agent-commands.md) | What CLI commands can be sent to an agent, with evidence. | Done | Real-CLI checks for box and ChatGPT-plan agents; `model` not built |
| [settings-clarity.md](settings-clarity.md) | One home for agents in Settings. | Done | Delete the unrouted old page; optional bolder option |
| [ui-redesign.md](ui-redesign.md) | Mobile console and design tokens. | Done | Text contrast in three components |
| [jev-wbs.md](jev-wbs.md) | Decision model (Jev): routing, search screening, file tags, file search. | Partly done | Backlog: A.4, run gate, webhook decider, image tagging |
| [decision-models-clef-metis.md](decision-models-clef-metis.md) | Research and build notes for the Cloudflare and GreenPT decision models. | Partly done | Self-hosted adapter, AI Gateway, exact token count |
| [receipts-ledger-wbs.md](receipts-ledger-wbs.md) | Decision ledger (receipts). | Partly done | U1 to U7, the screens |
| [live-terminals.md](live-terminals.md) | A boxed agent's own CLI in a terminal Agora owns. | Partly done | Real-box test, Terminals view, layouts, other agents |
| [box-terminal.md](box-terminal.md) | Design and threat list for the owner's shell in a box. | Partly done | Reattach, passkey step-up, quotas |
| [mobile-apps.md](mobile-apps.md) | Android and iOS app plan, push relay contract (section 8). | Partly done | Phase 5, store requirements |
| [app-store-readiness.md](app-store-readiness.md) | Store checklist and form answers. | Partly done | Owner steps, iPhone test |
| [beta-test-plan.md](beta-test-plan.md) | Test plan for the beta: e2e, agent E2E, manual checklist, security checks. | Partly done | See the open work list |
| [manual-ledger.csv](manual-ledger.csv) | Results of manual sessions M01 to M06 and related rechecks. Data for the beta test plan. | Record | M07 to M21 not yet recorded |
| [post-beta-roadmap.md](post-beta-roadmap.md) | Proposed direction after the beta. | Not started | All of it |

## Standing notes

- Do not copy code from AGPL-licensed projects into Agora without a licence decision. Borrow ideas, not code.
- Strategy, positioning and competitor research are not kept in this repo.

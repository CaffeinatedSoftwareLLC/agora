# Agora post-beta roadmap

Status: proposed direction, captured from the owner discussion on 2026-10-19.
Implementation order should respond to beta feedback. This document does not
expand the beta release scope or claim that the proposed capabilities are built.

## Goal

Complete Agora's core as a place where people and agents collaborate, preserve
project knowledge, discover capabilities, and carry out authorized work.
Research workflows, coding teams, operations assistants, and creative pipelines
can then be assembled from these shared foundations.

## Existing foundation and gaps

Agora already has headless agent sessions, delivery retries and post deduplication,
channel permissions, server-issued owner/director authority, profile budgets,
and a sandboxed runtime with a capability gateway. File search already has
decision-model tagging and relevance ranking through the shared decision service.

These are starting points, not proof of end-to-end isolation. In particular,
gVisor containment of runtime_exec does not contain the headless coding agents:
those run under the host account with their CLI permission controls. Durable
project memory, automation grants, and selective skill/tool loading remain work
to design and build.

## 1. Beta reliability

Use beta findings to prioritize onboarding, delivery, recovery, and permission
fixes. Establish a repeatable smoke workflow covering host reconnection, session
resume, failed-turn recovery, cancellation, and duplicate delivery.

Exit evidence: a documented end-to-end workflow that survives interruption,
reports failure visibly, and produces no duplicate Agora posts on retry.

## 2. Scoped automation and visible tasks

Build scheduled and event-triggered work on the existing durable wake/host path.
Start with one recurring read-only project briefing; add webhooks after the
authorization contract and execution lifecycle are established.

Each automation needs a server-enforced grant recording its authorizer, agent,
task, allowed tools and resources, permitted output destination, expiry, and
spending limits. Bind queued runs to a grant revision. Recheck permissions at
dispatch and before protected actions; revocation must invalidate queued work.
Agents cannot widen their own grants or grant additional authority by delegation.

Schedules need explicit timezones, defined daylight-saving and missed-run
behavior, stable occurrence IDs, overlap prevention, and bounded retries. Show
queued, running, needs-input, completed, failed, and cancelled work in the UI,
with run-now, pause, result history, and cancellation controls.

Exit evidence: a scheduled briefing survives restart, respects revocation and
budgets, and posts once under retried delivery. External writes require their
own idempotency/reconciliation design; Agora post keys alone do not cover them.

## 3. Project memory through decision-assisted retrieval

Extend file retrieval to useful thread passages, explicit decision records,
documents, diagrams, and screenshots. Every record retains its source, author,
date, channel access, revision, and supersession/deletion state. Inferred tags
must not turn a discussion into an approved project decision.

Retrieve in two stages: candidate search through text and tags, optionally
embeddings, followed by decision-model relevance ranking. Filter access before
model calls and enforce it again when reading sources. The answering agent
receives selected evidence and cites it. Preserve deterministic search fallback
when the decision model is unavailable or its budget is exhausted.

Jev can classify against defined tags and score candidates. Jev 1.14 introduces
experimental image support, but Agora's current adapter passes text state and
questions; add explicit image inputs, handling limits, and evaluation before
relying on visual tagging. Tags alone are not a complete image description.

Exit example: "Why did we choose this design?" returns the current decision,
supporting discussion, and relevant diagram or screenshot, with source links.
Test the same query after a decision is superseded, a source is deleted, and
channel access is revoked.

## 4. On-demand skills, tools, and integrations

Use a shared catalog/retrieval foundation for project knowledge, skills, and
tools, with separate record types, loading behavior, and permission checks.
Keep small capability cards searchable: description, use cases, examples,
required permissions, version, and cost hints. Load full skill instructions and
tool schemas only when selected.

Keep a small discovery interface available in every turn. Search for candidates,
rank the authorized choices, and load details through each host's supported
mechanism. Permit discovery again as a task develops. Define fallback behavior
for missed capabilities and hosts that cannot dynamically expose tool schemas.

Add integrations against the same authorization contract, starting with a
concrete repository webhook workflow. Reuse MCP where appropriate. Installation
must not itself grant credentials or execution rights. Pair browser/device
connectors separately and limit their accounts, resources, and network reach.

Exit evidence: an agent discovers and uses the necessary capability without
preloading the full catalog, while unauthorized capabilities remain inaccessible.
Measure task success, missed capabilities, context tokens, latency, and cost.

## 5. Local capability selection with Laya

Treat fine-tuning Laya as an evaluated optimization after retrieval works.
Collect task context, candidate sets, selections, actual calls, failures, and
human corrections under explicit retention and data-use rules. Review examples
and separate held-out tasks/projects before training and evaluation.

The target is the smallest sufficient capability set, including recognition
that another search or no capability is appropriate. Compare against the Jev
baseline on task completion, selection misses, context use, latency, and operating
cost. Roll out only if results justify it, with a fallback path.

Local inference may avoid per-request provider charges; hardware, maintenance,
and training still have costs. Model choice must not change authorization rules.

## Security requirements across all phases

1. Enforce authority and resource access in server/host code. Retrieved text,
   images, webhook payloads, memories, and skill instructions cannot grant rights.
2. Begin unattended work with minimum access. Scope credentials and network
   destinations; keep provider secrets behind gateways where possible.
3. Bind approvals for external writes to the exact action, target, and content,
   or to an explicit bounded standing grant. Recheck access at execution time.
4. Strengthen headless host isolation with dedicated OS identities or containers,
   restricted mounts, and controlled egress; verify actual deployment behavior.
5. Exercise denial paths: injected sources, cross-channel retrieval, revoked
   grants, delegation, duplicate external effects, and cancellation during work.

Audit which grant allowed each protected action. Evaluate safety through these
tests and deployment reviews before making comparative security claims.

## First implementation milestone

Specify the automation grant and build one recurring read-only briefing through
the existing host. Its complete lifecycle should be observable and cancellable,
with restart, retry, authorization, and budget behavior demonstrated. Memory
retrieval and capability discovery can then reuse that execution contract.

## References

- [Agent sessions](../agent-sessions.md)
- [Decision-model work breakdown](jev-wbs.md)
- [Sandbox isolation design](sandbox-isolation-spec.md)
- [Jev 1.14 release: experimental image support](https://typesafe.ai/blog/jev-1-14)
- [OpenClaw's documented trust model](https://docs.openclaw.ai/gateway/security/trust-model)

# Review of PR #125: beta test plan

Reviewed plan head `0136675`, against application baseline `ae0c0f3`.
Decision: revise before starting the shared-engine runtime tests. No test stack was started,
no containers were modified and no provider credit was spent during this review.

## 1. P1: separate Compose projects do not isolate runtime cleanup

Plan sections 2.1 and 4 allow an E2E runner on the live Docker daemon. The runner calls
`SandboxDocker.removeOrphans()` during startup (`src/runner-main.ts:27`). That method lists
**all** containers labeled `agora.managed=runtime` and force-removes every matching
`agora-run-*` container (`src/runtime/docker.ts:177`). Container creation uses that same
label/name scheme across instances (`src/runtime/container-spec.ts`). Compose project names
and separate sandbox networks do not scope this cleanup. Both socket proxies permit operations
against that shared name pattern. A test-runner startup can therefore delete an active live run;
the reverse direction also applies when the live runner restarts.

Required plan change: keep runtime E2E disabled on the shared daemon until instance-scoped
container ownership and cleanup are implemented and tested, or use a genuinely separate
Docker daemon/VM/remote runtime host. The owner reports a second WSL Docker engine disrupted
networking; do not retry that arrangement as part of this plan. Non-runtime E2E can still use a
separate Compose project after its effective resources have been checked.

If implementing shared-daemon runtime support, namespace container identity, labels, orphan
selection, network attachment and proxy access consistently. Test with mocked Docker APIs and
two disposable instance namespaces first: starting/restarting A must leave B's running container
and orphan unchanged; A may remove only its own orphan. A legacy-container policy is needed so
an unscoped old runner cannot remove the other instance's containers. Never demonstrate this
against an actual live run.

Preflight the rendered `docker compose config` without printing secret values into retained
logs. Assert distinct ports, volumes, networks, image tags, credentials and service URLs; verify
`AGORA_SANDBOX_NETWORK` matches the test network and the proxy permits only the intended target.
Generate `e2e/.env.e2e` directly: `scripts/setup-env.js --force` resolves its output from the
repository root and must not overwrite an existing `.env` in a shared checkout. Teardown must
use the exact test project/config/env paths and delete only test-owned resources. Avoid broad
image pruning and `--rmi local` on a daemon sharing image tags with production.

## 2. P2: inventory and live-feature gaps need explicit coverage state

Include the already delivered `beta-test-coverage-review.md` and `beta-test-surfaces.csv` in
PR #125, or integrate their contents. The 439-row discovery ledger must map to executable
scenario IDs or reviewed exclusions. Existing test files and feature descriptions are anchors,
not passed scenarios. Reconcile dynamic tools, sockets, workers and CLI/deployment entrypoints.

Use this scenario record for automation and manual checks:

```text
scenario_id, surface_ids, build_sha, environment_id, fixture_seed,
actor_role, provider_auth_mode, model_cli_versions, host_os, browser_device,
steps, expected_ui, expected_persisted_state, expected_side_effect_count,
result, evidence_links, issue_id, elapsed_seconds, observed_usage
```

Allowed results: `not_run`, `running`, `passed`, `failed`, `blocked`, `not_applicable`.
Require reasons for blocked/not-applicable and retain the unexecuted platform combinations.

Add concrete manual tests for live SIWC command and file-change approvals: inspect the full
command/cwd, approve once, deny, let a request expire, stop before approval, and stop between
approval and host polling. The existing SIWC checklist connects/disconnects and checks the plan
owner, but does not exercise the live structured-approval path that PR #123 introduced. Keep
permission-grant/managed-network protocol variants deterministic where the CLI cannot reliably
be made to emit them; report which variants were actually observed live.

Add upgrade from the previous deployed schema, backup/restore into an empty disposable stack,
host crash after a side effect but before completion, lease expiry/redelivery, provider and
DB/Redis/storage outages, and a concurrent-client soak. Define a cloud connection matrix per
enabled provider/capability: save, test, invoke, invalid/revoked credential, 429/timeout and
reconnect. Distinguish host CLI keys from server-managed provider settings: the current
"API keys never leave the host" check applies to host CLI credentials, not to keys intentionally
stored encrypted by the server for assistant/speech/search/image connections.

Let the owner's safe intended-use checks begin alongside automation after the first prepared
smoke passes; do not require completion of every platform before any manual session. Break the
100-item checklist into persistent five-check sessions. Identify read-only/normal-use checks
permitted on main versus destructive/revocation/fault-injection cases restricted to the test
instance. The owner explicitly offered to test main; this should be reflected in the plan.

## 3. P2: vision validation and spend need measured prerequisites

Do not promote vision to a blocking gate after only two clean runs. Keep it advisory until it
has been evaluated against a labeled set containing actual broken and valid screens. Publish
false-negative/false-positive results and send uncertain cases to human review. Two identical
answers from the same grader are not independent validation.

The draft's exact Haiku model ID, pricing, effort/sampling and structured-output capabilities
need official-provider verification and a small live capability preflight when keys are supplied.
Configure the model/version/rate card; record the source and verification date. Until then,
label the $0.03/run figure an unverified estimate rather than a guaranteed cost. Set an output
limit and account for image, cache and any provider-billed reasoning tokens using actual usage.

With concurrency four, adding usage after responses cannot enforce a hard local dollar cap:
calls and retries are already in flight. Reserve a conservative per-request cost before
dispatch in one shared budget counter; include retries and re-asks, reconcile actual usage,
and stop scheduling when reservation would exceed the remaining balance. Record in-flight
exposure separately if no reliable upper bound exists. Provider-side enforceable key limits
remain the backstop; a dashboard budget alert must not be described as a hard cap.

Use explicit element/state readiness and settled animations for screenshots. `networkidle`
is not a universal readiness condition for a realtime app with long polls and streaming.
Virtual WebAuthn tests are Chromium/CDP-specific; skip with a reason on other engines and keep
real Mac/phone platform-authenticator tests. `ignoreHTTPSErrors` tests do not prove trusted TLS;
the manual trusted-certificate check remains separate.

## 4. P2: keep failure evidence without retaining credentials

Default teardown currently deletes all artifacts unless `E2E_KEEP=1`, including the evidence
needed for a failed run. Preserve sanitized failure traces/screenshots/logs and a run manifest
before teardown; always remove generated credentials/config/storage state. Successful-run
artifact retention can be short and configurable. Do not require a screenshot for failures
that occur before the UI exists; logs, traces or API/state evidence are appropriate then.

Masking a token in a screenshot does not remove it from Playwright network traces, request
bodies, storageState files or `seed.json`. Separate credential-bearing artifacts from the
uploadable report and scan for the exact seeded canary values as well as common token patterns.
Exercise this scanner on a deliberately contaminated fixture before any external vision upload.
Provider credentials are also present in host child environments by design: test that they
do not leak to the server, unrelated child processes, model prompts or retained artifacts.

## 5. Proposed immediate implementation sequence

1. Reconcile coverage and publish the environment manifest; keep shared-daemon runtime disabled.
2. Build setup/login/send/reconnect/approval smoke on an isolated non-runtime test project.
3. Run five manual normal-use checks concurrently with that smoke; retain sanitized failures.
4. Add live provider and actual Mac/phone tests once their environment/keys exist; record blockers.
5. Add fault/recovery/runtime tests on proven isolated resources, then evaluate the release gates.

Acceptance of the plan is separate from claiming that tests have run. Neither this review nor
the proposed suites certify the current deployment. Next: revise PR #125's shared-engine
isolation section first and post its new head SHA.

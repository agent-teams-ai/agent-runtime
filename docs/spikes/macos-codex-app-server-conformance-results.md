# macOS Codex App Server conformance results

Status: accepted scoped evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/macos-codex-app-server-summary.json`

Summary SHA-256:

```text
d9e6552a179843a95762df1cd8cc042cbfb19d483a57bd57796d9b5009e11d91
```

## Scope and authorization

The campaign ran Codex App Server stable JSONL-over-stdio on macOS `15.6.1`
build `24G90`, Apple Silicon, in two new synthetic Git repositories. It used
the existing Codex CLI login after explicit approval and made real first-party
provider calls. It did not open a user project or use a real MCP server.

The provider ran from a separate temporary `CODEX_HOME`. Its mode-`0600` auth
copy remained byte-identical and was deleted with the scratch directory.
Credential values and account identifiers were not printed, inspected,
hashed, or retained.

The retained campaign stayed on the stable API surface:
`experimentalApi=false`. Broad methods such as `thread/shellCommand`,
filesystem writes, config writes, plugin install, and OAuth login were not
called or exposed as AR capabilities.

## Exact binary and schema pair

| Version | Native binary SHA-256 | Generated files | V2 schema bundle SHA-256 |
| --- | --- | ---: | --- |
| `0.144.1` | `29915529...167a` | 267 | `3e391f0e...3ee` |
| `0.145.0` | `1da3f4e0...f590` | 273 | `26e2ad0d...f98` |

The generated `0.145.0` tree added six schema files and removed none. Fifty
eight shared generated files changed. In the selected core ThreadStart,
ThreadResume, TurnStart, TurnCompleted, and ItemCompleted surfaces, the audit
found no removed top-level property, required field, or enum value; `0.145.0`
added audio-related variants.

This is a two-revision observation, not a general compatibility guarantee.
The generated schema bundle is part of `BinaryRevision`.

## Protocol and isolation results

- A request before initialization returned `-32600 Not initialized`.
- Repeating initialization returned `-32600 Already initialized`.
- Both binary revisions completed an exact App Server marker turn.
- `project_doc_max_bytes=0` returned zero `instructionSources`.
  `project_doc_max_bytes=32768` returned the synthetic `AGENTS.md` source.
- A persisted thread resumed from a different synthetic cwd, retained prior
  context, and completed the expected marker. Thread ID and cwd remain routing
  data, not authorization.
- Two latest-version turns on two different threads completed concurrently
  with independent markers.

The environment probe found a concrete default counterexample:

- default shell policy exposed a synthetic non-secret ambient variable;
- `shell_environment_policy.inherit="none"` removed it;
- the strict profile added only an explicit bounded `PATH`.

Subprocess environment inheritance is therefore a materialized profile
decision, not a provider default.

## Read-only and effect evidence

Direct App Server `command/exec` under explicit `readOnly` policy returned
`exitCode=1`, and the attempted target file remained absent. This was a useful
structured result.

A model-driven patch attempt behaved differently:

- the turn completed;
- the file remained absent;
- the exact sandbox rejection appeared on stderr and in agent text;
- completed item events contained only `userMessage` and `agentMessage`;
- no structured patch-failure, file-change, or command-execution item appeared.

App Server stable events therefore do not make every tool denial structured.
Agent text cannot serve as an effect receipt.

## Interrupt and same-thread overlap counterexample

The first long turn returned from `turn/start`, emitted `turn/started`, and
completed with `status=interrupted` after `turn/interrupt`.

Before interrupting it, the client sent a second `turn/start` for the same
thread. App Server returned a successful response containing a second turn,
but that turn:

- emitted no `turn/started`;
- emitted no `turn/completed`;
- did not become interruptible;
- returned `-32600` when interrupted and reported the first turn as still
  active after the first interrupted terminal notification.

The server process still exited cleanly when its stdio connection closed.

This rejects the assumption that a `turn/start` response is execution
acceptance. AR must serialize dispatch per provider thread and require its own
acceptance/terminal reconciliation.

## Privacy observation

Both tested revisions emitted unsolicited `account/rateLimits/updated`
notifications during turns. Raw payloads contained account-plan and rate-limit
details. Those values were excluded from retained evidence.

This notification belongs to tenant-private Provider Access projection. It
must not enter general logs, cross-context events, or public runtime output.

## Architecture consequences

- Agent Execution exposes a narrow Codex adapter port, not arbitrary App
  Server methods.
- One provider thread has one AR-owned serialized dispatch lane.
- `turn/start` response, `turn/started`, terminal notification, process exit,
  stderr, usage, and verified effects remain distinct observations.
- Missing or contradictory provider evidence produces
  `reconcile_required`; it never produces inferred success or an automatic
  duplicate dispatch.
- The adapter is generated and tested against an exact schema revision.
  Unknown additive fields and notifications are tolerated, then allowlist
  projected.
- `account/rateLimits/updated` is owned by Provider Access with tenant-private
  ACL and redaction.
- `shell_environment_policy.inherit="none"` plus an explicit typed allowlist is
  part of every hosted Codex materialization.
- Thread/session/turn IDs never cross the Runtime Security boundary as
  authorization credentials.

These findings fit the accepted strict modular control plane plus separate
workers. They add provider-specific adapter rules without moving ownership
between Runtime Configuration, Runtime Security, Provider Access, Agent
Execution, and Runtime Capacity.

## Evidence

Retained redacted bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-codex-app-server-conformance-2026-07-28.tar.gz

SHA-256
a8f1ce90d899a8488fbd07d53131dca8ab750d3db00e1f904a5feaf3ca544019
```

The bundle contains the allowlist summary, synthetic harness, exact generated
V2 schema bundles, and synthetic instruction canary. It excludes auth,
account/session IDs, plan/credit/rate-limit values, raw App Server/provider
messages, and raw stderr.

## Effect-lifecycle follow-up

The later
`docs/spikes/macos-codex-app-server-effects-results.md` campaign closes the
scoped successful and failed shell/patch lifecycle, output drain,
completed-request replay, explicit same-thread serialization, interrupt, and
process-crash recovery matrix.

It confirms that `clientUserMessageId` is not an idempotency key, a failed
command may already have committed an effect, and provider crash recovery does
not replace an AR-owned operation journal and effect ledger.

## Remaining gates

This closes scoped local stable-stdio core behavior. It is not a production
Codex adapter `GO`.

Still required:

- implementation and regression conformance of AR same-thread serialization,
  operation journaling, idempotent effect receipts, and terminal
  reconciliation;
- provider-side cancellation and billable-work reconciliation;
- long-duration concurrency, backpressure, restart, and in-flight resume soak;
- dedicated non-user account plus credential refresh/revocation generation
  CAS;
- schema compatibility, upgrade, and rollback policy beyond `0.144.1` and
  `0.145.0`.

References:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server);
- [Codex configuration
  reference](https://learn.chatgpt.com/docs/config-file/config-reference);
- [Codex open-source App Server](https://github.com/openai/codex/tree/main/codex-rs/app-server).

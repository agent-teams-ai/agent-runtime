# macOS Codex App Server effect-lifecycle results

Status: accepted scoped evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/macos-codex-app-server-effects-summary.json`

Summary SHA-256:

```text
0a9a42ac21807875127a441e00774f06f785b23f77331cf7c980ec24f76af0e6
```

## Scope and authorization

One frozen campaign ran the stable Codex App Server JSONL-over-stdio API on
macOS `15.6.1` arm64 in a new synthetic workspace. It used an explicitly
authorized copy of the existing Codex login and made real first-party provider
calls. It did not open a user project, load global configuration, or use a real
MCP server.

The copy lived under an isolated temporary `CODEX_HOME`, remained
byte-identical during the campaign, and was deleted with the scratch
directory. Credential values, raw provider messages, account data, and
provider thread or turn IDs were not inspected or retained.

The tested closure was:

| Component | Revision |
| --- | --- |
| `@openai/codex` | `0.145.0` |
| native package | `0.145.0-darwin-arm64` |
| native binary SHA-256 | `1da3f4e0...f590` |
| generated V2 schema raw SHA-256 | `28a83feb...14ba` |

The earlier `0.145.0` campaign recorded a different raw schema hash because
the JSON formatting differed. Canonicalizing both bundles with `jq -cS`
produced the same SHA-256, `8930e344...1201b`; no schema-semantic difference
was observed.

## Results

All eleven retained assertions passed:

| Scenario | Observed fact |
| --- | --- |
| successful shell | structured `commandExecution` completed with exit `0`; exact effect existed |
| successful patch | structured `fileChange` completed with an `add`; exact effect existed |
| failed shell | command failed with exit `23`, but its earlier filesystem effect remained |
| output drain | `21,504` output bytes arrived before command and turn terminal; no late delta followed |
| completed-request replay | the same `clientUserMessageId` was accepted again as a distinct turn and produced a second effect |
| same-thread serialization | two turns dispatched only after the prior terminal completed in exact effect order |
| interrupt | terminal status was `interrupted`; the delayed effect did not occur |
| process crash | an effect existed before `SIGKILL`, no provider terminal had arrived, and persisted projection later showed `interrupted` with no command item |
| recovery | the restarted App Server accepted a recovery turn and completed the exact marker |
| credential custody | the isolated auth copy remained byte-identical |
| cleanup | no matching process or raw synthetic effect remained |

The crash result is intentionally asymmetric: the provider projection knew the
turn was interrupted but did not contain the command item whose effect had
already committed. A provider terminal or persisted provider transcript is
therefore not an effect ledger.

The replay result rejects using `clientUserMessageId` as an idempotency key.
It is provider metadata, not an exactly-once boundary.

## Architecture consequences

- Agent Execution owns one serialized dispatch lane per Codex thread.
  `turn/start` is not sent until the previous operation has terminal or
  explicit reconciliation state.
- Every effectful request carries an AR `OperationId` and `CommandId`
  independent of provider thread, turn, item, and client-message IDs.
- The effect worker uses a durable idempotent command ledger. A replay with the
  same semantic command returns the committed receipt; it does not execute the
  effect again.
- Process exit, turn status, command/file item status, output drain, and
  business-effect receipt are separate observations. None implies the others.
- A failed command may have committed a partial effect. Failure enters
  compensation or reconciliation according to the command contract; it never
  implies rollback.
- Terminal publication waits for the adapter's output-drain barrier. Output
  after that barrier is a protocol violation and produces
  `reconcile_required`.
- Interrupt prevents future work only when descendant custody and the effect
  ledger confirm it. Crash after an effect but before a receipt is an unknown
  outcome until reconciled.
- Provider persisted history is useful recovery evidence but cannot replace
  the AR operation journal, command ledger, outbox, or artifact receipt.

These rules stay inside the accepted strict modular control plane plus
separate workers. Agent Execution owns operation state; Runtime Security owns
authorization and fencing; effect-host adapters own idempotent execution and
receipts. Provider-specific identifiers remain adapter observations.

## Evidence

Retained redacted bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-codex-app-server-effects-conformance-2026-07-28.tar.gz

SHA-256
86f1e5a10162267135a846d01672b9568f8922ba7f8c51f89ba155db9f173880
```

The bundle contains the allowlisted summary, canonical-schema audit, frozen
synthetic harness, exact npm lockfile, generated V2 schema, and inert workspace
seed. It excludes auth, runtime databases, raw provider traffic, account data,
provider IDs, and raw effect files.

## Remaining gates

This closes the scoped local shell/patch/effect lifecycle, output drain,
completed-request replay, explicit same-thread serialization, interrupt, and
process-crash recovery matrix. It is not a production Codex adapter `GO`.

Still required:

- implementation and regression conformance of the AR-owned operation journal,
  command ledger, effect receipts, drain barrier, and reconciliation states;
- provider-side cancellation and billable-work reconciliation;
- long-duration concurrency, backpressure, restart, and in-flight resume soak;
- dedicated non-user account plus credential refresh/revocation generation
  CAS;
- schema upgrade and rollback qualification beyond the tested revisions;
- production macOS descendant custody and endpoint-specific network
  containment.

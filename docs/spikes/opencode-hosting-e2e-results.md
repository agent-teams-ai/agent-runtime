# OpenCode hosting E2E conformance results

Status: accepted scoped follow-up evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/opencode-hosting-e2e-summary.json`

Summary SHA-256:

```text
efdb9caf86efae6dcb29529a84eb65a26b33ec42d837635afba71ac85579bf89
```

This follow-up resolves OpenCode-specific uncertainties left by Stage B and
Stage C. It does not alter their frozen source, campaign evidence, or accepted
historical claims.

The later Apple Silicon platform follow-up is recorded in
`docs/spikes/opencode-macos-conformance-results.md`.

## Safety and scope

All agent processes ran on the designated Linux hosting worker
`codex-workers-eu-01` and only inside newly created synthetic workspaces and
state roots. No user project or ambient user configuration was opened.

The matrix used:

- OpenCode `1.18.5`, SHA-256
  `78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21`;
- OpenCode `1.18.8`, SHA-256
  `8179ed5ef819eb5a11310ceeb7a4e30e2ecbf29b1486ea06531f8b8375003972`;
- ACP v1 over stdio;
- a deterministic local OpenAI-compatible provider stub for race and fault
  control;
- a disposable ChatGPT OAuth grant and primarily `openai/gpt-5.6-sol`, plus one
  `openai/gpt-5.6-terra` switch probe, only for behavior that a stub could not
  prove;
- synthetic MCP and skill sentinels only.

The retained summary contains no token value, credential digest, account
identifier, raw provider payload, or user-project content. All disposable
credential files, test state, mounts, and processes were deleted after the
matrix.

The machine-readable fixture is the canonical retained redacted result ledger.
No separately addressable raw-evidence manifest or digest canonicalization was
retained, so this follow-up does not claim a cryptographic chain to deleted
per-run scratch. An earlier unlabeled aggregate digest was removed because its
input could not be independently resolved.

## Confirmed execution behavior

### Session concurrency and ownership

- Five real same-session races issued ten concurrent prompt RPCs. Every RPC
  returned `end_turn`, but three runs retained only the second answer and two
  runs serialized both. SQLite contained ten user messages and only seven
  finished assistant messages.
- Five deterministic same-session races on each of `1.18.5` and `1.18.8`
  always coalesced to the second prompt while both RPCs returned `end_turn`.
- Five real distinct-session races produced ten of ten exact, isolated
  responses and ten finished assistant messages.
- A known session ID resumed from another non-Git workspace, another
  uncommitted Git workspace, and a different committed Git repository. The
  next provider request contained the original user and assistant history.
  `session/list` did not reveal the foreign session, so list filtering is not
  an authorization boundary for `session/resume`.

These observations require one serialized prompt lane per OpenCode session and
an AR-owned session-to-tenant/workspace authorization registry. A successful
ACP RPC is not evidence that one independent provider execution occurred.

### Cancellation, terminal output, and recovery

- Immediate cancellation failed with `-32603 Internal service failure` in
  twenty of twenty deterministic `1.18.8` runs. In the version comparison it
  failed ten of ten runs on `1.18.5` and nine of ten on `1.18.8`.
- Cancellation after the first generic ACP update cancelled and reused the
  session in nineteen of twenty runs. The first update is not a safe dispatch
  barrier.
- Cancellation after deterministic provider acceptance cancelled and reused
  the session in twenty of twenty runs. The delayed provider write was rejected
  after transport interruption.
- The terminal prompt RPC preceded the final `session/update` in thirteen of
  twenty runs, with a maximum measured lag of 100 ms.
- Five `SIGINT` and five `SIGKILL` runs resumed the same session in a new
  process and completed an exact new prompt.
- Five crashes after provider acceptance but before the first output closed the
  provider transport and did not automatically redispatch the old request.
  Resume succeeded, but OpenCode SQLite retained an incomplete assistant row.
- Clean and post-crash resume passed five clean plus three `SIGKILL` runs in
  each direction between `1.18.5` and `1.18.8`.

The provider-acceptance projection, canonical output stream, command receipt,
and output-drain barrier therefore remain AR state. OpenCode SQLite is useful
provider state but is not canonical operation or streamed-output evidence.

### Provider errors and retry behavior

Three repeated runs per fault produced:

| Fault | Provider requests before outcome |
| --- | ---: |
| HTTP 401 | `1, 1, 1`, immediate typed ACP error |
| malformed SSE | `1, 1, 1`, immediate parse error |
| HTTP 500 | `3, 3, 3` before the 15-second outer timeout |
| disconnect before first chunk | `3, 3, 3` before timeout |
| disconnect mid-stream | `3, 3, 3` before timeout |
| HTTP 429 with `Retry-After: 0` | `132, 66, 133` before timeout |

OpenCode/provider-SDK retry behavior is not an AR retry budget. Agent Execution
must cap provider attempts, wall time, output, and late evidence independently.

### Hidden dispatch and failure behavior

- Five auto-title CLI runs made two provider requests each, while five
  equivalent explicit-title runs made one provider request each.
- Missing authentication, invalid authentication, an unknown model, and a
  disabled default plugin all exited nonzero. No fallback inference was
  observed.

The adapter must supply an explicit title or disable the title agent so that
one AR dispatch maps to the intended provider-call budget. Provider failure
must remain explicit rather than silently changing credentials, model, route,
or plugin behavior.

## Confirmed isolation and capability behavior

### Project configuration, MCP, and skills

- `acp --pure` with project configuration enabled started the same synthetic
  MCP server twice per logical ACP run in five of five runs.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` prevented all MCP starts in five of five
  equivalent runs.
- `--pure` alone loaded a synthetic HOME skill description into the provider
  prompt. A clean HOME plus both external-skill disable flags removed it.

The deterministic launch contract is an allowlisted materialization and clean
environment. `--pure` is a useful plugin control, not a complete isolation
mode.

### Filesystem and attachments

With `external_directory: deny` and a real provider tool loop:

- a direct absolute external read was denied;
- a workspace symlink exposed the external file;
- edits through workspace symlink and hardlink paths changed the external
  target;
- CLI `--file` attached an external absolute path.

OpenCode path permissions do not replace projection-time filesystem
containment. Materialization must reject or safely replace symlinks, hardlinks,
special files, traversal, and unsupported entries, and attachments must be
prevalidated by AR.

### Tool and model capability projection

- deny-all exposed no tools;
- read-only exposed `read`;
- edit-only exposed both `edit` and `write`;
- write-only exposed no tool;
- read, edit, and write exposed all three.

A configured tool-output limit of ten lines and 200 bytes did not truncate a
206-line, 19,490-byte tool result before it reached the model prompt.

An active real session switched from `gpt-5.6-sol` to `gpt-5.6-terra`, and an
arbitrary invalid variant string was accepted and persisted while inference
succeeded. Tool names, model, mode, and variant must be validated against a
versioned adapter capability set rather than forwarded as raw ACP options.

### Process and port custody

- A provider-started background process survived OpenCode termination in three
  of three `SIGINT`, three of three `SIGTERM`, and three of three `SIGKILL`
  runs. The harness removed every descendant explicitly.
- Five pairs sharing a fixed ACP port produced exactly one failed process per
  pair. Five pairs using `--port 0` completed ten of ten processes.

The supervisor must own and verify the complete cgroup or equivalent process
subtree. OpenCode PID termination is insufficient. The Linux ACP adapter should
delegate ephemeral port selection to the OS unless a separately tested atomic
port lease is required.

## Credentials, dependency egress, and storage

### OAuth generation behavior

- Two independent profiles refreshed the same expired OAuth generation
  concurrently twice. Both branches remained usable and wrote distinct access
  and refresh generations for the same account.
- Five forced two-process races against one shared auth file completed ten of
  ten real calls. JSON remained valid, mode stayed `0600`, and a final
  validation call succeeded.
- Four retained refreshed profiles had the same account identity but four
  distinct access and refresh generations.

File validity and provider success do not select a canonical credential
generation. Provider Access still requires account binding, generation CAS,
stale-generation rejection, and durable garbage collection.

### Dependency and egress behavior

A traced cold OAuth execution connected to both npm registry and
`chatgpt.com`; the warmed execution connected to `chatgpt.com` only. Explicit
autoupdate and models-fetch disable flags did not make cold dependency
preparation hermetic.

Hosted deterministic preparation must resolve and pin required OpenCode plugin
bytes before launch. Runtime package download is either prohibited or an
explicit separately authorized preparation effect, never an invisible provider
side effect.

### SQLite behavior

- Concurrent cold first use failed one process in eight of twenty pairs with
  table-creation or `database is locked` errors.
- Fifty warmed concurrent list pairs and forty warmed ACP writer processes
  completed without observed failure. These positive samples do not authorize
  shared mutable state across runtime instances.
- At zero free bytes OpenCode failed on `PRAGMA wal_checkpoint(PASSIVE)`.
  SQLite integrity remained `ok`, and the same profile recovered after space
  was released.
- With WAL sidecars present, one header-only corruption did not prevent the
  next prompt. A fully invalid 4,096-byte database failed closed; restoring the
  verified authoritative copy recovered operation.

OpenCode state bootstrap needs one fenced owner. Storage pressure and
corruption are typed storage outcomes, not generic provider failures.

## Relationship to ADR-0001

The follow-up confirms the planned bounded contexts and does not require a new
cross-cutting runtime-profile service:

- Runtime Configuration still owns immutable profile and dependency intent.
- Provider Access still owns account identity and credential generations.
- Agent Execution still owns session ownership bindings, operation
  serialization, provider acceptance, output authority, retry budgets, process
  custody, workspace/filesystem enforcement, and recovery.
- Runtime Capacity may supply opaque resources, but ports and process IDs do
  not become business identities.

The larger conclusion is that OpenCode is an untrusted side-effect executor
behind an adapter. ACP is transport, OpenCode SQLite is provider state, and
provider-native permission flags are defense in depth. None of them can own AR
authorization or canonical execution truth.

This evidence hardens the implementation order:

1. build isolated materialization, session ownership, serialized operation
   lanes, credential generation CAS, and process-subtree custody;
2. add durable acceptance, output drain, retry/timeout quotas, and recovery;
3. implement the OpenCode ACP adapter against those ports;
4. only then expose orchestrator, Desktop, CLI, or SDK integration.

## Remaining gates

The scoped Linux ACP adapter decision matrix is complete. Later scoped
follow-ups also completed non-root container/cgroup custody, the internal
network counterexample, synthetic immutable-container OpenCode E2E,
application-gateway TLS semantics, local Connect replay, and single-host plus
two-physical-client PostgreSQL concurrency. Their dedicated evidence documents
define the remaining boundaries.

Production release still requires:

- production signed-gateway policy loading, public-PKI external DNS/proxy and
  streaming conformance, plus trusted Docker-daemon custody and platform
  hardening;
- physical power-loss, migration, backup/restore, and object-storage behavior;
- PostgreSQL replication, leader failover, partitions, PITR, and production
  migration/pool behavior;
- external Connect proxies/load balancers, multi-host drain, SDK parity, and
  production retention/key rotation;
- production key custody and an off-host trust anchor;
- remaining macOS network/process-escape/real-provider/version gates and full
  Windows containment;
- real Codex and Claude provider conformance and any additional supported
  OpenCode routes;
- a version policy broader than the tested `1.18.5` and `1.18.8` pair.

---
id: evidence.opencode-acp-1-18-25-contract-validation
type: evidence
status: evidence-reference
owner: architecture/qualification
summary: Records bounded OpenCode 1.18.5 contract characterization plus the separate normalized 1.18.25 observation.
related:
  - ADR-0001
  - ADR-0010
  - runtime.architecture.opencode-integration
  - runtime.architecture.contained-agent-turn-v1-delivery-plan
---

# OpenCode ACP policy characterization

## Scope and authority

This experiment characterizes Agent Runtime-owned OpenCode ACP v1 policy for
ADR-0010's accepted OpenCode `1.18.5` pin. It does not claim exact-version
contract closure or replay through the Contained Agent Turn kernel. The
fixture claim is `contract_only_no_production_adapter`; it does not implement
a production OpenCode adapter or establish product E2E or containment
qualification.

The executable fixtures are synthetic/normalized inputs. The exact `1.18.5`
fixture is a deterministic projection of already checked-in immutable,
redacted evidence, not a newly captured or reconstructed raw ACP transcript.
No raw ACP transcript or machine-bound provenance artifact for the separately
supplied OpenCode `1.18.25` run exists in this patch. Fixture digests freeze
repository bytes and bind the exact contract projection to its retained
sources; they do not turn normalized values into raw provider output.

No provider, network, credential, user project, or production runtime is used
by the tests.

## Validation boundary

The experiment uses `@agentclientprotocol/sdk@1.3.0` rather than a local ACP
wire implementation:

- the official SDK ACP v1 JSON schema validates initialize, permission, session
  update, and cancellation shapes at runtime;
- SDK types define the policy inputs and results;
- `ClientApp` owns typed client callback registration and rejects malformed
  callback parameters on a connection;
- `ndJsonStream` and the SDK connection own JSON-RPC correlation, NDJSON
  framing, callback routing, and connection lifecycle.

The executable handshake probe also uses `ClientApp`, `ndJsonStream`, and the
typed SDK agent context methods directly. The SDK is the sole owner of request
identifiers, correlation, and late-response handling; the probe neither
observes nor shadows those internals. In-memory SDK tests exercise callback
routing and normal connection closure without a second ACP wire.

Because SDK `ndJsonStream` diagnostics can include a malformed input line, the
experimental probe runs the SDK connection in a diagnostic-isolation worker.
The already byte- and line-bounded Web streams are transferred directly to
that worker; no owner-local parser, framing layer, request identifier, or
correlator is inserted. Worker stdout and stderr are drained behind fixed byte
caps and retained only as counts, truncation state, and SHA-256 digests. SDK
diagnostic text is never forwarded to the probe's stdout or stderr. The
synthetic malformed-input test demonstrates this containment boundary; it is
not a provider transcript or provider qualification run.

The repository intentionally has no custom JSON-RPC or NDJSON transport tests.
Those are SDK responsibilities, not Agent Runtime policy.

The SDK's raw `ndJsonStream` line buffer does not expose production byte or
line bounds. A future production OpenCode slice must pass already bounded,
backpressured byte streams from Host Custody into the thin attachment seam.
Host Custody must own byte, line, buffer, time, process-exit, and residue bounds;
the thin attachment seam neither forks the SDK transport nor supplies those
production bounds.

The experimental probe applies local Host/OpenCode policy limits to stdout
bytes and lines, stderr, retained callback summaries, request and workflow
time, SDK closure, and post-signal process waits. Every retained SDK result,
callback, error, anomaly, stderr observation, and workflow field goes through
one owner-local bounded projection. That projection retains only protocol
version, bounded identifiers/statuses, fixed prompt-marker matches, bounded
command names, typed outcomes, counts, and SHA-256 digests. It never retains
session-list contents, workspace paths, permission options, tool arguments,
stderr text, provider output, credentials, environment values, or arbitrary
nested objects. Unsupported or oversized evidence is represented only by a
typed anomaly and digest. These limits characterize a possible custody policy;
they are not production Host Custody implementation or qualification evidence.
Ordinary `Error` values are reduced to a digest over a bounded canonical error
name and small message (or an oversized-message size marker); message, stack,
cause, and attached fields are never retained.

Ordinary SDK rejection and initialization/version failure fail the probe.
Request timeout is a bounded ambiguity failure, not a successful observation.
The deadline observer assigns no request identifiers and inspects no SDK
diagnostics; a later settlement of the returned SDK promise is reduced to a
typed safe anomaly so a late rejection is not silently discarded.
Connection closure is also bounded; a closure timeout remains a typed retained
anomaly before finite SIGTERM/SIGKILL process cleanup proceeds. If exit remains
unconfirmed after SIGKILL, the probe retains that uncertainty, destroys its
remaining child stdio handles, and unreferences the child so evidence emission
and probe termination do not depend on a later close event. This is only
bounded experimental cleanup, not proof that the provider process or all of
its descendants exited.

## Agent Runtime-owned policy

The focused policy layer establishes only these rules:

- ACP v1 is the sole supported execution protocol. A requested-v2 observation
  is accepted only when the retained response explicitly negotiates v1; an
  actual v2 response is a typed `unsupported_protocol` result.
- `session/new`, `session/prompt`, `session/cancel`, and `session/update` are
  baseline ACP v1 methods.
- `loadSession: true` advertises `session/load`.
- optional `sessionCapabilities` entries are advertised by non-null key
  presence. `{}` is advertised, while `null` and omission are unsupported.
- advertised `fork` is recognized but deferred, distinct from both unsupported
  omission and bounded unknown extension keys.
- mapped capability values, present official fields that remain deferred or
  out of scope, and unknown extension keys are retained separately. Tests cover
  `{}`, `null`, and omission for every modeled session capability and preserve
  the separate `loadSession` boolean rule.
- unsupported protocol, unsupported capability, and malformed observation are
  distinct typed failures.
- provider, session, tool-call, and capability identifiers are bounded before
  retention. Returned observations are detached and frozen.
- permission requests and tool updates must match the active session.
  Permission is never auto-approved; the SDK client app returns cancellation
  until a future Runtime Security/Agent Execution authority bridge exists.
- cancellation is `cancelled_before_acceptance` only with explicit no-start
  proof and no conflicting terminal evidence. Contradictory or incomplete
  evidence remains `ambiguous_requires_reconciliation`.

## Exact 1.18.5 contract-only characterization

`opencode-1-18-5-contract.json` strictly characterizes retained evidence for
`opencode-ai@1.18.5` and binary revision
`opencode@1.18.5#78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21`.
Its SHA-256 is
`c540dc43d931ec8355e3f13ac4feebebb42498703e79c360b18191df0eb29a84`.

The fixture records the path, SHA-256, and narrow role of five immutable
inputs:

- the exact-binary container/TLS summary for ACP v1, prompt, and `end_turn`;
- the hosting result ledger for exact-version cancellation timing;
- the provider behavior matrix for the exact-version session operation
  characterization;
- the operation-oracle contract for the exact provider revision, capability
  manifest revision, manifest provider revision, and fail-closed policy;
- the synthetic contained-turn projection fixture for the neutral `analysis`
  mode and its declared OpenCode identity gap.

The fixture calls its capability object a `derivedCapabilityProjection`; it is
not an observed initialize response. Field-level JSON pointers bind every
projected field to retained source data. In particular, cancellation points to
the hosting ledger's exact `1.18.5` timing result, and the neutral contract
binds both `opencode-acp-contained-turn-v1@1` and the manifest's exact
provider revision.

The exported loader accepts only bounded UTF-8 JSON bytes. It rejects malformed
or duplicate-key JSON, excessive bytes, nesting, nodes, object properties,
array entries, and strings before model validation. Every modeled object has
an exact own-key set; raw ACP framing, `_meta`, raw fields, and capability
promotion are rejected. The loader calculates and verifies every fixed-path
source digest internally, constructs fresh values only from validated
primitives, and returns deeply frozen data.

The resulting characterization retains only provider identity and revision,
the `analysis` mode, fail-closed unknown-capability policy, the bounded
successful terminal observation, and the contract-only claim. It preserves
separate `supported`, `deferred`, `unknown`, and `unsupported` dispositions.
It does not retain workspace paths, session text, tool arguments, credentials,
provider output, or network data.

No OpenCode replay through the current neutral port/kernel is claimed. The
separate synthetic kernel test exercises currently expressible projected
outcomes using the current harness identity and continues to declare that an
OpenCode identity is not expressible there without production-contract
widening. The characterization therefore does not close that contract gap.
The official ACP SDK remains the only framing and correlation owner; the exact
fixture adds no request identifiers, NDJSON transport, ACP parser, or second
ACP wire.

## Separate retained 1.18.25 normalized observation

`opencode-1-18-25-normalized.json` retains only the supplied normalized facts:

- protocol v1;
- `loadSession: true`;
- prompt image and embedded-context support, with audio omitted;
- MCP HTTP and SSE support;
- session close, fork, list, and resume advertisements;
- fixed output SHA-256
  `dc5d87f627deedda40c795c8435536e04764761fee5dbe2fb29e7e4e90484e74`;
- zero USD reported;
- no permission or tool request observed.

The separately supplied binary version was OpenCode `1.18.25`, with SHA-256
`d91e0d33676d0839f7cde87924cd4127ea88c9d6784eea9f009a7d08bdc60eeb`,
in a disposable empty sandbox. Because the raw transcript is absent, the
fixture is normalized characterization, not exact-version contract closure.
The absence of permission/tool requests in one run does not qualify permission
or tool enforcement.

## Deferred production work

- production OpenCode adapter and composition;
- production provider process custody and descendant closure;
- production credential binding and provider access route enforcement;
- production semantic deduplication and reconciliation of ambiguous outcomes;
- production request deadlines and evidence projection;
- bounded Host Custody streams, process custody, stdout/stderr/message and
  output closure, output drain, and residue evidence around the SDK connection;
- provider acceptance, durable cancellation, and effect reconciliation;
- Runtime Security permission enforcement and durable interactions;
- native OpenCode history/status reconciliation;
- canonical output cursoring, artifact sealing, and terminal receipts;
- credentials, workspace, egress, and descendant-process controls;
- production provider qualification and containment evidence beyond this
  exact-version contract-only fixture;
- a disposable product E2E through the production composition.

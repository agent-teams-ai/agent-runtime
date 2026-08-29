---
id: evidence.opencode-acp-1-18-25-contract-validation
type: evidence
status: evidence-reference
owner: architecture/qualification
summary: Records synthetic ACP v1 policy characterization and a normalized OpenCode 1.18.25 observation.
related:
  - ADR-0001
  - ADR-0010
  - runtime.architecture.opencode-integration
  - runtime.architecture.contained-agent-turn-v1-delivery-plan
---

# OpenCode ACP policy characterization

## Scope and authority

This experiment characterizes Agent Runtime-owned OpenCode ACP v1 policy. It
does not close an exact-version contract lane, implement a production OpenCode
adapter, or establish product E2E or containment qualification. ADR-0010's
accepted OpenCode `1.18.5` contract pin is unchanged.

The executable fixtures are synthetic/normalized inputs. No raw ACP transcript
or machine-bound provenance artifact for the separately supplied OpenCode
`1.18.25` run exists in this patch. Fixture digests freeze these repository
bytes; they do not prove that a provider emitted them.

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
typed SDK agent context methods directly. It retains the probe's established
summary shape, but it does not retain or recreate a competing JSON-RPC wire.
An in-memory SDK test exercises permission-request and session-update callback
routing, closes the connection, and awaits `connection.closed`.

The repository intentionally has no custom JSON-RPC or NDJSON transport tests.
Those are SDK responsibilities, not Agent Runtime policy.

The SDK's raw `ndJsonStream` line buffer does not expose production byte or
line bounds. A future production OpenCode slice must pass already bounded,
backpressured byte streams from Host Custody into the thin attachment seam.
Host Custody must own byte, line, buffer, time, process-exit, and residue bounds;
the thin attachment seam neither forks the SDK transport nor supplies those
production bounds.

The experimental probe applies local Host/OpenCode policy limits to stdout
bytes and lines, stderr, retained callback messages, request and workflow time,
and post-signal process waits. It redacts retained diagnostics and classifies
late replies and duplicate-or-unknown response identifiers without extending
the SDK wire. These limits characterize a possible custody policy only; they
are not the production Host Custody implementation or qualification evidence.

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

## Retained normalized observation

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
- production semantic deduplication and late-response policy;
- production request deadlines and diagnostic redaction;
- bounded Host Custody streams, process custody, stdout/stderr/message and
  output closure, output drain, and residue evidence around the SDK connection;
- provider acceptance, durable cancellation, and effect reconciliation;
- Runtime Security permission enforcement and durable interactions;
- native OpenCode history/status reconciliation;
- canonical output cursoring, artifact sealing, and terminal receipts;
- credentials, workspace, egress, and descendant-process controls;
- provider qualification, including exact-version and containment evidence;
- a disposable product E2E through the production composition.

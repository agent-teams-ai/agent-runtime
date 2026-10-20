---
id: runtime.architecture.architecture-program-s1
type: architecture
status: active
owner: architecture
summary: Implementation brief for reusable JSONL and Codex libraries and runtime integration with the native-owned execution client.
---

# S1: platform libraries and their first runtime consumers

This is an implementation brief for the [architecture program](agent-runtime-architecture-program-plan.md).
It plans work; it does not establish implementation, publication or product readiness.
It replaces LIB-JSONL, LIB-PROCESS, LIB-CODEX-1, LIB-CODEX-2 and the mechanism portion of ACCESS-LIB.
Reusable JSONL/Codex capabilities remain in scope. Native custody and its generic
TS client belong to the separate keeper/init team; runtime owns S1-NATIVE's port
and adapter. This supersedes the earlier runtime PROCESS-DUPLEX dependency,
without cancelling the separately approved `node-or-bun` repository work.
The other libraries and PostgreSQL conformance remain assigned to their respective slices.

## Authority and evidence baseline

Runtime facts below were read at `efd3348f361fa6af84953325af5c0d2d8677d14a` on 2026-10-19.
Paths beginning `AE` and `PA` are repository paths expanded below, not independent authorities.
Line references apply to this exact revision; implementation rechecks only inputs that have changed.

- `AE` = `packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound`.
- `AT` = `packages/contexts/agent-execution/tests/features/contained-agent-turn`.
- `PA` = `packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound`.
- `PT` = `packages/contexts/provider-access/tests/features/contained-turn-access`.
- [Runtime source at the baseline](https://github.com/agent-teams-ai/agent-runtime/tree/efd3348f361fa6af84953325af5c0d2d8677d14a).
- [Engineering Quality Standard](https://github.com/agent-teams-ai/.github/blob/3a203362c25c5ebbe6e44b745ba3f8a5eecbaad0/docs/engineering-quality-standard.md), including library-first design and deliberate evolution.
- [Consumer Module Standard](https://github.com/agent-teams-ai/get-modular/blob/3dd68a6b26f42159714a4640b613534a55c2c6aa/docs/architecture/common-assembly.md#consumer-module-standard).
- [Communication catalog](https://github.com/agent-teams-ai/get-modular/blob/3dd68a6b26f42159714a4640b613534a55c2c6aa/research/module-communication-2026-10/raw/practices/practices-catalog-v2.md), especially A1/A3/A5, B1/B3/B5, C1/C2 and E2/E3.

The runtime currently pins CMS commit `81063add7de50ffe2b91cc74bf7271b298624c21`, complete-document
SHA-256 `49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`
(`architecture/get-modular/consumer-profile.json:6-13`). Its package catalog remains Core/Assembly 0.3.0,
resources/conformance 0.1.0 (`pnpm-workspace.yaml`). These are existing pins, not the target standard.
The program's module migration owns a reviewed delta, exact new package/content pins, evidence and rejecting checks.
S1 follows that migrated profile; it never silently follows moving main or marks adoption complete on an old pin.
Feature Module Standard v1.1 is published; nesting starts only after the runtime's accepted profile/checker migration.
No observation package, store, watcher, event bus or future hooks API is a prerequisite.

## Current code and invariants

The following counts are nonblank/noncomment source lines, measured at the runtime baseline.
Generated data bytes and fixture bytes are separate. Counts are inventory, not progress percentages.

| Current file relative to AE or PA | Lines | Ownership after S1 |
| --- | ---: | --- |
| `AE/ordinary-process/node-ordinary-process.ts` | 212 | policy/error oracle for runtime native adapter; no parallel TS process custody |
| `AE/ordinary-channel/ordinary-byte-channel.ts` | 29 | runtime sealed-channel policy |
| `AE/ordinary-codex/ordinary-framing.ts` | 24 | replaced by JSONL |
| `AE/ordinary-codex/ordinary-codex-protocol.ts` | 211 | mechanism replaced; policy retained in binding |
| `AE/ordinary-codex/ordinary-codex-items.ts` | 164 | effect policy retained; lifecycle moves to library |
| `AE/ordinary-codex/ordinary-codex-provider.ts` | 150 | handshake/value policy retained |
| `AE/ordinary-codex/ordinary-codex-config.ts` | 112 | configuration and release policy retained |
| `AE/codex-app-server/codex-app-server-jsonl.ts` | 215 | permanently frozen contained copy |
| `AE/codex-app-server/codex-app-server-item-schema.ts` | 96 | permanently frozen contained copy |
| `AE/codex-app-server/generated-codex-item-schema.ts` | 2 | permanently frozen generated contained copy |
| `PA/ordinary-codex-auth-capture.ts` | 159 | Provider Access slice owns combined rewrite |
| `PA/ordinary-codex-auth-ipc.ts` | 161 | mechanism replaced in Provider Access slice |
| `PA/ordinary-codex-auth-json.ts` | 33 | strict frame decode replaced there |
| `PA/ordinary-codex-auth-protocol.ts` | 97 | Provider Access value/method policy |
| `PA/ordinary-codex-auth-contracts.ts` | 59 | Provider Access contracts |
| `PA/ordinary-codex-auth-files.ts` | 84 | Provider Access custody and sandbox policy |

Total inspected source: 1,808 lines. This includes frozen references and policy that must not move into libraries.
Ordinary framing/protocol/provider/config/items import the contained JSONL helpers; items also import the
contained item validator and generated schema (`ordinary-framing.ts:1`, `ordinary-codex-protocol.ts:1`,
`ordinary-codex-provider.ts:5`, `ordinary-codex-config.ts:6`, `ordinary-codex-items.ts:2-3`).
S1 removes those ordinary-to-contained dependencies by writing new mechanisms; it does not move the frozen files.
SSE broker decoding and whole-document configuration diagnostics remain outside JSONL scope.

| Invariant | Baseline source | Target owner |
| --- | --- | --- |
| matching dispatch claim, binding, reservation, deadline and abort before one spawn | `AE/ordinary-process/node-ordinary-process.ts:161-173` | runtime process binding |
| synchronous journal acknowledgment; throw or non-undefined return prevents spawn | same file `:98-103,170` | journal command in binding |
| no shell, explicit cwd/environment, detached current-process group | same file `:172-173` | explicit native launch spec; group detail remains old POSIX oracle |
| shared stdout/stderr 1 MiB, 262,144-byte write maximum | same file `:127-129,150-153,182-183` | runtime policy bounds + native/client enforcement under agreed contract |
| stderr fatal UTF-8 and erasure | same file `:117,182-183` | runtime decoding/secret policy over bounded native bytes |
| no signal after observed leader exit | same file `:122-125,198-203`; test `AT/ordinary-node-process.test.ts:313` | old POSIX identity oracle; native owns its actual custody proof |
| group absence only from ESRCH, never EPERM/unknown | same file `:26-29`; `PA/ordinary-codex-auth-ipc.ts:21-25` | old POSIX fact distinction; no inference from container absence |
| close retries observation after failure, memoizes success, never respawns | same file `:190-224` | mechanism plus receipt binding |
| discarded bytes or missing clean framing EOF permanently invalidate drain | same file `:205-211` | runtime receipt binding |
| strict UTF-8, decoded duplicate keys, object-only JSON, CRLF, bounded lines, no unterminated EOF | `AE/codex-app-server/codex-app-server-jsonl.ts:159-228` | JSONL |
| secret frame depth 32; frame 65,536 and combined output 262,144 bytes | `PA/ordinary-codex-auth-json.ts:8-25`; `ordinary-codex-auth-ipc.ts:46,78-88` | JSONL/process with PA settings |
| exact RPC envelopes, matching ID, no retries, queued notifications bounded at 256 | `AE/ordinary-codex/ordinary-codex-protocol.ts:39-53`; JSONL helper `:93-115` | session |
| abort before request causes zero writes | protocol `:40`; `AT/ordinary-codex.test.ts:118` | session |
| one `turn/start` even after an unknown reply | `AE/ordinary-codex/ordinary-codex-provider.ts:96-101`; `AT/ordinary-codex.test.ts:110` | binding and session ambiguity |
| turn scope, one start, systemError, terminal and item reconciliation | protocol `:56-75,135-189`; items `:88-168` | turn reducer |
| six admitted effects, workspace paths, text-only input, forbidden auxiliary effects | items `:16-23,32-47,61-77` | Agent Execution policy |
| retry intent refused, diagnostics contain rule names rather than input values | protocol `:224`; provider `:51-64` | Agent Execution policy |
| helper maximum 15 seconds, capture authority maximum 60 seconds, token erasure | `PA/ordinary-codex-auth-capture.ts:16-27,51-52,108,149-153` | Provider Access policy |

Contained-turn stays permanently frozen, including its process owners, JSONL/schema files, fixtures and tests.
Only mechanically required import edits are allowed there. S1 never schedules its deletion or future development.
The active ordinary files under the contained feature are the classified ordinary slice, not permission to edit siblings.

## Package boundaries and source shape

`@agent-teams/jsonl` and `@agent-teams/codex-app-server` are new public 0.x platform libraries in agent-runtime.
Their fixed imports are library dependencies, not extra Assembly nodes. Product process/provider capabilities
remain declared through their consumer-owned ports at the accepted composition root.
Libraries import no Agent Execution, Provider Access, Host, storage or orchestrator code.
`jsonl` has no production dependency; `codex-app-server` depends only on `jsonl`.
The native execution dependency is the native-owned keeper client, pinned with
compatible keeper/init/image artifacts after its actual delivery. No local
production process/Docker owner or generic protocol client is added here.

Exact source families below are the intended files; create only directories containing real implementation.
Each package additionally has package.json, tsconfig.json, README.md, CHANGELOG.md and LICENSE.
Feature README cards describe Purpose, Parent, Publishes, Consumes, Modules, Sub-features, Expected growth and split signals.

```text
packages/platform/jsonl/
  src/index.ts
  src/features/json-lines/
    README.md  internal.ts
    domain/json-line-error.ts
    domain/decode-json-object.ts
    domain/line-buffer.ts
    domain/encode-json-line.ts
    application/models/json-line-models.ts
    application/ports/byte-source.ts
    application/use-cases/read-json-line.ts
    composition/create-json-line-reader.ts
  tests/features/json-lines/{reader,decode,ownership}.test.ts
  tests/package/{public-surface,packed-consumer}.test.ts
packages/platform/codex-app-server/
  src/index.ts  src/protocol.ts  src/turn.ts
  src/features/codex-app-server-client/
    README.md  internal.ts
    domain/errors/{protocol-error,turn-error}.ts
    domain/envelope/classify-inbound.ts
    domain/protocol/{protocol-revision,validate-shape,decode-message}.ts
    domain/protocol/revision-0-153-4.ts
    domain/generated/projection-<digest>.ts
    domain/turn/{turn-state,item-lifecycle,reduce-turn-event}.ts
    application/models/session-models.ts
    application/ports/{byte-channel,turn-policy}.ts
    application/use-cases/{send-request,send-notification,read-inbound,initialize-session}.ts
    composition/{create-codex-session,create-turn-reducer}.ts
  protocol-sources/0.153.4/{manifest.json,schema-generation.linux.manifest.txt,...}
  scripts/generate-protocol-revision.ts
  tests/features/codex-app-server-client/{session,protocol,turn,revision}.test.ts
  tests/package/{public-surface,packed-consumer}.test.ts
```

Pure syntax/schema/state rules belong to domain; application coordinates its own function-property ports;
Node and package integrations stay in adapters or composition. Domain/application import neither contracts nor
external packages. A use-case file exports one operation `(deps, input) => result`, plus optional types.
Public package entries are curated re-exports; no deep source/dist imports and no service bags.
Use factory functions and own arrow-function properties; classes are limited to errors, stateful adapters and fakes.
Enforce 300 noncomment lines/file, 60/function, four parameters, 80/module file; no new size waivers.
The single feature can later split only at an actual ownership seam after the v1.1 profile supports nesting.
Errors expose closed codes and static `JsonLineError.is`, `CodexProtocolError.is`, `CodexTurnError.is` guards;
foreign failures are mapped at each package boundary, without arbitrary payload/cause messages.
The native owner defines its generic client error contract; the runtime adapter
maps those typed errors without importing or imposing `node-or-bun` error types.
Expected refusal/ambiguity is a discriminated outcome; broken syntax/state gives a sticky branded error.
Async runtime operations take signal last; deadline selection and effect-retry
decisions remain with the consumer, accepted deadline enforcement with native.

Resolve original Q3 now: platform root entries may expose their own feature runtime API; contexts remain contracts-only.
The current checker maps every non-root export to composition.ts (`scripts/architecture/feature-module-edges.mjs:59`).
Extend that mapping from declared curated exports to actual package exports: `.` -> index.ts,
`./protocol` -> protocol.ts, `./turn` -> turn.ts; reject undeclared paths and layer bypasses.
Tests must reject a context exporting internals, a platform deep layer import and a consumer dist import.
Do not exclude these packages from FMS. The source-policy/profile change accompanies the first library delivery.

## JSONL API and semantics

```ts
interface ByteSource {
  readonly read: (signal: AbortSignal) => Promise<Uint8Array | undefined>;
}
interface JsonLineOptions {
  readonly maxLineBytes: number;
  readonly maxMessages: number;
  readonly maxTotalBytes: number;
  readonly maxDepth: number;
  readonly emptyLines: "skip" | "reject";
  readonly eraseInput: boolean;
}
interface JsonLineReader {
  readonly read: (signal: AbortSignal) => Promise<
    { readonly kind: "message"; readonly value: JsonObject } | { readonly kind: "end" }>;
  readonly close: (signal: AbortSignal) => Promise<
    { readonly discardedBytes: number; readonly readPending: boolean }>;
}
```

Exports: `createJsonLineReader`, `decodeJsonObject`, `encodeJsonLine`, named public types and `JsonLineError`.
The explicit ByteSource makes cancellation a source obligation; no raced async iterator may leave an unowned read.
Only one read may be pending; another fails busy without consuming bytes. Abort before reading consumes nothing.
Abort/close after an acquisition settles that read, erases late input when required and never reports clean EOF.
Reader close aborts its owned pending read and waits for settlement within the caller signal; if that wait ends,
readPending remains true as explicit debt. It never closes or signals a process; the owner reconciles that debt.

Use fatal UTF-8 and object-only JSON; reject duplicate decoded keys at every depth, including escaped spellings.
Default construction in both consumers explicitly selects maxDepth 32; depth 33 fails before recursive decoding.
Reject malformed JSON, nonfinite JSON numbers, invalid bounds and an unterminated nonempty tail at EOF.
Count raw source bytes once for maxTotalBytes, including delimiters/empty lines; count admitted objects for maxMessages.
Line length counts bytes before LF, including a terminal CR; strip that CR before decoding.
AE chooses skip-empty, 262,144 bytes/line, 2,048 objects, 1 MiB total; PA chooses reject-empty and 65,536 bytes/line.
PA retains its 262,144-byte aggregate stdout/stderr cap in the process owner.
This deliberately preserves different empty-line policies instead of silently loosening PA parsing.
Raw-byte accounting tightens AE's existing compact-JSON counter; an explicit acceptance case documents that change.

Retained input and line fragments stay within the total/line limits; concatenation is linear, once per line.
Reject an over-budget source chunk before retaining it; do not copy an arbitrarily large chunk first.
Decoded data is an immutable plain-data snapshot. Safely preserve own keys such as `__proto__` without prototype mutation.
Always erase library-owned byte copies on consume/failure/close. With eraseInput, source transfers byte ownership;
zero consumed ranges even on failure, and require a producer that never reuses those ranges.
Otherwise copy retained input and never mutate caller bytes. JS strings and parsed secrets cannot be guaranteed erased.
No Node imports or Buffer in the runtime API; a packed browser-import probe verifies that boundary.
Errors contain closed codes such as `jsonl.key.duplicate`, never raw text, keys or byte excerpts.

## Native execution integration (S1-NATIVE)

The [canonical native-team contract](agent-runtime-architecture-program-plan.md#native-team-coordination-contract-native-integration)
supersedes the earlier PROCESS-DUPLEX prerequisite for this runtime. The October
19 `node-or-bun` repository approval remains historical authorization for that
separate owner; it is not an instruction to build a parallel TS custodian here.
Do not change/cancel its independent work, create a second process package, or
wrap its current run-to-completion API to impersonate keeper custody.

The external native team owns the proposed keeper/init repositories, Rust
process/Docker lifecycle, normative protocols, generic TS client, executable
artifacts and native/Docker qualification. Working repository names are not
published dependency names. Runtime imports the exact delivered client public
entrypoint; it never copies its transport implementation or wire DTO authority.
JSONL/Codex continue as independently reusable libraries over structural bytes.

Runtime owns one narrow execution/byte port and its adapter to that client.
Its semantic contract, completed jointly under NATIVE-CONTRACT, must preserve:

- One runtime-confirmed claim before executable start; private native attempt/
  request identity retained before awaiting acceptance. Lost acknowledgement
  permits query/reconciliation of that same attempt, never a second launch.
- Explicit validated command/args/environment, workspace/mounts and limits;
  immutable launch selection, no ambient environment or persisted PID as authority.
- Distinct prepared/starting/ready/proven-not-started/start-unknown/closing and
  cleanup-complete/incomplete facts. An error or timeout alone proves none of them.
- Provider-pipe write acceptance separate from transport acceptance; one bounded
  pending write, finite early-write/output buffering and honest partial/unknown
  byte facts. No blind resend after uncertain progress or disconnect.
- Separate stdout/stderr, EOF, program exit, output delivery, container absence
  and cleanup of the complete owned inventory. Runtime combines actual evidence
  with its output cursor/profile into receipts; native never mints operation truth.
- Runtime-selected deadline accepted and autonomously enforced by native,
  stdin-first stop/grace/escalation under that contract, no deadline extension
  on reconnect. Unsupported profile refuses; unavailable Docker leaves retained
  cleanup debt, not a false successful close or a weaker Node fallback.
- Native-owned identity/fencing and cleanup-only recovery; explicit runtime Host/
  deployment invocation of that recovery via the client. A disconnected TS handle
  does not free resources. Repeated safe cleanup may be native-idempotent;
  provider replay/retry decisions remain runtime-owned.

The accepted old POSIX ESRCH/EPERM, leader-exit and group-reuse cases remain
historical oracles for that adapter, not commands for keeper's container API.
The Linux+Docker profile needs its own receipt/profile successor: do not infer
`process_group_closed` from a missing container or mutate old receipts/records.
Keep source/workspace/artifact ownership in TS; mounts do not give native cleanup
permission to remove caller directories. Native owns only its acquired inventory.

Use an executable fixture of the jointly versioned client contract while native
artifacts are pending. No fixture or in-memory fake enters production selection.
The adapter's real acceptance requires pinned client/keeper/init/image artifacts
and a complete disposable integration; the external keeper lane owns the broad
process/Docker matrix. Unsupported or incompatible artifacts refuse explicitly.
Do not invent package names, exact method spellings or a universal RPC framework
before the native owner supplies that contract.

SDK process-like adaptation lives in the runtime TS facade: synchronously return
an inert handle only where a selected SDK actually requires it; bounded early
writes, start failure, cancel-before-ready and EOF/exit remain explicit. It never
TS-spawns a provider or broker and transfers custody afterward. The keeper-owned
broker executable contains runtime-owned HTTP/TLS and credential/policy behavior.
The Linux auth-helper placement/permission route is NATIVE-AUTH, not a silent
reuse of the old Darwin sandbox. No additional provider is selected by this card.

## Codex session, validation and turn API

The root exports `createCodexSession`, `initializeSession`, named contracts and `CodexProtocolError`.
`./protocol` exports revision data, `decodeNotification`, `decodeResult`, `decodeThreadItem` and named decoded types.
`./turn` exports `createTurnReducer`, `TurnPolicy`, facts/results and `CodexTurnError`.
No process acquisition, shutdown, credentials, permission decisions or runtime receipts occur in this package.

A session takes ByteSource plus `write(bytes, signal) -> WriteOutcome`, limits and a protocol revision snapshot.
It offers `request`, `notify`, `next`, `takeNotifications` and `detach`; signals are the last operation argument.
Request outcomes are result, remote_error, not_written or possibly_written. Notification outcomes preserve write ambiguity.
Request and next share one read owner; overlapping reads/requests fail busy before effect.
`detach(signal)` returns Promise<DetachFacts>; it reports unsettled read/write debt if its wait is aborted.
Request IDs are safe monotonic integers, accepted responses require exact type/value correlation; exhaustion fails closed.
AE's old string-ID transcript cases are adapted to generated IDs without weakening stale-ID/replay rejection.
Remote-error outcomes retain numeric code only; raw remote message/data do not enter diagnostics or thrown errors.

Validate JSON-RPC-shaped envelopes without jsonrpc: exactly id+result or id+error; result/error are mutually exclusive.
Server-to-client requests are refused. Notification keys are method/params plus optional nonnegative safe emittedAtMs.
Known remote-control status has the exact PA envelope/parameter shape; value policy remains in each consumer.
Unknown IDs, methods, envelopes, extra response fields and queue overflow fail the session permanently.
One request is in flight, notification order is retained with cap 256, and no read pump survives detach.
Any failure after a possibly accepted write, including timeout, EOF and wrong reply, yields possibly_written.
A valid remote error is a confirmed response but never permission to repeat an effectful request.
Initialize writes initialized only after a validated initialize result. Host value policy runs before later commands.
Detach fences new calls, cancels and awaits owned reads, erases settled retained bytes and returns in-flight/end/buffer/debt facts;
it never closes the owner channel or signals a process.

Start from the retained 0.153.4 schema source, not a hand-invented permissive validator.
The existing fixture pins tree manifest SHA-256
`60c1b926bc9720e7695c23bcc6f8cb1dd7dcfa92601dd3e9d7b9267804f28c87`
(`packages/contexts/agent-execution/tests/fixtures/protocol/codex-app-server-0.153.4/manifest.json:38`).
Retain the consumed source subset plus its complete per-file tree manifest and provenance;
implementation must obtain missing upstream files and verify each listed digest before generation.
Do not modify contained fixtures or regenerate the frozen contained validator.
The new generator is TypeScript, deterministic and offline for verification, with a --check mode.
Unsupported schema keywords or unresolved references fail generation rather than being ignored.
Support the consumed types/formats, refs, alternatives, defaults, required fields, patterns and numeric bounds;
oneOf must match exactly once and defaults must not mutate caller input.

Closed: effect item variants/deltas, sandbox/permission/approval/config shapes, Turn, initialize/thread/turn/account
responses and startup envelopes. Unknown fields/enum literals in these shapes fail before policy is called.
Open informational projections: rate-limit snapshots/windows/credits, token usage, diff/plan metadata and catalog metadata.
Open means unknown data is ignored/preserved as inert bounded data; known members remain validated.
Never let openness of an informational enum authorize a tool, process, permission or other new effect.
Binding-owned stricter value checks remain, including identifiers, retry refusal, paths and auxiliary-field constraints.
The old exact rate-limit key list at ordinary-codex-protocol.ts:198 is intentionally relaxed only for informational additions.
Test an added informational field and a mistyped known field independently.

Revision identity hashes the complete canonical normative projection, including known open-field types/constraints,
closed definitions, method sets, strictness and envelope rules. Source manifests retain separate provenance identities.
A future wire addition already accepted by an existing open projection needs no regeneration or library release.
Changing validation of a known field changes the revision; never reuse an ID by omitting its type from the hash.
All decoders/reducers accept revision explicitly, so two selected releases can coexist in different sessions.
The release registry later maps verified binary/config identity to revision; S1 selects the existing qualified revision.
A newer CLI is not qualified solely because it parses. Retained older revision removal follows accepted compatibility policy.

Turn reducer owns vendor lifecycle: one turn/started, thread/turn correlation, item uniqueness/cap 256,
active-item deltas, monotone text/output, completion consistency, terminal full/summary/notLoaded reconciliation,
systemError and post-terminal admission. It returns continue/terminal plus immutable facts.
Its only effect-decision input is a synchronous TurnPolicy with function-property admitItem/admitNotification ports.
Policy refusal identifies the consumer's static rule without copying payload values into an error.
AE owns allowed effects, workspace containment, permitted sources, null auxiliary effects, text-only input,
startup warning policy, identifiers, retry intent, emitted outputs and receipt/journal mapping.
Port every positive and negative lifecycle case; do not derive test expectations from the new reducer.

## Tests first and acceptance

Write behavioral tests before new implementation, using independently retained expectations and recorded transcripts.
Port ordinary cases to public library APIs; keep product policy assertions at their owner boundary.
Frozen contained tests remain intact and retain their historical fixtures and release evidence.

| Existing oracle at runtime baseline | New home / assertion retained |
| --- | --- |
| `AT/codex-app-server-linear-framing.test.ts:19,31,41,52,71` | JSONL reader: every byte split, fragments, aggregate chunks, CRLF and duplicate keys; originals stay frozen |
| `AT/ordinary-codex.test.ts:129,136,142,149,155,269` | JSONL reader limits/EOF, with explicit raw-byte delta case |
| `PT/ordinary-codex-auth.test.ts:54` | JSONL decode: escaped duplicate keys, UTF-8, depth 32 |
| `AT/ordinary-node-process.test.ts:21,56,78,88,103,135,247,254,270,305,313,324` | native-adapter claim/ambiguity/journal/drain assertions; physical cases owned by native conformance; old POSIX-only expectations stay scoped |
| `PT/ordinary-codex-auth.test.ts:79,89,102,171` | process cleanup/observation/abort/quota cases, then PA policy oracle in its slice |
| `AT/ordinary-codex.test.ts:84,110,118,321` | session correlation, unknown reply, zero-write abort and single owner |
| `PT/ordinary-codex-auth.test.ts:182-209` | protocol timestamp/envelope/status placement; repeated startup notice remains PA policy |
| `AT/codex-version-compatibility.test.ts:19,28` | protocol normalization and previously disallowed effects; originals stay frozen |
| `AT/ordinary-codex.test.ts:46,57,93,100,193,205,224,236,256` | turn lifecycle, ordered summary, diagnostic rules and monotone completion |
| `AT/ordinary-codex.test.ts:66,162,187,296,303` | AE policy, lifecycle, identity and sealed launch facts remain runtime tests |
| `AT/ordinary-composed.test.ts:22` | composed owner/provider/engine oracle after each relevant consumer switch |
| `PT/ordinary-codex-auth-files.test.ts` | PA custody/sandbox oracle unchanged until PA's combined rewrite |

New rejecting coverage addresses real gaps: cancelled pending reads without orphan acquisition, zeroing on every exit,
concurrent write rejection, false-return/backpressure plus abort races, partial spawn failure with retained custody,
EPERM versus ESRCH, leader exit during escalation, and a descendant holding inherited stdio open.
Protocol negatives include unknown effects/security fields, wrong known informational types, bad refs/keywords,
ambiguous oneOf, schema defaults mutating input, stale IDs and overflow after an ambiguous write.
Use the shared native contract fixture for runtime races. The native owner uses
real child/Docker fixtures for physical pipe/resource claims; runtime adds the
full pinned cross-lane integration, not a copy of the native matrix.
No provider or agent command is needed. Every acquired resource closes; tests fail on outstanding handles/debts.
Use the migrated conformance version where already adopted; do not infer leak freedom from force-exit alone.

Acceptance of each library requires a real runtime binding using it plus a disposable installed consumer probe.
Use package-local installed-consumer and surface tests if shared Foundation equivalents are not yet available;
migrate once to shared tooling when it supplies the same invariant, without blocking ready libraries.
Pack outside the workspace with no accidental root dependencies; import every public entry and reject deep paths.
Type-check positive and negative consumer probes, check curated exports, shipped files and dependency declarations.
Generator replay verifies source digests and deterministic projection bytes offline.
A real TS->keeper->init->Docker integration qualifies S1-NATIVE's physical mapping;
JSONL/protocol probes use synthetic streams and never claim physical cleanup.
Publication readiness and product execution readiness are separate results, each with its own exact inputs.

## Delivery, cutover and dependency order

Resolve original Q1: Provider Access owns one combined AUTH-FILE/REFRESH/library rewrite after S1 APIs are available.
S1 carries the PA-derived mechanism oracle, not a competing edit of PA's secret path.
The helper's Codex performs refresh; Provider Access neither writes auth.json nor issues refresh commands.
Do not migrate getAuthStatus only to delete it later. PA adopts the three mechanisms once, with its retained custody tests.

Resolve original Q2: rewrite the classified ordinary AE bindings at their current paths and keep their factories/ports.
S1 does not wait for engine port relocation. The Agent Execution slice later moves those finished bindings once,
mechanically, after it owns the new port home. The accepted PA/AE feature rewrites merge after N2 directly into
their nested target features; do not first create temporary flat features. That move is not a second rewrite
and does not reach into contained code.
This avoids the cycle library -> engine -> provider feature -> library while leaving one explicit relocation owner.

| Card | Dependency | Coherent result and rollback unit |
| --- | --- | --- |
| S1-ENTRY | program registry generator first, CI/package-registry contract and the scoped platform-entry profile successor (not full N2) | declared platform public-entry rule plus rejecting checker fixtures |
| S1-JSONL | S1-ENTRY | JSONL package and ordinary framing consumer; remove ordinary-framing.ts in this cutover |
| NATIVE-CONTRACT | runtime/native owners agree the canonical integration contract | versioned executable client fixture and exact ownership, launch/write/deadline/recovery facts |
| S1-NATIVE | NATIVE-CONTRACT; S1-ENTRY | runtime port/keeper-client adapter and selected SDK facade; actual E2E waits for pinned native artifacts; no second custodian |
| S1-CODEX-SESSION | S1-JSONL | root/protocol package plus ordinary request/shape consumer; no dual production parser |
| S1-CODEX-TURN | S1-CODEX-SESSION | reducer and AE policy switch; delete replaced ordinary protocol/lifecycle mechanism |
| PA library adoption | S1 session/protocol/turn, native contract and NATIVE-AUTH | PA's single secret-path rewrite; keeper owns helper/broker processes |

JSONL/session work proceeds while native artifacts are externally pending. Use
the structural channel and agreed fixture to develop the TS adapter; only real
native-profile activation/physical E2E waits for those artifacts. Do not select
the old Node adapter as an automatic production fallback.
Version registry/bump automation consumes the explicit protocol revision but does not block fixed-revision library delivery.
Module migration owns P7a/P7b and v1.1/N2 equivalents; S1 uses the resulting current standard rather than stale train dates.
No unrelated observation, event or plugin-lifecycle implementation enters this dependency chain.

At each cutover, switch the real consumer and remove its replaced ordinary mechanism in the same coherent delivery.
Keep factory signatures stable until their owning slice deliberately changes the contract with all consumers.
Policy wrappers remain policy; no pass-through compatibility layer survives after the consumer adopts the new API.
Update packageRoots, governed roots, feature/module edges, public exports, ordinary census, compiler projects and
CMS classification/evidence together. Frozen contained source/evidence never follows current-library generation.
Local executable identity uses filesystem-custody or the existing product port;
native image/executable identity comes through the agreed native contract. Add
no parallel Docker inspection or hashing toolkit to work around that boundary.
The accepted generator-first program step supplies the registry writer before slice cutovers; use its named write/check
commands once per coherent integration. Do not claim an unshipped generator has run. A missing/no-op enforcement command leaves adoption pending.

New packages use public ESM entries, dist types, sideEffects false, the existing runtime engine floor,
allowlisted dist/README/CHANGELOG/LICENSE files, ownerDocument and the real publication marker required by tooling.
Keep private storage-conformance private in its own slice. Add no speculative metadata keys or export aliases.
Use workspace dependency declarations under the adopted repository policy and inspect the packed rewritten ranges.
Verify current stable dependency versions, provenance and release notes when implementation adds/upgrades them;
retain exact tested versions and lock integrity rather than substituting latest or hard-coding an old target release.

Publish each proven runtime-owned library as it becomes ready; JSONL precedes
Codex. Native repositories publish their own client/artifacts; runtime records
their exact compatible identities and never republishes a local copy.
Do not wait for the entire program. Each release includes changelog, API/limits/non-goals and migration notes for a break.
Build/pack once from the merged revision, qualify those exact bytes and retain package/version, merge SHA, integrity
and tarball digest. Complete provider-required authentication through the supported publication workflow if requested.
Do not assert a rebuilt tarball is byte-identical without comparison or republish after an uncertain outcome.
Rollback a consumer switch by its coherent code/dependency change while retaining published immutable versions.
Before rollback of an effectful in-flight session, drain or reconcile under its existing owner; never replay a turn.

## Minimum checks and estimated budget

During implementation, run touched-package typecheck/tests plus `pnpm check:changed` for the changed source delta.
After a public-entry checker change, run its focused rejecting fixtures; after pin/profile changes run their actual
CMS/FMS enforcement. A protocol change runs protocol/reducer tests; a binding-only change runs binding/composed tests.
Before handoff run repository-required `pnpm check:fast`; before opening/merging a PR run authoritative `pnpm check`
in the supported execution environment and retain the required exact-head CI evidence.
Current AGENTS.md requires these gates; the older draft's CI-only full-gate shortcut is not authoritative.
Any future reduction belongs to the program's explicit CI-contract migration, not to an informal S1 exception.
A review correction reruns affected tests and invalidated checks; do not repeat already valid checks on unchanged inputs.

One registry/pin update per coherent delivery replaces hand edits after every moved file.
Historical fixtures remain bound to their historical sourceRevision, not current library bytes.
Protocol revision hashes avoid release churn for already-admitted informational additions without weakening effect checks.
Target about 2,000 authored changed lines per PR; split at API/consumer seams, never between ownership and cleanup proof.
A required coherent overrun records its reason; no three-PR quota forces a broken invariant.

Estimates below are planning ranges, not measured work or delivery promises. Source/test inventory is their basis;
the former duplex dependency has now been replaced by externally owned native
integration. These historical ranges are not a fresh budget for keeper/init or
the new runtime adapter; re-estimate S1-NATIVE after the joint contract is fixed.

| Work owner | New production/tooling lines | Test lines | Deleted ordinary lines | Docs/registry lines | Estimated agent-days |
| --- | ---: | ---: | ---: | ---: | ---: |
| S1 JSONL + first consumer | 400-600 | 450-650 | 40-100 | 180-300 | 2-4 |
| S1 session/protocol/generator | 800-1,200 | 650-950 | 220-350 | 180-300 | 4-6 |
| S1 turn + AE bindings | 550-850 | 500-800 | 280-450 | 120-220 | 3-5 |
| former S1 process binding (historical, superseded) | 150-300 | 150-300 | 120-220 | 80-160 | 1-3 |
| former PROCESS-DUPLEX dependency (external historical estimate) | 550-900 | 650-1,000 | 0-100 | 120-220 | 4-7 |
| PA combined adoption, charged to PA | 180-300 | 100-200 | 250-400 | 50-100 | 1-3 |

Historical S1-owned total estimate: 1,900-2,950 production/tooling, 1,750-2,700 tests, 660-1,120 deletions,
560-980 docs/registry lines and 10-18 agent-days. External process and PA estimates are not double-counted.
Retained schema archives/generated data are reported separately by bytes at implementation.
The remaining native dependencies are the agreed client/launch/recovery contract,
Linux helper/profile permissions and actual compatible artifacts/E2E. Native
implementation remains external; its absence blocks only the dependent cutover.

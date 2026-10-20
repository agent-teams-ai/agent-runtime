---
id: runtime.architecture.architecture-program-s3-s5
type: architecture
status: active
owner: architecture
summary: Implementation brief for access, security, execution and Host cutovers in architecture program version 3.
---

# S3-S5: capability features, release selection and the Host

Version 3 implementation brief, updated 2026-10-20. Read the
[program plan](agent-runtime-architecture-program-plan.md), [S1](agent-runtime-architecture-program-s1-libraries.md)
and [S2](agent-runtime-architecture-program-s2-operations-storage.md) for their
contracts. This is planned behavior, not an implementation or qualification claim.

## 1. Scope and settled choices

S3 rewrites Runtime Security and Provider Access; S4 rewrites the ordinary
execution bindings; S5 supplies release selection, verified storage composition
and the public operations Host. Existing contained implementations keep their
files, tables and tests. Ordinary consumers stop importing the replaced
contained-only code. Preserve their behavior through the mapped oracles.

These choices were selected in the October 15 synthesis and accepted with the
rewrite approach on October 16: capability feature names, verified storage object
without Host pool/TODO, Provider Access-owned shared materialization, dedicated
ordinary schemas, one combined auth/library rewrite, PA/AE directly nested after
N2. Generator-first, meaningful tests and coherent PRs are accepted reductions.
They are not open questions again.

Additional technical defaults: curated Host exports `.` and `./host`, internal
contained composition stays compiled; ordinary grants use S2 adapters; release
selection is built ahead of its consumers; creation-time snapshots and typed
command ports remain direct. OBS-ADOPT supplies the separately selected live
summary view, not reactive authority or configuration replacement. Use accepted ADR successors where
these choices change a frozen architectural contract, never edit accepted bytes.

## 2. Source baseline and semantic ownership

All runtime paths below refer to main
`efd3348f361fa6af84953325af5c0d2d8677d14a`. The package source tree is identical
to the October 15 research baseline `2fda5ffd7`. Counts from that research are
inventory estimates, not a new measurement or an acceptance formula.

| Current boundary | Files that define the reference behavior | Target |
| --- | --- | --- |
| Provider Access `contained-turn-access` | `composition/ordinary-provider-access-owner.ts`, `domain/ordinary-provider-access.ts`, `application/ports/outbound/ordinary-pa-grant-store.ts`, `adapters/outbound/ordinary-codex-auth-*.ts`, `ordinary-pa-{broker,secret-guard,upstream,materialization-stores}.ts` | `operation-access`; Postgres grants move to S2 |
| Shared Provider Access materialization | `composition/postgres-credential-rendering-owner.ts`, `materialization-authorization-v1-factory.ts`, materialization registry/tables | Same Provider Access owner/factory, permanent typed adapter |
| Runtime Security `contained-turn-dispatch-authority` | `application/ordinary-security-owner.ts`, `domain/ordinary-security-policy.ts`, grant port and Postgres adapters | `operation-security`; Postgres IO moves to S2 |
| Agent Execution `contained-agent-turn` | ordinary Codex/process/channel/filesystem adapters; engine and model are S2 | `operation-execution` with four sub-features |
| Embedded Runtime Host | `src/composition/agent-runtime-host.ts`, `agent-runtime-host-disposal.ts`, `runtime-setup-assembly.ts`, `features/ordinary-session-runtime` | New ordinary/passive Host, existing contained Host stays |
| Public access | `features/contained-turn-runtime-access/contracts/runtime-access.ts`, access/validation composition | `runtime-host` with private operations sub-feature |

The original approximate closure counted 4,454 Provider Access lines (including
3,024 shared materialization lines), 473 Runtime Security lines and 1,119
execution-binding lines. Do not rewrite shared materialization merely because its
directory name says contained. Shared-source reuse is not permission to change
its schema or contained authority.

## 3. Target boundaries and layout

### S3-SECURITY: operation-security

Under `packages/contexts/runtime-security/src/features/operation-security/`:

```text
README.md, index.ts, internal.ts
contracts/{operation-security,operation-security-errors}.ts
domain/{security-policy,security-grant-record,secret-admission,exact-record}.ts
application/ports/{security-grant-store,security-environment}.ts
application/use-cases/{consume-security-grant,settle-security-grant,observe-security-grant}.ts
adapters/inbound/operation-security-owner.ts
composition/create-operation-security.ts
```

The S2 store implements the owner-local persistence port. Domain decisions use
explicit time/IDs and no SQL. The public owner exposes narrow function-typed
consume, observe, admission and close operations. A stateful adapter may retain
its per-operation admission inventory; another feature never gets its mutable
state or prototype methods.

Recorded-grant rule (decision 29): decode validates provider, mode, profile
revision, effect class and tenant/project/operation identity. TTL and byte limits
come from that recorded grant for admission/settlement. A later Host policy
change does not make an open grant unreadable. S2 owns persisted v1 conversion,
digests and schema verification; this feature does not promise v0 byte identity
after the single S2 cutover.

### S3-ACCESS: operation-access

After the N2 profile/checker adoption, under
`packages/contexts/provider-access/src/features/operation-access/`:

```text
README.md, index.ts, internal.ts
contracts/{operation-access,operation-access-errors}.ts
domain/{grant-binding,grant-decisions,broker-request,secret-inventory}.ts
application/ports/{grant-store,credential-materialization,credential-capture,credential-broker,access-environment}.ts
application/use-cases/{consume-operation-grant,materialize-operation-grant,retire-operation-grant,settle-operation-grant}.ts
adapters/inbound/operation-access-owner.ts
adapters/outbound/shared-materialization.ts
composition/{operation-access.contracts,operation-access.declaration,operation-access.module,operation-access.group}.ts
features/codex-auth-capture/
  contracts/{codex-auth-capture,codex-auth-errors}.ts
  domain/{auth-file-scanner,auth-file-rules,token-expiry,helper-profile,helper-config-rules}.ts
  application/ports/{custody-files,helper-process,helper-session}.ts
  application/use-cases/capture-codex-credentials.ts
  adapters/inbound/codex-auth-capture.ts
  adapters/outbound/{node-custody-files,codex-helper-process,codex-helper-session}.ts
  composition/...
features/codex-broker/
  contracts/codex-broker.ts
  domain/{request-admission,response-admission}.ts
  application/ports/upstream.ts
  application/use-cases/forward-broker-request.ts
  adapters/inbound/loopback-broker-server.ts
  adapters/outbound/codex-responses-upstream.ts
  composition/...
```

Each real sub-feature also has its card, public/internal surfaces and mirrored
tests. Only composition imports Get Modular descriptors. Declaring a feature
factory does not automatically add an Assembly node: retain the accepted
capability graph and create module files only for existing independent entries.
A cohesive capture/broker helper may use a static typed factory without an
invented slot or identity. Never fill `composition/...` with empty declarations.

Grant/request persistence belongs to S2. The Provider Access-owned shared
materialization adapter maps its existing factory to the new consumer-owned
port. S2 storage composition builds that facade over the same borrowed pool and
passes it to the new access owner. Host receives ports, not that pool. This is a
permanent ownership adapter, not a TODO to remove contained. No duplicate table
registry, migration implementation or secret-rendering policy.

The access owner remains responsible for capture admission, the one-use binding,
retirement and settlement. Limits remain bounded: at most 64 grants/pending
captures and 64 broker requests, one request in flight, no new request after
retirement, settlement or a failed admission. Lifetimes remain at most 60 seconds;
helper budget remains 15 seconds within that authority. Recheck current constants
when implementing, without increasing them as a convenience.

### S4-EXECUTION: operation-execution

After N2, under `packages/contexts/agent-execution/src/features/operation-execution/`:

```text
README.md, index.ts, internal.ts
contracts/{execution-observation,execution-files}.ts
adapters/inbound/engine-ports.ts
adapters/outbound/node-execution-files.ts
composition/create-operation-execution.ts
features/codex-binding/
  contracts/codex-binding.ts
  domain/{launch-config,effective-config-rules,session-rules,strictness-table,effect-admission}.ts
  application/ports/{codex-session,executable-verifier,launch-files}.ts
  application/use-cases/{prepare-codex-launch,execute-codex-turn}.ts
  adapters/outbound/node-launch-files.ts
features/process-binding/
  domain/{claim-gate,process-receipts}.ts
  application/ports/process-handle.ts
  application/use-cases/{reserve-process,start-process,close-process}.ts
  adapters/outbound/keeper-execution-handle.ts
features/workspace/
  domain/workspace-rules.ts
  application/use-cases/{prepare-workspace,snapshot-workspace,close-workspace}.ts
features/artifacts/
  domain/artifact-manifest.ts
  application/use-cases/{publish-artifact,read-artifact}.ts
```

The native team owns process/container/stdio custody, its protocol/client and
autonomous deadline/cleanup machinery; S1-NATIVE adapts its client, and S1 still
owns JSONL/session libraries. S4 owns matching claim, start authority, permitted
deadline selection, config/effective-config, sealed channel/launch facts,
effect/path admission and truthful owner-evaluated receipts. It does not repeat
native Docker calls, process signalling, timeout supervision or resource journals.
S2 owns state transitions and the workspace cleanup-only port. Libraries do not
import the engine, Host, grants or recovery policy. The engine package enters
only through inbound/composition adapters, not feature domain/application.

Runtime allocates its bounded session/decoder buffers on actual start, not
reservation; native owns the process queues and physical enforcement. Preserve
combined output bounds, strict decoding and one start. Old POSIX leader/group
cases remain reference oracles, not a new TS signal/probe implementation. Never
infer complete native inventory cleanup from a timeout, EOF or absent container.
Workspace/artifact logic preserves non-overlap, source
mutation detection, content-addressed readback and ownership of retained paths.
An unconfirmed cleanup produces debt and retains custody; it never frees bytes
only in memory and claims deletion.

### Native coordination for access, execution and SDKs

Use the [canonical coordination contract](agent-runtime-architecture-program-plan.md#native-team-coordination-contract-native-integration)
for the client boundary, errors, launch identity, deadlines, writes and recovery.
The runtime execution port stays in application vocabulary; only its outer
adapter imports the native client. The generic client/protocol and Rust binaries
are external deliveries, not packages to recreate inside Agent Runtime.

S3 owns the provider broker's HTTP/TLS/credential semantics and executable.
Keeper launches/owns that executable from the first process effect, including
stop/wait; do not TS-spawn and hand it over later. A broker exit or closed socket
does not prove remote provider cancellation. Keep PA/RS policies and provider
reconciliation in TS. Runtime owns workspace/artifact content; native mounts and
cleanup cover only explicitly acquired resources and never grant recursive
deletion of a caller's source directory.

NATIVE-AUTH fixes the helper's location, exact credential route/file rights and
supported Linux sandbox with PA/native owners. Existing Darwin capture rules
below are behavioral/security oracles, not proof that the same paths or sandbox
work in Linux+Docker. Preserve their authority/secret/refresh limits; qualify the
new placement with its scoped successor before any native provider activation.

Where a selected SDK requires a synchronous process-like return value, implement
one TS facade over async native launch: inert handle, finite early writes,
ready/failure, cancel-before-ready, stdout/stderr and distinct exit/EOF. A write
accepted by transport is not necessarily written to the provider pipe. No retry
after unknown bytes and no independent TS custodian. Add only the selected SDK;
native generality does not authorize a new Claude execution rewrite.

The Host integration owner invokes the native client's startup/cleanup-recovery
path and retains incomplete custody; deployment startup owns invocation when no
Host exists. Native recovery never restarts a provider/turn. Fixture integration,
real Rust contract conformance and full Docker E2E are separate acceptance facts.
Native owns the broad physical matrix; runtime verifies policy mapping and one
complete pinned chain, including unrelated-resource preservation.

### S5-RELEASE: build before consumer cutovers

Under `packages/apps/embedded-runtime/src/features/codex-releases/`:

```text
contracts/codex-release.ts
domain/releases/codex-0-153-4-darwin-arm64.ts
domain/releases/native-linux-docker.ts
domain/release-registry.ts
application/ports/executable-digest.ts
application/use-cases/select-codex-release.ts
adapters/outbound/node-executable-digest.ts
composition/select-release.ts
```

The code-owned registry selects current/previous verified release by actual
binary SHA, never a caller's claimed digest/version. It holds CLI/platform/binary
identity, protocol revision, model, effective-config expectations, disabled-feature
set and startup-warning policy. Retained local-binary paths hash at Host creation
and recheck identity/bytes at launch/capture. For native execution, the client
contract binds observed image/executable identities and native validates them
before provider start; runtime selects/adopts the trusted release policy without
adding its own Docker inspection/exec path. Unknown identity refuses before
provider effects. A single verified record is allowed initially; do not invent a
previous release or silently bump the qualified 0.153.4 tuple. The Darwin record
is retained reference, not a default for native execution. The new Linux+Docker
target pins provider binary/protocol/profile plus native client/keeper/init and
image/artifact identities. A fixture or the frozen contained tuple qualifies
none of that new tuple; no weaker Node/Darwin fallback on incompatibility.

Pass each consumer only its narrow structurally compatible slice: launch config,
helper config or broker headers. One record provides the currently divergent
13/11 feature deny lists; the helper validates any newly added restrictions.
S2 pins the selected release in preparation/claim identity. Replacing the Host
selects a new record; a running operation retains its recorded selection.

Stable held-file identity/digest is an existing filesystem-custody concern.
Evaluate a narrow shared helper there for the actual three callers; do not put
file custody in `node-or-bun` or create another general file toolkit. Until a
shared API is proven, keep the Host's explicit executable-digest port and a
small adapter, not multiple independently evolving verification policies.

### S5-STORAGE and S5-API

Under `packages/apps/embedded-runtime/src/features/runtime-host/`:

```text
contracts/{agent-runtime-host,runtime-access-handle,host-errors}.ts
application/ports/{setup-queries,operations-port,scope-copiers}.ts
application/use-cases/{bind-runtime-access,dispose-runtime-host}.ts
adapters/inbound/runtime-host.ts
features/operations/
  contracts/operations.ts
  domain/{operation-input,operation-view,operation-outcome}.ts
  application/ports/operation-engine.ts
  application/use-cases/{submit-operation,observe-operation,cancel-operation}.ts
  application/policies/submission-join.ts
```

Host composition receives S2's verified storage object and borrowed owner ports.
It runs verification only, never migrations, `CREATE TABLE` or pool shutdown.
Do not duplicate S2-STORAGE activation/fencing in a second Host cutover: wire the
store, owners and binding contract changes in the one dependency-coherent
checkpoint described by S2. S5-STORAGE is its Host responsibility, not another
mandatory PR. Keep fresh/empty-data activation distinct from populated-legacy
migration. Construction failure retains cleanup recovery and typed failure phase.

New ordinary/passive Host code must not rewrite the frozen contained Host's
ledger or cancellation proof. It keeps call admission, exact replay joining,
in-flight call tracking and bounded disposal. Engine close handles owned flights;
the Host closes owners before journal. Disposal retries join existing drain,
report incompleteness and retain recovery; abandonment does not report release.
Preserve `dispose`/`Symbol.asyncDispose` on the public Host if its existing
contract requires them; narrow owner `close()` ports return facts.

"New Host" means its new ordinary/passive composition and facade under this
feature, not a whole-runtime Rust port or a demand to throw away useful code.
The [main plan's reuse/platform map](agent-runtime-architecture-program-plan.md#host-implementation-reuse-and-platform-evidence)
fixes that boundary. The existing ordinary constructor is real: it supplies
seven owner dependencies, lazy auth, tenant/project binding and retained cleanup.
Replace its constructor DDL/raw pool, old access projection and contained-ledger
coupling together with S2/S5. Retain generic helpers only when their independent
contract still holds; shared materialization and native custody keep their owners.
Do not first move the old Host and then rewrite it, or introduce a second
production root as a fallback. The October 20 handoff supersedes the old native
integration deferral: the separate team delivers keeper/init/client/artifacts;
this runtime implements only its port/adapter and product integration.

Before switching the Host binding, preserve these existing independent oracles:

- `ordinary-runtime-assembly.test.ts`: seven-port binding table, missing/swapped
  binding rejection before owner construction, public Host lazy auth and no
  borrowed pool shutdown. Replace the positive constructor-migration assertion
  with S2/S5's verify-only/no-DDL assertion; do not preserve obsolete behavior.
- `ordinary-host-disposal.test.ts` and its ownership fixtures: pending/failed
  capture custody, retained cleanup recovery, independent owner retries and the
  journal staying writable until owners actually close.
- Existing private access tests: same-scope binding, exact replay joining,
  cancellation and uncertain acceptance. Adapt API calls to `operations` once;
  preserve the separate frozen contained expectations.

These tests establish synthetic integration and physical boundary facts only
where actually exercised. Existing ordinary adapters' Darwin/non-root plus
arm64 auth limits remain historical facts. The selected native Linux+Docker
profile requires separate authority/credential/receipt acceptance and real
native E2E, not relabelled old tests. No Windows support or automatic TS fallback.

| Public entrypoint | Target |
| --- | --- |
| `.` | Public access/operation/setup types only, provider-neutral view |
| `./host` | Ordinary and explicit passive constructors, Host options/types/errors, trusted scope |
| `./composition` | Removed from npm export map at the API cutover; internal source/dist remains for frozen contained tests |

Rename the ordinary member `containedTurn` to `operations`. Use a separate mapper
for the ordinary engine; the frozen contained mapper remains for its Host.
Submit/observe/cancel outcome unions keep all existing members/codes, including
`potential_acceptance`: it never grants retry or dispatch ownership. Public
operation views remove Codex profile/version literals. Setup query/view types
move once into their active owner; keep a frozen contained copy where necessary.
Scope checks still require the Host tenant/project to match the bound handle.

### OBS-ADOPT: live operation summary

Deliver with S5-API, after the scoped CMS/package adoption and N2. This is the
selected new continuous inspection capability from the main plan, not a rewrite
of existing durable `observe` or `onAccepted`. Add `watchSummary` to the bound
`operations` facade and its scoped public-contract successor. It returns either
a last-confirmed initial summary and an inert owned subscription handle, or a
typed refusal. A valid but historical/nonlocal operation returns `not_live_here`;
keep authorization failure distinct and avoid existence disclosure across scopes.
Callers can always use authorized durable `observe` for the final truth.
Use existing invalid-input, authorization and Host-closed facade refusals;
the new capacity refusal is `reader_limit`. Do not collapse those outcomes into
`not_live_here`. The initial summary and subscription handle appear together
only on successful admission. `start()` returns `started`, `already_started` or
`closed`; all results are synchronous and no callback runs inline.

The Agent Execution producer publishes only confirmed ordinary identity/revision/
status. Its one writer ignores lower durable revisions, treats an equal revision
with equal data as a no-op and reports conflicting data at an equal revision
without overwriting. Late acknowledgements cannot regress a newer/terminal view.
Prepare one subscriber template whose declared facet input satisfies the reader's
required slot. Each authorized subscription reserves its own child run before
the first await and supplies only its exact facet through `run({ inputs })`.
After a successful run and final admission check, expose its public facade.
Close failed/cancelled runs after they settle; the source outlives the runs.
No singleton slot rebinding, closure-captured run inputs or broad facet registry.
Track the reader through reserved/constructing, inert, started, closing and
closed states. Terminal operation completion, Host close or caller abort during
construction first fences facade publication/activation and aborts the run; then
await run settlement and close its child scope. Keep the producer alive until
all constructing and active readers finish that cleanup. An uncooperative run
retains its producer/cleanup debt; a timeout does not free either reference.
All Get Modular/resource handling stays in composition; domain/application code
receives plain owner types and ports. No public `Resources` or raw facet, no
central store containing many tenants, and no hidden global lookup. A live-owner
index, if needed, belongs to this Host instance and its existing admission bounds.
Do not retain completed-operation stores, scopes or listeners indefinitely.
The diagnostic/error sink is a declared per-Host run input or outer-root port,
available before factories and retained through their cleanup. It is not a
capability produced by runtime-host: that would make AE and its Host cyclic.
Only the outer adapter sees raw framework causes and emits safe allowlisted
fields through the non-throwing sink.

Registration and initial-summary acquisition form one owned operation. The run
retains its authentic snapshot across awaits but attaches `watch` only when the
caller invokes the returned handle's synchronous, idempotent `start()` after
applying the initial summary. No callback before that activation or synchronously
inside it; catch up newer revisions through the shared package, not a new queue.
If authority/call admission closes during acquisition or before activation,
release the child scope and return the typed refusal/closed result rather than
activating. Closing the public handle or its supplied abort signal
detaches its scope without cancelling the operation. Callback errors go to the
non-throwing sanitized Host error port and do not change command outcomes.
The public callback is passive, synchronous and idempotent inspection. It runs
in Observation's delivery context and must not issue a feedback command that
changes the summary it follows. Do not add a timer/trampoline to evade that
guard; status-driven business automation would need its own explicitly selected
owner/command contract and cannot rely on every update being delivered.
Delivery is deferred/coalesced; the API promises neither all transitions nor a
terminal callback when close wins. Output still uses the cursor-based contract.
Cap reserved plus active readers at 64 per Host in the first delivery; reject
excess before acquisition. The existing direct flight-completion path closes
readers before source disposal, even if no terminal callback ran. The public
`closed` outcome concerns the subscription lane, not completion of process work.
No unbounded terminal store or inactive-handle retention beyond that owned bound.
An inert returned handle consumes a reader slot until explicit close, caller
abort, terminal completion or Host closure. Close installs a synchronous delivery
fence before waiting: no callback begins after that fence, while an already
running synchronous callback may return. Repeated close joins the same cleanup
and reports typed complete/incomplete facts; incomplete cleanup remains owned
and retryable without rerunning construction. A closed delivery lane alone does
not release a source still borrowed by unsettled reader construction/cleanup.

Minimal meaningful consumer qualification:

| Risk | Passing/rejecting case |
| --- | --- |
| Initial-read race | Change during awaited construction catches up from the original snapshot after `start`; no callback precedes initial seed/activation, and admission closing during the await refuses |
| Reversed acknowledgements | Publish durable revision 3 then late 2: keep 3; identical 3 is a no-op, conflicting 3 reports integrity failure without overwriting |
| False authority | Commit-unknown, stale summary and missing notification never authorize dispatch, settlement or an automatic retry |
| Lossy delivery misused | Burst updates may coalesce; two journal/output occurrences remain two acknowledged occurrences; final durable query works even if close prevented terminal callback |
| Lifetime leak | Two subscribers are independent; closing one stops its callbacks; terminal direct cleanup and Host close free readers; the 65th reserved/active reader refuses, and all involved store subscription counts return to zero |
| Close while constructing | Abort/terminal/Host close before run settlement publishes no handle/callback, keeps the producer alive through cleanup and retains debt after an uncooperative run; an inert handle consumes capacity until one of its close paths |
| Scope/data leak | Wrong tenant/project/operation refuses before facet acquisition; neither summary values nor sanitized reports contain credentials, output or raw causes |
| Failure coupling | A throwing subscriber does not block its sibling or cancel execution; preserve new-owned/duplicate `onAccepted` behavior and existing journal-failure assertions |
| Wiring/type misuse | Independent producer/consumer oracle plus wrong-binding and production `/testing` import rejection; public declaration imports require no Observation/resources types |

Use actual `delivered`/`settled` waits scoped to the stores in test code and the
existing disposal checks, not arbitrary ticks or production global-flush waits.
No `load` or `many()` is required for this single producer/consumer. A later
replaceable inspection query may use `load` only under the main plan's physical
completion/currentness contract. Events, dynamic registries and config reload
remain outside this slice.

## 4. Credential capture and refresh: retained policy and native prerequisite

Implement auth-file reading, refresh handling and library integration together,
after their scoped ADR-0090 successor. Preserve decision 47's authority and
secret/refresh limits through the selected mechanism.

The following is the retained Darwin-policy oracle. NATIVE-AUTH must select and
qualify its native helper placement/credential permissions for Linux+Docker;
neither a bind mount nor running under init automatically preserves that sandbox.
Helper process custody belongs to native, with capture and refresh policy in PA.

1. Open the already custodied source and validate the pinned release's exact
   ChatGPT auth grammar before spawning. Read `tokens.access_token` with a bounded
   byte scanner; `id_token`, `refresh_token` and `OPENAI_API_KEY` never become
   JavaScript strings. Validate field names without copying secret ranges.
   Unknown members, escaped/non-ASCII secret strings, wrong mode, missing
   `last_refresh`, oversize token/file and non-null forbidden credential variants
   refuse. Retain the accepted absent-auth_mode parity rule; a non-null serialized
   OPENAI_API_KEY alone is not proof of API-key mode.
2. Keep 65,536-byte file and existing 4,096-byte access-token limits. Check integer
   token expiry before helper spawn; the file grammar and decoded JWT expiry
   parser are separate bounded parsers, not one fictitious JSON grammar.
3. The helper receives only data-write permission for the exact held `auth.json`;
   create/unlink/rename/chmod and other source writes stay denied. Provider Access
   never writes the file or asks a token endpoint to refresh.
4. Admitted calls: initialize, config/read, account/read, account/rateLimits/read,
   model/list, final account/read. No getAuthStatus, no explicit refresh request.
   Verify file auth store/effective config and account identity before and after.
5. Re-read through the held handle, preserving dev/ino/uid/mode/nlink identity;
   allow size/time changes from Codex's own in-place refresh. Bounded truncated
   observation gets one re-read. A second truncation is a refusal, not a loop.
6. Deadline/abort closes stdin and gives the helper at most five seconds within
   the overall capture budget before TERM/KILL. Never signal an observed-exited
   leader/group. Do not report cleanup until observed facts justify it.
7. An unchanged token whose expiry is at most helper-spawn plus five minutes
   refuses as `refresh_not_applied`. A retryable observation classification is
   not permission to replay an uncertain provider request. The normal UX may
   suggest signing in when this refusal repeats; no automatic login loop.
8. Zero secret buffers in finally; diagnostic/journal fields carry static reason
   codes and non-secret identities only. Broker secret inventory is registered
   synchronously before dispatch and checked cumulatively across streamed text.

Retain the known shared-login race and interruption risk in the successor and
user-visible recovery guidance. This plan does not claim a cross-process refresh
lock or remove that race by an in-process mutex.

## 5. Oracles and focused verification

Port assertions before implementing each replacement. Rename paths/call shapes
as needed; do not rewrite expected outcomes from the new implementation.

| Current tests | Target and specific acceptance |
| --- | --- |
| Runtime Security `ordinary-security-policy`, `-grant-owner`, `-grant-store`, `-transactions`, `-postgres` | mirrored `tests/features/operation-security`; changed Host limits keep recorded grants readable, wrong identity rejects |
| Provider Access `ordinary-pa-grant-decisions`, `-owner-port`, `-owner-disposal`, `-owner-races`, `-broker`, `-postgres` | mirrored `operation-access`/broker; retire vs begin race, failed insert never repeats, upstream begins only after durable admission |
| Provider Access `ordinary-codex-auth`, `ordinary-codex-auth-files` | mirrored capture; complete bounded parser/custody/refresh cases from section 4 |
| Agent Execution `ordinary-codex`, `ordinary-node-process`, `ordinary-filesystem`, `ordinary-composed` | protocol goes to S1; native physical cases belong to keeper conformance; runtime claim/ambiguity/effect/workspace/artifact mapping remains under S4 |
| Embedded Runtime `ordinary-runtime-assembly`, `ordinary-host-disposal`, creation/disposal fixtures | new Host tests; storage verify-only/no pool end, construction cleanup retained, owners before journal |
| Shared access-layer ordinary behavior in contained-turn E2E/disposal/uncertainty cases | new operations tests: exact replay joins, conflicting replay rejects, late acceptance, scope bounds, abort and uncertain acceptance |
| `public-api`, `assembly-packed-consumer`, trusted-runtime-access-scope cases | runtime and type import success through ./host, no public composition/deep paths, outcome union parity |

Frozen contained hostile-custody/cancellation-proof tests and shared
materialization tests remain at their existing paths. Disabling contained-only
CI work requires proving the ordinary/shared suite still runs; never delete the
tests to improve timing or coverage numbers.

New tests concentrate on actual risk: unknown binary has zero owner construction;
record drives both config generation/verification; changed grant limits retain
settlement semantics; actual sandbox helper can update only file data; unknown
commit does not start; cleanup debt does not disappear. Use disposable synthetic
files/processes/token authority/Postgres, never real user projects or credentials.
The real pinned-binary refresh proof stays a separately authorized TEST run;
mocked helper or compilation never replaces its evidence.

Use the package's current test script and `pnpm check:changed` during edits.
Run docs-protocol checks for decision/index changes; full fast/final checks and
the expected current CI roster follow the program execution brief. Changed
Postgres/macOS sandbox behavior needs those actual platform checks. A static
source assertion or a test of only a mock cannot qualify physical cleanup.

## 6. Cutover and ownership

One integrator owns Host/public barrels, profiles, lockfile and workflow edits.
Workers own the new feature implementation and mirrored tests. Use the registry
generator once for a coherent checkpoint, review output and prune removed active
baseline entries. Decision scope, source dependency roots and test ownership
follow the same checkpoint; no separate registry-only half-delivery.

| Checkpoint | Switch and retained boundary |
| --- | --- |
| Security | Security factory uses new owner/recorded-policy rules with S2 store; old active-only ordinary owner code removed |
| Access | New owner, capture and broker together on S1 mechanisms and S2 grant port; shared materialization retained as one PA adapter |
| Execution | New nested bindings implement S2 ports; delete replaced active ordinary bindings, leave frozen contained implementations |
| Release | Select verified record before consumers; replace remaining active version literals and recheck binary per use |
| Storage | S2's single activation with new owners/ports and legacy-writer fence; no second Host/data migration |
| API | New ordinary/passive Host, `operations`, curated exports and package consumer tests together |

PA and AE wait for N2 and land nested directly. Security needs no nesting and can
land after its owner/store contracts plus P7b. S5 release data can be developed
earlier and must precede consumers needing it; do not keep the old circular
S3-access -> release -> S3-access order. API cutover follows actual owner/binding
readiness, not the end of unrelated release tooling work.

Do not promise new module IDs, slots or roots merely from these file trees.
Preserve immutable existing IDs and update the current oracle only for actual
semantic wiring changes. P7b owns the root/module transition; its evidence must
check structure/ownership instead of hard-coding a replaceable Host function
name. Any required follow-up is in this checkpoint, not waived evidence.

## 7. Publication and estimates

The release route publishes dependency-complete packages topologically. Host,
Agent Execution, Provider Access and Runtime Security publish after their
operations/public-surface readiness. A store importing a public owner facade
waits for that actual owner version, rather than publishing broken workspace
references. S1 and a dependency-free engine can release earlier. Private
conformance/test support never enters a runtime dependency or tarball.

The original S3-S5 research estimated 3,990-5,400 new production lines,
3,700-5,200 test lines and 1,130-2,070 registry/decision lines, confidence 4/10.
These are historical gross ranges before the accepted test/registry reductions,
not measured changed LOC or a fixed calendar. S2 owns duplicated store/Host
cutover effort; do not count it again here. Split only at useful independently
valid checkpoints, with the roughly 2,000-line review budget as guidance.

No architecture question is intentionally left unanswered in this brief.
Remaining prerequisites are named deliveries (S1 mechanisms, S2 storage,
P7b/N2, scoped accepted successors and platform qualification), not research
stubs, a request to rewrite the plan again or permission to weaken invariants.

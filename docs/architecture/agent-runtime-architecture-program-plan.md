---
id: runtime.architecture.architecture-program-plan
type: architecture
status: active
owner: architecture
summary: Owner decisions, target architecture, lanes, task cards and parallel waves for the Codex boundaries, libraries and storage program.
---

# Agent Runtime Architecture Program Plan

Version 3, updated 2026-10-20. Replaces version 2 as the implementation plan; the
historical decisions and critique remain in the [decisions log](../../research/architecture-critique-2026-10/round2/decisions-log-2026-10-02.md).
The accepted rewrite direction of October 15-16 and the technical selections
below supersede the v2 move-first sequence. This document plans implementation;
it does not itself change accepted ADRs, package pins, production qualification
or authorize live provider runs. This delivery changes documentation only.

Read this index, the [execution brief](agent-runtime-architecture-program-execution-brief.md),
then the one slice brief assigned to the executor:

- [S1: libraries](agent-runtime-architecture-program-s1-libraries.md).
- [S2: operations and storage](agent-runtime-architecture-program-s2-operations-storage.md).
- [S3-S5: features and Host](agent-runtime-architecture-program-s3-s5-features-host.md).

## Modular research follow-through, 2026-10-27

The [modular research synthesis](agent-runtime-modular-research.md) adds pinned
framework/library/durability evidence, 24 reusable failure lessons, ten positive
patterns and reviewed top-three alternatives. Its
[review record](../spikes/agent-runtime-modular-research-review.md) retains both
independent critique rounds; its
[bounded spikes](../spikes/agent-runtime-modular-architecture-spikes.md) remain
planned. This does not reopen accepted owners, pins, native custody or S1–S5;
source observations do not establish runtime qualification.

## Greenfield follow-through, 2026-10-26

The [greenfield foundation plan](agent-runtime-greenfield-foundation-plan.md)
records the larger target: independently reusable libraries, whole-harness
replacement, session continuity, resource ownership and qualified multi-worker
fleets. Its [industry research](../spikes/agent-runtime-industry-architecture-research.md)
distinguishes historical fixes from documented limits; the
[decisions and review](agent-runtime-foundation-decisions-and-review.md)
record alternatives, costs and review dispositions.

This v3 program remains the first bounded ordinary delivery. The added S2 and
S3-S5 acceptance refinements cover encoded-state readability, future-obligation
admission, real IO waiters, whole-harness seams and exact native qualification.
C0-C3 remains the capacity delivery owner. Accepted contexts/ADRs, frozen
contained, native ownership and current pins are unchanged; future fleet or
hostile-tenancy qualification does not become a prerequisite for pure S1/S2.

## 1. Goal, scope and completion

Scoped successor accepted on 2026-10-21:
[ADR-0091](../decisions/0091-interactive-agent-session-synthetic-vertical-slice.md)
admits the owner-directed A–F interactive Claude/session path as an additive
feature alongside this bounded ordinary rewrite. For that path it narrowly
supersedes the earlier Codex-only, no-feature-growth, Claude and session/resume
exclusions; it does not unfreeze contained-turn or replace existing Codex
ordinary contracts. The [C qualification plan](../spikes/interactive-session-c-first-slice-qualification.md)
and [current readiness register](readiness.md) own its scoped evidence and
remaining gates. Acceptance alone does not qualify implementation, Host
adoption, real authentication or a deployment tuple.

Rewrite the active ordinary execution path inside this repository, one coherent
slice at a time. Existing code and meaningful tests are the behavioral reference;
new implementations start in the target architecture, consumers switch once,
and only the replaced active ordinary implementation is removed. Do not first
move the old implementation and then rewrite it. A small mechanical relocation
needed by an already published boundary is allowed; it is not a second rewrite.

Deliver all selected reusable concerns: JSONL, Codex app-server protocol/session,
native-client execution integration, ordinary operations, Postgres adapters and private
storage conformance. Preserve the existing filesystem-custody package. Keep
business and security policy with Agent Execution, Provider Access, Runtime
Security and the product Host. No central SDK, universal kernel or service bag.

Contained-turn is permanently frozen for this program: keep its implementation,
state, tests and historical evidence. Do not delete, modernize, nest or rewrite
it. Active ordinary files and shared mechanisms are classified by reachability,
not by their contained-named directory. Shared credential materialization keeps
one Provider Access owner and one implementation. No card waits for contained
removal, and no temporary Host pool branch is justified by eventual removal.

Program acceptance requires all of the following, not merely merged code:

1. The active ordinary path uses the new engine, stores, bindings and public
   `operations` API, and has no replaced contained-only implementation dependency.
   The explicitly shared Provider Access materialization adapter remains declared.
2. Existing authority, one-shot dispatch, uncertainty, resource custody and secret
   protections pass the mapped behavioral oracles plus focused new regression tests.
3. Host composition is on the reviewed Get Modular 0.6.0 train; nested features
   use an actually adopted v1.1 profile and checker. Scope and pins stay explicit.
4. Each publishable package passes isolated tarball installation, its public
   surface check and a disposable consumer before publication. Publish each
   dependency-complete package when ready, without a release-wide waiting gate.
5. Required current-head repository checks pass; release and real provider
   qualification are reported separately. Private test-support is never published.
6. OBS-ADOPT supplies the selected live-operation summary subscription through
   the real Host boundary, with isolated scopes and no authority or output
   delivery moved into notifications. This is a new bounded inspection capability,
   not evidence that an existing command needed a reactive replacement.
7. S1-NATIVE integrates the native-owned client under the agreed contract.
   Fixture integration, Rust conformance and complete Linux+Docker E2E are
   separate results; activate the new profile only after its exact real tuple
   and scoped authority/credential/receipt successor qualify. Native work is not
   duplicated or counted as runtime-owned implementation.

The October 20 native-team handoff adds a separately qualified Linux+Docker
execution integration; its external keeper/init implementation is not our lane.
Outside the separately owned ADR-0091 interactive path, no other new
providers/platforms, remote execution, sessions/resume, event system,
plugin loader, scheduler, extra storage backend or orphan-process reaper.
No Subscription Runtime migration. New handwritten Node tooling is TypeScript.

## 2. Verified snapshot and moving dependencies

Integration checkpoint, 2026-10-27: the documentation delivery is reconciled
with main `e9541fcd9ed3b17b83e423eea52b998a325f2888`. Its
[Get Modular adoption record](get-modular-adoption.md) already retains the
passive/ordinary compatibility migration to Core/Assembly 0.6.0, resources
0.2.0 and conformance 0.4.0, with CMS pin `b70ba39304ac71964175c42a77309406a7c30ca2`.
Reuse that delivered work; do not repeat a package migration from 0.3.0.
P7a/P7b/N2 still require their remaining scope-specific layout, ownership,
adoption and rejecting evidence; the compatibility migration does not certify
all those cards or the new interactive Host. The following snapshot and source
identities remain historical research inputs, not claims about today's checkout.

Product facts are at agent-runtime
`efd3348f361fa6af84953325af5c0d2d8677d14a` (main, checked October 19).
The `packages/` tree is identical to `2fda5ffd76734fe2e9aedb0df2680df5ac27a148`,
used by the October 15 slice research. Its historical reachability measurement
was 196 files / 20,426 counted production lines; this is an approximate static
closure, not a new count, implementation progress or a scope denominator.

| Owner | Observed state | Implication |
| --- | --- | --- |
| agent-runtime | Wave 1 #191, #193, #194; train 1 #220-223; issue #189 work #224-229 and #231 merged | Keep and reuse this work; do not repeat it |
| agent-runtime | Get Modular 0.3.0 and Foundation 1.7.2 installed; Node default 26.11.1, pnpm 11.18.0 | Current dependency installation is not current upstream adoption |
| agent-runtime #234 | Merged October 15; 19 contained suppression waivers now expire 2027-01-13 | Do not repeat the expired-waiver repair; replace with a baseline before expiry |
| agent-runtime #230 | Still open; CI recovery changes remain separately owned | CI-CONTRACT-1 coordinates its shared files; do not take over or merge this PR implicitly |
| Get Modular | October 20 refresh: main `077434e34d75506a610bc9271f8b5b9d5718c876`; Core/Assembly 0.6.0, resources 0.2.0, conformance 0.4.0 published | P7a/P7b review this train directly; no intermediate 0.4/0.5 consumer migration |
| Get Modular observation | #195 and release #199 merged; public 0.1.0 published October 20, resources peer `^0.2.0` | OBS-ADOPT uses the released mechanism; it does not gate pure S1/S2 source work |
| Engineering Foundation | Main `aed890a6ac09762d9f487ed2624e64a873935868`; package 1.10.0 published on npm | Reuse released baseline/source-graph capabilities, not the old pending 1.8.0 work |
| Feature Module Standard package | `@agent-teams/feature-module-standard` 0.1.1 published | N2 adopts the shared kernel with consumer-specific discovery and policy |
| Organization standard | v1.1 published, blob `bd949a9a670862fea851a7791fce772fdef3b4fc` | Publication is not agent-runtime adoption |
| Process repository | Main `46f0a8d5c4914e96589c4356ea9be7861eb422a5`; published package renamed to `node-or-bun` 0.2.1 | Do not introduce another `@agent-teams/process` package |

The current process API owns a direct child until run-to-completion. The former
PROCESS-DUPLEX direction and its October 19 repository approval remain historical
decisions, but the October 20 native-team handoff supersedes that dependency for
this runtime: S1-NATIVE consumes the native-owned keeper client. Do not wrap
`node-or-bun.run()` as custody, implement another TS process owner, or take over
the native team's repositories. This does not cancel separately owned process
library work; it removes it from this runtime's required implementation chain.

The current [Consumer Module Standard](https://github.com/agent-teams-ai/get-modular/blob/077434e34d75506a610bc9271f8b5b9d5718c876/docs/architecture/common-assembly.md#consumer-module-standard)
is navigation, not a silent replacement of the consumer's pinned `81063add`
revision. P7a and N2 each retain their actual reviewed document/package delta
and accepting records; moving the pin is not this documentation delivery.

The October 20 read-back of Observation 0.1.0 matched the retained tested archive
byte for byte: SHA-256 `083bed3ca61e586d6ce91c272be4b4d07c3c68ae00aa9b414febee20e60f1915`.
The [release record](https://github.com/agent-teams-ai/get-modular/blob/c5c314ab98c57d2c73448f0c3c9860424a993d8a/research/releases/observation-0.1.0/release-intent.md)
retains the source, six OS/Node cells and external packed TEST evidence. Those
results qualify that package contract, not this consumer. The support floor is
native TypeScript 7.0.2 and the declared Node 24/26 ranges; consumer adoption
verifies its effective compiler/resolver and one physical resources/observation
copy. The last upstream commit changes agent instructions only; communication
source and guidance are unchanged from `c5c314a`.

## 3. Settled choices and supersession

The decisions log remains the record of owner direction. Append-only v3 entries
separate the October 15-16 owner choices from technical defaults selected while
completing this plan. A plan choice does not rewrite an immutable accepted ADR.
Each implementation card supplies its smallest required successor record in the
same delivery before claiming the changed behavior accepted.

| Choice | V3 disposition | Supersedes or resolves |
| --- | --- | --- |
| Rewrite by slices, existing tests first | Accepted October 15-16; do not rewrite tests simply to resemble the new implementation | V2 move-first waves |
| Keep contained permanently frozen | No deletion lane or removal prerequisite | CONTAINED-REMOVAL; v2 decisions 14/18/25 timing |
| Host storage | Verified object with operations, security, access and materialization ports; no raw pool in Host options | S2 Q1; S3 Q1; temporary decision-25 branch |
| Shared materialization | Provider Access owns its existing factory/tables; storage composition supplies a typed facade over the same borrowed pool | No duplicate shared schema implementation |
| Ordinary schemas | `ordinary_execution`, `ordinary_security`, `ordinary_provider_access` | S2 Q2; contained schemas stay owned |
| Store oracle | Preserve #231 case names and assertions; adapt narrowed port calls once | S2 Q3; no byte-identical-then-refactor ceremony |
| Provider Access | One rewrite on the S1 libraries, auth-file reader and native Codex refresh | S1 Q1; no double touch of the secret path |
| Feature names | `operation-access`, `operation-security`, `operation-execution`, `runtime-host`, `codex-releases` | S3-S5 Q5 |
| Nesting | Provider Access and Agent Execution cut over after N2, directly nested; no flat intermediate rewrite | S3-S5 Q2 |
| Registries | One generator before package/feature cutovers, committed reviewed diff, read-only `--check` in CI | GOV-2/GOV-3; S3-S5 Q3 |
| Roles (QN7) | Infer from nonempty recognized role directories after the N2 successor; retain decisions for new owners/edges, republications, composition contracts and exceptions | No ADR for adding a routine role; no blanket exemption |
| Library entrypoints | Curated runtime `.` for platform libraries; protocol/turn subpaths remain explicit | S1 Q3; scoped checker/ADR successor before runtime exports |
| Execution bindings during S1 | Keep the consuming adapter at the currently legal boundary until S2 moves the port; one mechanical relocation into S4 | S1 Q2; avoids S1/S2 dependency cycle |
| Embedded Runtime publication | Publish curated `.` and `./host`; remove `./composition` from npm exports at S5 API cutover | S3-S5 Q4; frozen implementation still builds and has internal tests |
| Runtime Configuration | Keep private unless the final public Host signature demonstrably requires a standalone package; expose needed value types through curated Host types | Conservative default for Q-RUNTIME-CONFIG; no speculative publication |
| Observation | Immutable construction inputs and explicit commands remain; OBS-ADOPT adds a real live-operation inspection subscriber, not a bus or authority cache | October 20 direction refines decision 54 without changing its protected command paths |
| Native execution ownership | Separate native team owns Rust keeper/init, protocols, generic TS client and native artifacts; runtime owns the consumer port/adapter and provider policy | October 20 handoff supersedes PROCESS-DUPLEX as a runtime dependency and the planning deferral of keeper/init integration; no frozen contained activation |

Technical defaults are reversible plan choices within the accepted scope. The
process repository approval (decision 58) does not authorize duplicate custody
after the native handoff; native implementation stays separately owned. First real Codex bump and npm interactive authentication
retain their existing execution-time requirements; neither blocks planning.

## 4. Architecture and invariants

| Owner | Owns | Must not own |
| --- | --- | --- |
| Ordinary operations | State machine, idempotency, claim/dispatch, cancellation, readback policy, owner-loss projection | Node process, SQL, provider protocol, Get Modular |
| Agent Execution | Claim-gated process policy, Codex launch/effects, workspace and artifacts | Another authority's grants or store implementation |
| Provider Access | Credential custody/capture, access grants, broker, shared materialization | Operation state machine or helper-driven policy bypass |
| Runtime Security | Dispatch/output/artifact admission and recorded grant limits | Provider token refresh or process supervision |
| Store package | Drizzle/Postgres IO, locks/CAS, migration identity, typed commit outcomes | Domain decisions, retries or pool ownership |
| Host | Trust/release selection, one composition, call admission, lifetime/cleanup policy | Domain workflows, raw SQL or a second resolver |
| Libraries | Bounded reusable process, byte framing and protocol mechanisms | Authority, effect permission or product recovery policy |

Keep construction inputs narrow. Domain and application code do not import
public contracts, Node, database/provider SDKs or Get Modular. Inbound adapters
translate foreign ports; composition selects implementations. Function-typed
port properties, pure domain decisions with explicit time/IDs, factory-produced
own-property ports, real feature cards and mirrored tests apply to new code.
Use only real directories. Size policy: production file 300 counted lines,
function 60, parameters 4, module wiring 80. Do not turn this into a rewrite of
frozen code or of all test/tooling files.

The mandatory behaviors carried into each affected slice are:

- Durable matching claim before workload start; an unknown claim never starts a
  workload or permits an automatic mutation retry. Only the bounded, owner-specific
  identity, settlement or terminal observations in the
  [S2 uncertainty table](agent-runtime-architecture-program-s2-operations-storage.md#transaction-outcomes-and-readback-ownership)
  are permitted; no readback grants dispatch ownership or retry permission.
  Unknown acceptance remains evidence, not launch authority.
- Exactly one `turn/start`; a possible write never becomes an automatic retry.
  Cancellation, expiry, output-drain and cleanup evidence remain distinct facts.
- The operation row's columns match its payload and digest (G1). Transactions
  decide after the lock and CAS by the expected revision.
- Failed workspace preparation retains a cleanup-only handle and durable
  `workspace_retained` receipt (G2); uncertainty never silently deletes custody.
- Owner loss after a durable authority bound projects `reconcile_required`;
  it never relaunches or fabricates an absent acceptance timestamp.
- Each owner writes its own grants/state. Settle security by recorded limits,
  validate identity independently of the Host's new policy limits.
- Secrets never enter logs, evidence or error payloads; secret buffers are
  cleared. Provider Access does not write `auth.json` or request refresh; its
  custodied helper may update only that file's data under the accepted design.
- Close stdin before helper escalation; never signal an observed-exited process
  leader's reused group ID. Report debts/unknown cleanup honestly.
- Borrowed pools and dependencies are never closed by consumers. Owners close
  before the outer journal; abandonment ends waiting, not actual cleanup.

### Host implementation, reuse and platform evidence

The existing TypeScript Embedded Runtime Host is implemented, not an empty
prototype: it composes passive setup and seven ordinary dependencies, binds a
trusted tenant/project scope, starts auth lazily and retains construction/
disposal recovery. S5 writes its replacement ordinary/passive composition and
`operations` API directly in the target feature. It does not discard correct
mechanisms merely to satisfy "from scratch", nor move the old root unchanged.
The old root performs constructor migrations and uses contained-named access/
disposal contracts; those are precisely the responsibilities S2/S5 replace.
The frozen contained Host remains compiled and keeps its separate contracts.

TypeScript Host/API/domain ownership and Rust technical custody are different
boundaries. The [September follow-up](rust-custody-migration-follow-up.md) is
historical research; the owner's October 20 handoff now assigns keeper/init to
a separate native lane and its integration to this runtime. Operation authority,
PA/RS policy, SDKs and HTTP/TLS stay TypeScript. Follow the coordination contract
below; no whole-Host language port, Supervisor/updater or Windows lane is added.

| Existing component | S5 disposition |
| --- | --- |
| Ordinary/passive composition and public access | Write the new target implementation once: verified storage/no constructor DDL, release selection, `operations`, scoped composition and safe diagnostics. Preserve current refusal, replay, cancellation and ownership behavior. |
| Generic abort coordination, safe snapshots/validation and setup capabilities | Reuse an unchanged independent helper where its contract still fits; otherwise replace it once in its named ACTIVE-SUPPORT/Host owner. Do not add a dependency on frozen contained policy. |
| Journal ownership and cleanup-only recovery | Preserve their independent assertions and proven mechanisms. Adapt their owner-local contracts to the new Host; never copy the contained authority/proof ledger as the ordinary disposal policy. |
| Shared Provider Access materialization and native filesystem custody | Reuse their existing owner/implementation under the stated S2/native distribution contracts; no second rewrite or ownership transfer. |
| Rust Supervisor/Guardian experiment | Native team may audit/reuse Guardian primitives. Keep experiment source/evidence here unchanged; no production import or local rewrite. Supervisor generation/updater work is a different concern and not a third required component. |

Platform claims are scoped to the executed boundary, not to the language:

| Boundary at the retained source | Implemented/tested evidence | Current limit |
| --- | --- | --- |
| Ordinary product execution | Real TS composition plus wiring, lifecycle and disposable Postgres tests; process adapter admits Darwin/non-root and auth additionally requires arm64 | macOS arm64 cooperative user-session candidate; no claim of a fully live-qualified product. Linux/Windows ordinary execution is unsupported by these adapters. |
| Passive setup and reusable libraries | Tests for their actual portable APIs/declared targets | Passing on Linux or supporting a platform in one library does not qualify ordinary process/auth/custody on it. |
| Frozen contained Docker/Linux route | One exact registry tuple has implementation-level boundary evidence | Its own record explicitly excludes a live turn; it does not qualify the ordinary Host or every Linux deployment. |
| Rust Supervisor/Guardian | Retained `aa7685867d5ccbaba7b4eb0f873566f46d676945` synthetic Linux/macOS/Windows matrix, independently read back as successful | Spike proven, production unqualified; signing/distribution, durable recovery and supported-target gates remain open. |

Use [readiness](readiness.md), the exact
[qualification registry](qualification-registry.json) and the
[Rust production gates](../spikes/rust-system-boundaries-production-gates.md)
for those claims. A new ordinary provider/binary revision needs its own selected
target evidence through FIRST-BUMP; inherited tests or a three-OS Rust spike are
not that evidence. The newly selected native integration targets Linux+Docker
under its own explicit profile/successor and exact qualification tuple. It never
relabels Darwin cooperative records or the frozen contained tuple. No Windows,
Kubernetes or automatic weaker TS fallback is selected.

### Native-team coordination contract (NATIVE-INTEGRATION)

This is the canonical boundary for the October 20 owner-supplied handoff. Link
here from assignments and owning briefs; do not maintain separate wire schemas.
`agent-teams-ai/custody-keeper` and `agent-teams-ai/custody-init` are working
repository names, not evidence that repositories, packages or releases exist.
The external native lane creates/delivers them and supplies exact identities.

| Owner | Sole implementation responsibility |
| --- | --- |
| Native keeper | Per-attempt host-side Rust custodian: Docker resource lifecycle/unknown outcomes, owned process/container identities, init transport, accepted autonomous deadlines, technical resource journal, cleanup-only recovery and enforcement of the selected technical limits/network rules. Owns broker child launch/stop/wait. No host-wide daemon without a demonstrated need. |
| Native init | Rust execution/stdio/descriptor ownership, bounded queues/backpressure, partial writes, close-input, signals/wait and technical observations; runs under Tini, not a new PID 1 or OCI runtime. Owns its protocol; keeper consumes its pinned compatible version. |
| Native client/release lane | Keeper external API and generic TS client, protocol compatibility, binaries/images/artifacts and the main real-process/Docker E2E matrix. Client imports no runtime models, PG, provider SDKs or Get Modular. No third repository merely for shared types. |
| Runtime TS lane | Consumer-owned execution port and keeper adapter, committed claims/operations/receipts/PG, PA/RS and credential/policy decisions, provider protocol/SDK integration, broker HTTP/TLS semantics, workspace/artifact contents, public API and modular Host lifetime. No second Docker engine wrapper, process custodian, native journal or generic keeper client. |

Dependencies run in one direction: runtime adapter -> keeper client/API -> init
protocol. Runtime command/domain types never leak backward. Keep the execution
port provider-neutral and in the existing seven-port family; no generic RPC
framework, service bag or per-native-method domain abstraction.

Before either adapter or native API is committed, the runtime integration owner
and native protocol owner fix a small versioned contract plus executable fixture:

1. Protocol version/transport, typed errors, incompatibility and disconnect facts;
   pin client, keeper, init and image/artifact identities, not moving branches.
2. Request/attempt identity, the exact acceptance of native custody and query of
   the same attempt after lost acknowledgement. Persist an immutable native
   correlation key in the acknowledged operation before its first attempt-owned
   native effect, including preparation helper/resource acquisition; include that key in later
   preparation/claim identity. Bound child executions use stable purpose-specific
   keys, known before sending a request, even if native returns another private
   handle. Query/recovery uses those same keys after crash/lost acknowledgement.
   A confirmed dispatch claim gates workload execution. A pre-claim auth helper
   or broker may start only under its existing bounded PA/RS preparation authority,
   with separate purpose/identity/deadline and no workload-start permission. This
   is not an exception for arbitrary executables. Unknown DB claim never grants
   workload start; observing an existing attempt never grants another launch.
3. Validated command/args/environment, explicit mounts, limits and authentic
   descriptors; distinguish host mount-source paths from container/image command
   and cwd paths. No serialized PID/FD number is acquisition authority. Journal
   and diagnostic DTOs allow only safe technical facts, never raw launch requests,
   argv/environment, stdin/output contents or credential values.
4. Deadline representation/clock and acceptance, independent enforcement,
   stdin-first stop policy and completion bounds. Reconnect does not extend it;
   unavailable Docker/recovery retains discoverable incomplete cleanup.
5. Ready/start failure, bounded stdin/stdout/stderr, partial-write outcomes,
   EOF/exit and delivery facts. Transport acceptance is not provider-pipe write
   acceptance; unknown writes are never blindly replayed.
6. Technical query/cleanup/recovery and a retained recovery reference. The Host
   integration owner invokes native startup/recovery via the supplied client;
   deployment startup owns recovery when no runtime Host exists. Native performs
   cleanup-only recovery, never provider restart/resume or retry policy. The
   native client/bootstrap contract owns keeper launch/reattachment and proves
   exclusive live-versus-recovery custody for the same key; runtime adds no local
   spawn/lock/signal implementation. Refuse/retain debt if exclusion or identity
   cannot be established; never clean a live sibling's resources.
7. Resource ownership and identity mismatch refusal. TS owns source/workspace
   content; declaring a mount never transfers permission to delete its source.
   Native release observations are inputs to owner-evaluated receipts, not
   operation truth or permission grants.

The native protocol/client lane publishes and versions the executable contract
fixture as dev-only support. Runtime pins that exact artifact and adds its own
independent product assertions, not a second normative fixture/wire schema.
Production selection rejects a fixture. Agree this technical subset jointly;
runtime's AE/RS/PA and Host owners separately accept the Linux execution profile,
closed required-receipt set, limits, authority and credential mapping before
dependent runtime codec/adapter contracts are frozen. Native publishes technical
facts, not that product policy. The old ten-receipt Darwin bound is not a generic
native limit; reject unsupported profiles or receipt mappings before acquisition.

S3 owns broker executable behavior and its narrow credential/policy inputs;
keeper owns that executable from launch. Do not TS-spawn a production broker
and transfer it afterward. Broker stop/closed sockets do not prove cancellation
of a request already accepted by a provider. S3/S4 retain remote reconciliation.
Fix helper placement and the exact Linux credential-file access/sandbox contract
with native/PA owners before NATIVE-AUTH activation; the old Darwin auth helper
and its permission grammar do not automatically qualify on Linux or in Docker.
No broader credential mount/write permission follows from this handoff.

If a selected SDK synchronously requires a process-like handle, its runtime TS
facade adapts the async client: finite early-write bounds, delayed readiness,
typed launch failure, cancellation before ready, streams/exit/EOF and unknown
writes. It does not acquire a second process owner. Codex remains the first
provider; no automatic Claude/all-SDK rewrite is added by native generality.

Work against the agreed native fixture while artifacts are pending; it is test
support, never a hidden production TS custody implementation. Report fixture
integration, actual Rust contract conformance and full TS->keeper->init->Docker
E2E separately. The native lane owns its broad matrix; runtime tests the product
mapping and one complete integration, including lost ack/no duplicate launch,
partial stdin, overload, controller loss, keeper crash/recovery, identity mismatch
and incomplete cleanup. Verify unrelated containers/processes and source mounts
survive. No LLM calls are needed for those deterministic disposable scenarios.
Keep provider smoke separately authorized. Use focused unit/property/fuzz tests
for dangerous transitions/parsers; no test-line quota or accessor test mandate.
Throughput/density requires measured load evidence, not the choice of Rust.

Native interface/profile/artifact unavailability blocks only its effectful
cutover and E2E. Pure libraries, engine/store and TS policy work continue. Never
silently substitute direct Node/Docker execution or claim physical guarantees
from a fixture. Accepted ADR/profile successors are required before activating
the new Linux+Docker target; frozen contained source and records stay frozen.

### Module communication

Follow the accepted [communication practice catalog](https://github.com/agent-teams-ai/get-modular/blob/3dd68a6b26f42159714a4640b613534a55c2c6aa/research/module-communication-2026-10/raw/practices/practices-catalog-v2.md),
and the current [module authoring guide, section 21](https://github.com/agent-teams-ai/get-modular/blob/077434e34d75506a610bc9271f8b5b9d5718c876/docs/guides/module-authoring.md#21-module-communication).
Use A1/A3/A5/A6, B1/B3, C1/C2/C4/C5/C6, D1/D4/D6 and E1/E2/E3/E5.
The catalog's dated `Planned`/`Proposed` labels are historical: current CMS,
accepted successors and actual released APIs decide what exists.
Configuration and the selected Codex release are immutable construction
snapshots. A changed release/configuration creates a new Host; in-flight work
retains its recorded release. The journal is a required command with an outcome,
never a notification. One upward receiver is an explicit typed port. No global
bus, polling, wildcard subscription, hidden parent or observer used as a command.

| Need | Selected mechanism and boundary |
| --- | --- |
| Value needed at construction | Typed slot/run input; read once, no subscription |
| Current durable authority, permission, claim or cancellation | Explicit owner query/command and its typed result; read at the operation boundary |
| Converge to another owner's newest state | `ReadonlyStore<Slice>` through a declared required slot; `read` then `watch` from that authentic snapshot |
| Replaceable asynchronous query following changing input | `load` calling a typed query port; only when a concrete reader needs it. No initial load consumer is invented by OBS-ADOPT |
| A fixed set of independent contributions | Owner's narrow extension-point contract and `many()` with an explicit ordered binding row; owner declares aggregation/error policy |
| Every occurrence matters, including identical occurrences | Existing acknowledged journal, cursor/output or domain operation contract. Observation 0.1 has no lossless events, replay or delivery acknowledgement |

The word "hooks" does not authorize one universal callback API. Commands,
latest-state observation and extension points have different contracts. A single
receiver stays a direct call, not `many()` or an event. Fixed helpers remain
imports/factories; a new graph node requires real independent composition or
lifetime. Dependencies are acyclic; a common ancestor/bridge coordinates owners
instead of a feedback chain. Nested feature republication exposes only the
chosen contracts, never private child entry identities.

### First Observation adoption (OBS-ADOPT)

Select one useful new capability: a bound Host caller can follow the latest
non-secret summary of an ordinary operation executing in this Host, without
polling durable storage. Agent Execution owns the summary writer; a Host
inspection/operations composition subscriber consumes it. This continuous view
does not exist in the baseline. It is the bounded technical choice implementing
the owner's October 20 direction to use the module mechanism, not a reason to
turn existing correct calls into subscriptions.

The summary is one correlated plain-data aggregate: operation identity, durable
operation revision and the existing status union. Add only separately justified
safe scalar progress fields. Exclude output/prompt text, credentials, grants,
handles, signals and raw error causes. Do not copy `OrdinaryView` wholesale.
Observation's store revision is a separate local identity, not a durable revision
or cross-store transaction. Define the data contract with its semantic owner;
only outer composition uses Get Modular types/resources and keeps the writer.

S2 exposes an ordinary typed owner-local publication seam for confirmed summary
changes. The composition adapter commits the store after the authoritative
transition is acknowledged. Unknown commit or ownership never publishes a
confirmed running/succeeded state. Every successful owned transition uses the
same mapper; replay/readback cannot grant a new dispatch. Projection failure
reports through the safe Host error boundary and leaves explicit command results,
cancellation, evidence and reconciliation semantics intact. The view is advisory;
`observe` remains the authoritative durable query and fallback.
The owner-local publisher is a synchronous function property returning
`undefined`, not a promise or delivery acknowledgement. Its outer adapter catches
projection/reporting failures; the engine never awaits observers or turns an
already acknowledged transition into failure. Compare equal summaries by the
explicit contract fields, not by store revision or a copied durable record.
Serialize publication through its one owner and compare durable revisions:
ignore a lower revision, treat equal revision/equal summary as a no-op and report
equal revision/conflicting summary as an integrity fault without overwriting.
An acknowledgement arriving late cannot regress a newer or terminal summary.

S5 exposes a framework-neutral, explicitly scoped latest-summary subscription
on the already bound operations handle. Composition creates/closes its child
resource scope; public callers receive no `Resources`, writer or other-operation
facet. Authorize before acquiring or exposing the exact operation's facet. A
typed slice is not a field-level access boundary: a broad facet must never carry
another tenant's data or secrets. The Host receives the full supported
`ReadonlyStore<Slice>` contract internally, not `Pick`/`Omit` of its methods.

Prepare the subscriber template once; each authorized reader reserves a child
run before its first await. A declared `input<C>()` supplies that exact
operation's facet in `run({ inputs })`; the subscriber consumes it through its
required slot. The Host does not rebind a singleton slot or pass a facet registry.
Publish only a successful run's facade after rechecking call admission; close
failed/cancelled runs after they settle. The producer outlives its reader runs.

First adoption covers only live operations this Host owns. A nonlocal/historical
operation gets an explicit `not_live_here` subscription result and can still use
durable `observe`; do not fake distributed notifications or introduce a database
watcher. Admission returns a last-confirmed initial summary and an inert owned
subscription handle, or a typed refusal. The handle's explicit `start()` is a
synchronous, idempotent activation after the caller has applied the initial
summary; no callback occurs before activation or synchronously inside it. The
prepared run retains the authentic initial snapshot and attaches `watch` at
activation, catching up changes across all awaits. A closed/revoked instance
returns a typed closed result instead of activating. No custom delivery queue.
Updates may coalesce and callbacks are synchronous/idempotent. A terminal callback
is not guaranteed if close wins delivery; callers obtain a definitive final
result through existing completion/query contracts. A subscriber failure never
cancels or retries execution and cannot change `onAccepted` behavior.

Subscriptions have instance/operation/purpose names and the receiving scope's
lifetime. Closing one reader detaches it before drain and leaves siblings alive;
closing the Host stops admission, detaches subscriptions and drains existing
owners before journal close. Retain incomplete physical cleanup as debt. The
Host's error sink must not throw and must sanitize raw listener causes. No
production import of `/testing`, global flush, order dependency between listeners
or borrowed-resource disposal. Releasing a subscription never claims the process
or a durable obligation has ended.
Count reserved and active reader scopes against a first-delivery Host limit of
64; refuse excess before acquisition, without evicting another reader. This is
an explicit bounded policy, not a scale qualification. The direct owned-flight
completion path closes its readers before releasing the summary source; do not
wait for a lossy terminal notification to perform cleanup. The handle's `closed`
outcome describes the subscription lane only, not physical operation completion.

If a later selected capability needs `load`, its promise includes physical work
and cleanup; one active plus one newest pending job is not a deadline. Superseded
success/errors cannot publish. Ignored abort may block successors, and Host
escalation reports debt rather than pretending to stop work. Never launch a
provider, spend quota, append evidence or settle a grant from a loader. Correlated
derived values use one aggregate and one initial/update mapping; do not watch
both raw and derived state or infer cross-store atomicity.

Lossless events and dynamic contribution registries remain separate future
capabilities, not unfinished parts of Observation 0.1. Before selecting one,
identify actual independent reactors and specify ordering, loss/duplication,
acknowledgement, replay, failure and scope semantics in its owner. No new event
package or plugin system is required by this program.

## 5. Prerequisite cards

Each row has one bounded owner. Existing externally owned work is coordinated,
not duplicated. The [execution brief](agent-runtime-architecture-program-execution-brief.md)
contains the executor contract and verification policy.

| Card | Owner/scope | Completion and concrete checks | Dependency |
| --- | --- | --- | --- |
| CI-CONTRACT-1 | CI integrator: `scripts/ci`, source-policy reversal test, affected workflows/contracts | Replace frozen equality/reversal chain and six-package inventory with forward coverage; each current leaf routed exactly once, every package tested, zero-test evidence rejected, trust digests remain enforced. Positive new-package fixture plus missing-shard, removed-leaf and stale-digest rejecting cases | #232 done; coordinate #230 ownership before changing overlapping recovery logic |
| GOV-BASELINE | Integrator: one reviewed Foundation bump and baseline producer adoption | Adopt verified released 1.10.0 or later separately reviewed compatible release; invoke CLI `baseline check --config ...`, not a nonexistent `foundation.config.yaml` key. Both ordinary lint and typed-quality routes must reject new/worse findings and prune stale ones. Remove superseded waiver directives, no renewal | CI-CONTRACT-1; installed pinned lint producer compatibility |
| P7-now | Runtime integrator: immediate rules, named OrdinaryTurn port, source/layout checks | Publish consumer mapping/AGENTS block; narrow port fix; new code follows target limits; use released ratchet APIs/producer, not a second baseline implementation. Preserve exact frozen entries, no blanket exclusions | Can start docs/port work now; strict baseline activation follows GOV-BASELINE |
| GOV-REGISTRIES | Integrator: generator over current owner data | One `registries:write` and same generator `--check`, deterministic output/readable diff, no source execution/network; mechanical census/profile digests/coverage anchors derived once, hand decisions never generated. Reject unknown owner, missing root, unresolvable edge and ambiguous anchor | CI-CONTRACT-1; shared source-graph API; record current pin procedure |
| DOCS-SUCCESSORS | Integrator: scoped ADR successors, not accepted-byte edits | Record library export/classification, auth-file/refresh/release policy and Host API/storage boundary changes. Batch related decisions; no ADR per file or routine layer | Before affected behavioral cutover, parallel with library development |
| P7a/P7b | Existing Get Modular consumer adoption lane | Review published Core/Assembly 0.6.0, resources 0.2.0 and conformance 0.4.0 with TS 7.0.2; current CMS pin; static entries/groups/root, one assembly, own-property ports, smoke/wiring oracles; update reserved files once | P7-now; actual registry artifact verification |
| N2 | Runtime FMS adoption lane | v1.1 pin + shared FMS kernel/fixtures, deepest owner, visible surfaces/republications, runtime/type edge cycles, load cycles, empty directory rejects, mirrored tests, roles inferred under successor | P7b; compatible Foundation + FMS release installed |
| PUBLISH-ROUTE | Integrator: package versions/changesets, surface and tarball qualification | Per-package release with migration notes; names/kinds surface report and isolated runtime/types imports. Local package qualification may be used now; shared Foundation mechanism replaces it once available, never two active implementations | Before first relevant package publication, not before authoring its source |
| CONTAINED-FREEZE | Integrator: exact source/test classification and notices | Keep code/build/typecheck; disable only proven contained-only tests with owned return conditions; all ordinary/shared materialization tests remain. No delete lane | CI-CONTRACT-1; active reachability and shared-test inventory |
| NATIVE-CONTRACT | Runtime integration + external native protocol owners; AE/RS/PA/Host own product-profile acceptance | Versioned seven-part contract, native-published dev fixture, durable native correlation, workload/preparation admission split, exclusive recovery and closed product receipt/profile mapping | Before dependent contract/codec freeze; real artifact/E2E qualification before activation; no production fixture fallback |
| NATIVE-AUTH | PA + native integration owners | Exact helper placement, credential route/file permissions and broker executable inputs; Linux sandbox/identity/refresh proof and scoped profile successor | Before native provider/auth activation; no implicit port of Darwin permission guarantees |

GOV-BASELINE does not imply EF-SURFACE or isolated-install mechanisms exist.
Match actual capability IDs and commands in the installed release. The old
EF-SURFACE, STANDARD-1b/1c/1d and neutral README cards remain external tooling
work only for the specific missing capability after source inspection; do not
rebuild delivered baseline/source graph/FMS packages. A first package may use a
small package-local packed qualification instead of waiting for that work.

### Get Modular decisions before the affected rewrite

The October 20 pre-rewrite source review found no missing Get Modular runtime
primitive that must be built before this rewrite. The published train already
supports its selected static/nested graph, per-run inputs, scopes and Observation
consumer. Prepare the contracts below now; adopt/enforce them with P7b/N2 and
each affected cutover. Do not hold S1 pure libraries or S2 engine/store authoring
for events, plugins, platform-wide certification or another manager.

| Contract to settle now | Concrete rule that prevents later cross-module rewrites | Owning delivery |
| --- | --- | --- |
| Public capabilities and boundaries | Consumer-language function-property ports and plain data; descriptor owns permanent capability ID and exact revision. Optional absence and ordered bounded contributions are explicit. No universal module base class, parent services or ambient resolver. | Contract/feature owner; P7a/P7b and N2 classification before its cutover |
| Ownership and instance lifetime | Slots/inputs are borrowed; own acquisitions and shorter reader/operation scopes explicitly. Reserve before await, settle construction before close, retain incomplete cleanup and source custody. A prepared template holds no per-run state. | Resource owner and Host; first owning slice |
| Commands, state and occurrences | Commands/queries return their actual outcome. Observation carries latest confirmed plain state only. Each occurrence that matters keeps its acknowledged journal/output/domain contract. New observers opt into a new narrow slot instead of changing every factory's context. | S2/S3/S4 authority owners; OBS adapter with S5 |
| Readiness and diagnostics | One declared per-Host diagnostic input exists before factories and survives cleanup. It never depends on the runtime-host capability being constructed. Construction and readiness are different facts; no provider effect occurs to prove Host readiness. | Root/Host integrator; first effectful root cutover |
| Replacement and evolution | Contract suites preserve refusal, uncertainty, cancellation and custody, not just method names. Published value-type changes, additive included, advance the descriptor revision. Module IDs, package versions, durable formats and release records are different identities. Cache a template by plan digest and factory-set identity. | Contract and adapter owners; shared suite and root binding at cutover |
| Trust and future isolation | Current capability objects/resources belong to trusted cooperative in-process modules. A future untrusted or remote contribution crosses a validated Host-owned DTO/IPC adapter; it receives no raw factory, writer or Resources. Keep this seam in the contract without building a plugin runtime now. | Host/public-contract owner; seam now, implementation with a selected future consumer |

Adding a later event source, readiness view or dynamic extension capability can
use a new descriptor/slot for the modules that actually consume it; existing
module factories need not acquire lifecycle methods or a larger context. A
future dynamic registry still needs its own contributor lifetime and delivery
contract. `many()` already covers fixed contributions; it is not live
registration. Revision windows, a universal event/replay API and hot replacement
are not prerequisites of this program. Native TypeScript 7.0.2 follows the
accepted upstream ADR-0038 even where historical CMS checklist wording still
names 5.8.3; retain that delta explicitly in the pin review. Missing
`Resources.path` is an additive diagnostic improvement, not a blocker: use the
existing safe instance/operation/purpose names and source/subscription/revision.

Apply those six decisions in this order inside each affected card, without a
separate foundation phase:

1. **Specify the boundary before its adapters.** Put the plain public value/port
   types with their semantic owner; put `defineContract`, `declareModule` and
   the feature capability map in composition. The existing feature card names
   each published/consumed capability, exact revision, provider selection and
   explicit absence. Republish a nested child's chosen contract at its parent;
   do not expose its private module identity or add a node for a fixed helper.
2. **Make changes atomic at that boundary.** Keep the permanent capability ID
   when changing its value type; advance its revision, including for additive
   fields, and update provider, consumers, fake and contract suite together.
   Do not introduce `/v2` IDs, revision ranges or casts to accept an old provider.
   A package release follows its own SemVer policy; a descriptor change does not
   imply a persisted schema/profile change. Create new descriptors only for new
   independently consumed capabilities, not another copy of the same contract.
3. **Protect the actual snapshot.** Validate/copy caller-owned configuration,
   release and scope DTOs at ingress using the existing owner rules; TypeScript
   `readonly` alone does not prevent later caller mutation, and Assembly treats
   input/capability values and factory closures as opaque. Freeze only the owned
   plain-data representation where required. Do not recursively freeze,
   clone or take ownership of borrowed ports, signals, resource scopes or pools.
   Factory closures keep immutable construction inputs; mutable run-specific
   values go through declared run inputs. A cache key cannot repair a factory
   whose captured meaning changes after preparation.
   Keep authority checks at the operation boundary even when its display state
   is observed. Retain the selected release for the whole owned operation.
4. **Prepare, construct, then admit.** Resolve the declared graph and reject
   missing/ambiguous/wrong-revision bindings before any product factory or loader.
   Keep entry creation/imports inert; preparation is not a sandbox for arbitrary
   JavaScript or metadata-adapter effects. Use
   `implement(..., scoped)` for an owning factory and `resources.setup` for async
   acquisition; never acquire across an await and then hope `use()` can accept
   the value after close. Reserve the attempt before the first await. Supply
   its explicit inputs/signal/scope to `run`, await settlement, and publish its
   narrow facade only after success and the final Host admission/readiness check.
   The attempt owner retains cleanup for a returned success that can no longer
   be published.
5. **Retain failed ownership explicitly.** On failed/cancelled construction,
   preserve the actual created journal and any untransferred returned product
   in the private attempt owner; do not dispose an object twice through journal
   and scope cleanup. A close request during construction fences publication
   and requests abort immediately, then closes after run settlement. An incomplete
   report retains its handle, borrowed-provider custody and explicit retry path;
   it is not permission to construct again or mark the Host ready. Map safe phase/code/
   owner facts to the public outcome, keeping raw causes/products private. No
   diagnostic failure authorizes replaying an effect or converting a required
   provider failure into optional absence.
6. **Switch one coherent consumer boundary.** Port the independent behavioral
   assertions first, implement the replacement against that contract, then
   switch its root binding, reviewed registry projection, exports and affected
   callers together. Prove the four outcomes below on that candidate. Remove
   only its replaced active ordinary path. Reuse existing conformance and
   adapter tests; a new lifecycle interface, plugin loader or duplicate test
   framework is not part of this step.

### Module cutover acceptance: four concrete outcomes

These are P7b/N2 and the affected slice's acceptance, not a new platform-wide
phase. Record the outcome for the boundary being replaced; pure S1/S2 source
work does not wait for unrelated module deliveries. Use the existing
[adoption record](get-modular-adoption.md#train-030-conformance-status) as the
retained starting inventory, not proof that its old package pins satisfy the
new scope. Keep frozen contained rows unchanged and record active replacements.

| Outcome / owner | Implementation instructions | Observable completion |
| --- | --- | --- |
| Boundaries / feature owner + N2 integrator | List semantic owner, public value contract, composition descriptor, declared slots and lifetime for each meaningful new boundary. Register the nested feature/group once and republish only the chosen child surface. Private parsers and fixed library dependencies stay imports. One source-graph inventory feeds the scoped FMS/import/layout checks. | Every active new root and runtime/type edge is classified. A private child/deep import, undeclared owner, forbidden domain/framework edge and cycle reject. No production fallback assembly or string resolver remains. |
| Replaceability / contract owner + adapter owner | Reuse each card's independent behavior cases and contract suite. Run that suite against the owner fake and real behavioral implementation when both exist; do not count a one-scenario stub as a second implementation or build an extra production backend. Select variants through the root's explicit binding, keeping domain code unchanged. | Same observable success/refusal/uncertainty and ownership semantics pass on both subjects. A wrong capability revision or ambiguous binding fails before any factory/effect. The independent wiring oracle pins intended providers; production data-format/profile identities remain separate from module IDs. |
| Lifetime / Host + resource-owning module | For every acquired or borrowed resource record who closes it, which dependent cleanup needs it and what remains owned after failure. Reserve each dynamic run before its first await, inject per-run inputs explicitly and close failed/cancelled construction after it settles, including untransferred returned products. Keep related retire/settle steps in one owner cleanup. | Two runs with different inputs have separate state and scopes; closing one leaves the other usable. Failed partial construction retains a recovery handle when release is incomplete. Borrowed pools/ports are not closed. Subscriber detach precedes drain; owner cleanup precedes the journal. Abort/timeout alone never proves physical release. |
| Diagnostics / Host + adoption integrator | Map Core preparation diagnostics and Assembly run failures into safe Host outcomes by stable code, phase and implementation identity. Keep raw causes and retained cleanup products private. Construction success and product readiness are separate; the Host admits calls only after its actual selected resources/policy checks pass. | Missing dependency, wrong binding, factory failure, cancellation and cleanup debt identify their owner/phase without secrets or false ready/closed claims. Unknown codes fail closed while retaining safe machine-readable details. Existing static graph/created journal describes the known result; no live progress stream is claimed before such a mechanism exists. |

Write the module factory as a typed value with function-property ports and
consumer-owned dependency records. Keep Get Modular/resources/observation in
outer composition, not application/domain. Inputs are one narrow port or plain
data, never a parent service bag. `optional` means explicitly absent in this
composition; provider failure is not silently converted to absence. A replacement
in this program is a new prepared run/Host, not live slot rebinding or an implicit
promise of plugin hot replacement.
Host readiness here admits the declared local command interface after storage,
release/configuration and scope checks. It does not pre-launch a provider,
consume a grant or wait for another module's future during construction.
The diagnostic sink is a declared per-Host input or outer-root port, ready before
factories and alive through cleanup. AE may consume it while runtime-host
consumes AE; never provide it from runtime-host and create a dependency cycle.
Normalize listener/Assembly causes only at that outer boundary; keep causes and
untransferred products private, with a non-throwing safe report path.

Use the actual `architecture:get-modular-adoption` and
`test:get-modular-adoption` commands for current source/profile rejection, plus
the scoped N2 checker selected from the installed shared kernel. Conformance's
`isolate`, root `smoke`, `checkWiring` and `runContractSuite` provide the existing
mechanisms. Extend the owning suite for the risks above; avoid repeating the
same behavior at every layer. A root smoke/zero subscription count does not
prove physical process, descriptor or database release: retain the existing
adapter/custody and Postgres cases for those claims. Changed/fast/full checks
keep their existing program-wide meaning and run policy.

### 5.1 Active support features (ACTIVE-SUPPORT)

The active path includes setup/configuration support, not only the engine and
its execution adapters. Assign these feature groups explicitly to their package
owners; they are part of program completion:

- Runtime Configuration: `codex-configuration-inspection` and
  `claude-code-configuration-inspection`.
- Agent Execution: `runtime-installation-discovery`.
- Runtime Security: `setup-source-inspection-authorization`.
- Embedded Runtime: `setup-inspection-planning` and
  `trusted-runtime-access-scope`.
- Filesystem Custody: `stable-filesystem-custody`.

The handoff's historical estimate was about 70 active files / 7,142 counted
lines; it is an inventory estimate, not a demand to rewrite every unchanged
helper. Write replacements for each selected capability directly in the target
layout, with the existing behavioral cases first. Preserve provider-specific
inspection semantics; sharing a small proven digest port does not justify
merging the different Codex/Claude configuration rules. This is setup inspection,
not a Claude execution rewrite or a new provider feature.

Place use cases in `application/use-cases`, deterministic parsing/mapping in
domain where its contract fits, IO in adapters and typed factories in
composition. Preserve exact provenance, safe-semantic boundary, path/scope and
custody checks, public result shapes and authority ordering. Fix long functions,
parameter records and method-shaped ports as part of the one rewrite. Add the
feature card and its current rejecting layout/import checks; do not use a size
split to invent a new semantic owner.

Start after the registry generator and relevant scoped role/owner successor.
Embedded Runtime cutovers touching reserved Host files follow P7b; independent
configuration work does not wait for N2 unless it actually introduces nesting.
Tests mirror their owner and preserve positive/refusal examples, invalid config
and source/scope drift, expiry/cancellation, bounded file reads and cleanup.
Complete the affected package checks and the one final required gate. Public
setup/Host qualification depends on the affected ACTIVE-SUPPORT work; unrelated
JSONL/protocol authoring does not. Filesystem release additionally needs
PUBLISH-NATIVE below. Do not leave this lane as baseline debt while declaring the
whole active path migrated.

### 5.2 Native custody distribution and publication (PUBLISH-NATIVE)

Owner: Filesystem Custody, release/native-build integrator. This retains decision
26 and the accepted immediate-publication scope. The existing artifact is
`dist/rename-no-replace.node`, built from `native/rename-no-replace.c`; it also
serves descriptor and process-lock operations. Packaging just a rename function
would silently drop existing contracts.

Select prebuilt optional platform packages for the exact supported OS/CPU and
Node-API tuple. Build and qualify immutable binaries in CI from the release
commit, record their digest/provenance and include the complete exports expected
by the current loader. The main package selects only the matching optional
artifact. Unknown platform, missing/incompatible artifact or unsupported
filesystem refuses with the existing typed unsupported outcome. There is no
`exists`-then-rename JavaScript fallback that weakens no-replace or descriptor
custody guarantees, and no consumer compiler/postinstall requirement.

Acceptance before first publication: runtime and type imports from the isolated
packed main package plus its exact platform artifact, with no compiler/repository
checkout available; existing custody/publication/descriptor/process-lock cases;
missing artifact and unsupported tuple refusal; competing destination and symlink/
identity drift rejection; handle cleanup; Node 24/26 and each advertised platform
artifact loading. Linux library evidence never qualifies Linux ordinary execution.
Publish the matching optional artifacts before the main package that references
them; keep immutable versions and a release migration note. PUBLISH-NATIVE depends
on the relevant ACTIVE-SUPPORT cleanup and the common release route, not S5 API.
It is not permission to rewrite native code whose behavior already qualifies.

### 5.3 Retained conditional shared-tooling cards

Replacing v2 must not erase its accepted external work. The following are owned
cards with concrete acceptance. First inspect the selected published release:
if it already satisfies a row, record its exact capability/artifact and mark that
row delivered; otherwise implement the missing mechanism once in its owner.
These rows do not reclassify the already delivered baseline/source-graph/FMS
kernel as missing.

| Card and owner | Result and minimal acceptance |
| --- | --- |
| EF-SURFACE, Engineering Foundation | Configurable offline names/kinds inventory derived from exports/source re-exports; one package tier with a consumer-owned entrypoint budget. `surface:update` writes canonical output, `surface:check` gives readable diff/update hint; added unrecorded export, changed kind, over-budget tier and invalid re-export reject. Signatures stay with public-api-compatibility. Validate on one real package plus a disposable consumer. |
| STANDARD-1a, organization quality standard | Library-specific conventions: coded errors with guards, signal last, discriminated outcomes, close facts and no global mutable singleton. Link existing SemVer/migration policy instead of copying it; do not add a runtime framework or style-only gate. |
| STANDARD-1b, Engineering Foundation | Neutral library scaffold with configured manifest/tier/publication marker, types/build, curated surface, packed consumer and changeset. Validate after the real JSONL delivery proves the shape; no generated empty layers. Dependency policy distinguishes declared runtime/peer/dev edges, without banning the real jsonl dependency of codex-app-server. |
| STANDARD-1c, Engineering Foundation | Isolated tarball install/runtime/type-import qualification: exports targets exist, shipped files and public dependency closure suffice, private deep paths/src leakage reject. Use the actual packed bytes outside the monorepo; do not require workspace-root dependencies accidentally. |
| STANDARD-1d, Engineering Foundation | For pre-stable 0.x breaks, recognize a minor changeset containing Breaking/Migration notes instead of a new ADR for each API fingerprint. Fingerprint comparison and invalid bump/missing-note rejection remain; existing 1.x policy is not weakened by this card. |
| EF-README, Engineering Foundation | Neutral configurable mechanisms and explicit consumer-owned policy; if current wording already does this, retain the source identity as done. Text correction only, no new capability. |
| FMS-LIBRARY-FIRST, organization standard owner | A complete immutable successor text/registry/decision adds the accepted LIBRARY_FIRST evidence route to extraction criteria, with an actual owned reusable contract, real consumer and disposable proof. v1.1's nested-feature publication did not itself deliver this criterion. Do not edit frozen v1/v1.1 bytes. The runtime retains its exact owned library deviation until the successor is actually adopted; N2's nesting pin and this later policy adoption are distinct. |

The scope of these cards comes from the [retained v2 plan](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/docs/architecture/agent-runtime-architecture-program-plan.md)
and decisions 19/20/24/38/39/42/44/45. Reuse the current CMS successor reference
already admitting v1.1. A reviewed generated census diff does not require a new
waiting period or another standard amendment merely because v2 once proposed it.

Package-local packed/surface checks may satisfy the same concrete invariants
until the shared mechanisms are released. Adopt the shared implementation once
when available and remove the superseded active mechanism; do not block all
library source work on STANDARD-1b/1c/1d. Keep conditional shared-tooling completion
visible in the program index instead of claiming the full standards work done.

### 5.4 Codex bump contract (BUMP-TOOL and FIRST-BUMP)

Owner: release tooling / Codex binding integrator. BUMP-TOOL is development-only,
source/registry inspection, with no binary execution or automatic activation:

1. Resolve the actual latest stable target at execution time, exact upstream tag
   and peeled commit, platform archive, npm integrity/provenance and binary hash.
   Preserve the currently qualified baseline; freshness alone is not admission.
2. Compare the consumed protocol/schema projection and deprecated/removed methods
   with the selected revision. Emit `data-only`, `protocol-change` or `refused`
   with the concrete diff; update the explicit revision only when validation
   changes, keeping golden vectors and strict effect/config/permission shapes.
3. Compute the disabled-feature set from the exact tag's default-enabled features.
   Every newly default-enabled feature is a review item; no copied stale deny
   list or hand-maintained unchecked second list. Derive launch/helper config and
   broker header expectations from the one verified release record.
4. Re-read upstream auth storage/mode/TokenData/get-token parity and refresh
   implementation: proactive window, startup refresh, 401 recovery, guarded reload,
   persist-in-place semantics, admitted account/read/config/model methods and
   bounded stdin-first shutdown. A change invalidating the accepted custody/write
   contract refuses activation; it does not silently broaden helper permissions.

FIRST-BUMP selects the reviewed release record only after the separately permitted
real disposable TEST run. Compare effective config/layers and startup warnings,
permissions/disabled features, protocol sequence and turn/effect receipts. Rehearse
near-expiry/far-from-expiry and delayed fake-authority refresh with the real pinned
helper under the exact sandbox, without real credentials; confirm in-place token
persistence before exit and the advertised bounded refusal/cleanup facts. Source
inspection, parser compatibility, mocks or an npm version alone do not prove it.
Preserve evidence for current/previous verified binaries and keep unknown tuples
closed. If a provider outcome is uncertain, reconcile the same run; never relaunch
the first-bump campaign automatically. A protocol-only bump does not invent a new
profile revision, change durable authority or require a program-wide refactor.

## 6. Slice cards and waves

| Card | Result | Starts after | Acceptance owner |
| --- | --- | --- | --- |
| S1-JSONL | Bounded byte decoder and framing consumer | CI-CONTRACT-1, library entry/classification successor | Library owner + consuming adapter |
| S1-NATIVE | Consumer-owned execution/byte port and adapter over native-owned keeper client; no local custody implementation | NATIVE-CONTRACT; fixture for TS development, pinned native artifacts for actual E2E | Runtime adapter owner; native team owns protocol/client/keeper/init |
| S1-CODEX | Session correlation and explicit protocol/turn entrypoints | JSONL; accepts a structural byte port, independent of process implementation | Protocol owner + independent fixture oracle |
| S2-ENGINE | Pure model/decisions, narrowed ports, format/profile split, G1/G2 and owner-loss projection | Governance classification; can develop apart from Host reserved files | Engine owner + retained store case suite |
| S2-STORE | Drizzle adapters, migrations/verify/open, conformance; Provider Access facade | Engine/owner ports; storage successor and test-support classification | Store owner; isolated Postgres fault/concurrency suite |
| S5-RELEASE | Product release record and narrow per-consumer inputs | Release-policy successor; no dependence on completed PA rewrite | Host owner; unknown hash refuses before effects |
| S3-SECURITY | New capability feature, recorded-limit settlement; adapter supplied by S2; part of the single S2 owner/storage checkpoint | S2 port/store contract plus P7b and generated registries; no intermediate owner rewrite | Security owner |
| S3-ACCESS | Single new access feature with capture and broker sub-features; keeper owns declared helper/broker processes | S1 mechanisms; N2; auth successor/NATIVE-AUTH; S2 ports/store; S5-RELEASE | Access owner |
| S4-EXECUTION | New execution parent with four sub-features and claim-gated bindings | S1 mechanisms; S2 ports; N2; S5-RELEASE | Execution owner |
| S5-STORAGE | Verified structural storage object in Host, no migrations/raw pool | S2 stores + S3 owners; P7b | Host/store integrator |
| S5-API | New runtime-host operations access, curated host exports, public outcome parity | S3/S4 and S5-STORAGE; N2 for nested operations; release selection | Host/API owner |
| OBS-ADOPT | Real AE summary producer, Host subscriber and scoped public live-summary view; Observation 0.1/resources 0.2, preserving acknowledged commands and durable queries | S2 summary seam; P7b/N2; land with S5-API and its scoped successor, not a second data migration | Execution/Host integrator; positive/rejecting ownership and lifecycle cases |
| BUMP-TOOL | Source/registry/schema/config comparison, no binary execution | S1 protocol + S5 release record | Release tooling owner |
| FIRST-BUMP | Latest verified stable Codex at execution time | Source/ABI/config review and previously required permission for real TEST run | Existing live-qualification contract |

Wave A: CI ownership/recovery coordination, rules/docs, actual release/pin
inspection, package interfaces and PUBLISH-NATIVE design. No runtime behavior.
Wave B: CI-CONTRACT-1, one Foundation/baseline adoption, registry generator,
P7-now completion, then P7a/P7b/N2 in their reserved-file write order.
Wave C: S1 libraries, S2 engine/stores and S5 release data can develop in
parallel with the consumer adoption lane. S1-CODEX does not wait for S1-NATIVE
because it borrows a structural channel. ACTIVE-SUPPORT proceeds per package
with its stated P7b/N2 reservations, rather than disappearing between the slices. Cutovers wait only for their row's
actual prerequisites, not the end of an unrelated wave.
Wave D: S3 security; nested access/execution; verified Host storage and API
cutovers with OBS-ADOPT's actual live-summary consumer. Release each
dependency-complete package as it becomes qualified. Pure libraries do not wait
for this subscription capability.
Wave E: final packed consumer, full current-head qualification, release tooling
and first live bump when its existing run authorization is satisfied.
The external native lane proceeds independently. S1-NATIVE/S3/S4 may qualify TS
mapping against its contract fixture, but Linux+Docker activation waits for the
real pinned keeper/client/init/image and the complete cross-lane E2E.

Reserved Get Modular files stay with P7a/P7b until that delivery completes:
Embedded Runtime Host roots/modules/groups, `ordinary-session-runtime`, Assembly
profile/evidence and relevant package barrels. S1/S2 may add packages and tests
before it, but do not land a competing Host assembly or edit its reserved files.
Shared registries/lockfile/workflows have one integrator per checkpoint. Existing
#230, #210 and #180 branches are neither adopted nor modified by this plan.

## 7. Fast feedback without repeated full checks

1. During editing use the changed package/risk suite plus `pnpm check:changed`.
   Use the documented `pnpm check:fast` before handoff. Do not add extra separate
   build/lint commands whose work is already included in the final required gate.
2. Regenerate mechanical inventories once for the candidate checkpoint; review
   that one diff. CI checks but never writes inventories. No hash edits one by one.
3. Full `pnpm check` and the complete required CI roster establish final-head
   evidence. Repeat only the phase invalidated by a fix; a changed head needs its
   affected checks. A changed workflow, contract or coverage route needs the
   corresponding full qualification. Never label an unrun or skipped check green.
4. Exact unchanged inputs may reuse evidence only under the repository's actual
   proof contract; do not rerun by habit or invent reuse after an input changed.
5. Target one coherent PR around 2,000 changed lines, separating explained test
   oracle moves/generated churn in the description. Do not enforce an arbitrary
   PR count per slice or cut an authority/data invariant in half. Prefer one
   completed vertical cutover to multiple registry-only intermediate PRs.
6. One meaningful final review; fixes get a delta review where sufficient.
   Follow current repository protection; optional reviewer quota is not a gate.
   Do not require a second person just because this is a plan.
7. Inspect the current branch rules and expected checks at execution time; v2's
   check-name list is historical. Required Postgres/macOS/publication checks stay.
8. Wait once with the existing command/session; do not launch another watcher or
   rerun an uncertain provider operation after an observation timeout.

Historical baseline, pin, P7 and source paths are evidence for comparison, not
magic constants every next implementation must recreate. A failed prerequisite
blocks its dependent cutover, not unrelated analysis or package work.

## 8. Data cutover, rollback and known limits

S2 owns the only persisted format/schema cutover. Never infer empty tables from
ordinary having no recorded live use. Nonempty legacy rows, grants, artifacts
or cleanup obligations make the automatic empty-schema path refuse without
mutation. A separately supported, exact tested disposition/migration must retain
them; a backup alone is not permission to delete live obligations.

New schema migrations use one session lock/client, immutable ordered migration
name/hash identity, explicit verification and no Host-constructor DDL. Consumers
never end the borrowed pool. Downgrade does not automatically regain authority
over v1 data. Stop new admission, reconcile/drain known work and revert only
code/data states whose compatibility was proven. Retain an incomplete-close
handle and evidence; do not erase uncertainty to permit a rollback.

The shared-login Codex refresh race and bounded-grace interruption risk remain
explicit accepted limits of decision 47. A turn's captured token is not refreshed
mid-turn. POSIX group cleanup does not prove containment; a Host SIGKILL can
leave a group. Unknown binaries/platform tuples remain unqualified. This program
does not make a general sandbox or silently enable Linux/Windows ordinary runs.
The explicit new native Linux+Docker target follows NATIVE-INTEGRATION; its
profile, credential route and receipt closure need their own successor/evidence.
Do not reinterpret legacy ordinary or contained records as that new profile.

## 9. Estimates and status

This plan is complete enough to assign the bounded cards above. Implementation
of S1-S5 has not been performed by this documentation delivery. Prerequisite
status comes from the snapshot, not from a computed completion percentage.

The October 15 drafts estimated, before reductions and newer shared deliveries:

| Scope | New production | Ported/new tests | Registries/decisions | Confidence |
| --- | --- | --- | --- | --- |
| S1 | 2.6-3.6k lines | 2.0-2.9k | 0.8-1.3k | 4/10 |
| S2 | 3.9-4.9k | 2.3-3.0k | 1.0-1.5k | 4/10 |
| S3-S5 | 4.0-5.4k | 3.7-5.2k | 1.1-2.1k | 4/10 |

These are historical gross authoring ranges, not measured remaining changed
LOC. Additions, deletions, oracle moves and generated churn are different
metrics. Do not add these columns and call the result logical production LOC.
The previous reduced envelope (21-33k changed lines, 40-75 agent-days) was also
an estimate, not a commitment; delivered shared tooling and the process rename
change its basis. Re-estimate a card only when its actual chosen contract is
known; do not block source work on a new program-wide counting exercise.

No owner answer is needed to complete this plan. External packages/adoption
lanes, nonempty legacy-data disposition and execution-time interactive/live
qualification requirements remain concrete implementation dependencies, not
unanswered architecture questions or new approval ceremonies.

### 9.1 Optional Get Modular capabilities: bounded cost estimates

The owner requested these estimates on October 20. They describe possible later
work, not selected runtime cards or new prerequisites. The rewrite already fixes
the expensive seams: capability/slot ownership, exact revisions, borrowed ports,
per-instance scopes, state versus occurrences and the future DTO/IPC boundary.
No factory-wide lifecycle or event envelope is reserved for hypothetical users.

These are estimates of **new handwritten lines**, excluding blank/comment lines,
generated output, lockfiles, existing reusable source and retained tests.
Production includes runtime types. Integration counts one real consumer adapter
and exports/profile/build/release tooling separately; tests include meaningful
new fixture code. Documentation is not production code. The ranges are not
measurements, elapsed-time commitments or a completion formula.

| Future capability / estimated scope | New production LOC | Integration/tooling LOC | New tests/fixtures LOC | Docs LOC | Confidence |
| --- | --- | --- | --- | --- | --- |
| Typed events: process-local, ephemeral, FIFO, synchronous listeners | 700-1,150 | 120-300 | 1,000-1,800 | 150-300 | 6/10 |
| Dynamic contributions: one typed extension point, plain metadata plus owned executable invocation | 850-1,400 | 180-350 | 1,300-2,300 | 200-350 | 5/10 |
| Dynamic plugin Host: one trusted cooperative in-process family, replacement/drain/recovery | 1,400-2,300 | 300-600 | 1,900-3,500 | 250-450 | 4/10 |

Basis: current Assembly/resources/Observation source and the private
[lifecycle-kernel candidate](https://github.com/agent-teams-ai/get-modular/blob/077434e34d75506a610bc9271f8b5b9d5718c876/packages/lifecycle-kernel/README.md),
plus the existing
[TEST Host](https://github.com/agent-teams-ai/modularity-host-test/tree/d0ccb3ee5ceee0f6657c68a68ee39fb87ae5c8cc/src/host).
The TEST Host admission/inventory/lifetime/replacement/recovery subset contains
about 1,915 nonblank/noncomment lines, useful as semantic reference and behavioral
oracles. It is not a released production Host. Reused source is not charged again
as new LOC, but production adoption/qualification is still required. Do not add
the three estimates as if their shared integration were three independent jobs.

- **Events:** select only for concrete independent reactors that must distinguish
  every occurrence. The estimate includes a typed source/read-only facet,
  immutable payloads, finite count/byte bounds, explicit overflow refusal,
  per-source FIFO without coalescing, scope-owned subscriptions, listener-error
  isolation and close/drain accounting. Define membership at emission and removal
  during queued delivery. Acceptance into memory does not acknowledge a listener
  or promise survival of close/crash; no replay, retry or interprocess delivery.
  Test duplicate payload occurrences, order/overflow, detach during delivery,
  throwing siblings and retained cleanup. Current journal/output contracts stay
  authoritative. Crash survival, subscriber acknowledgement and durable replay
  would add roughly 3-6k production, 0.6-1.2k integration and 4-8k test lines for
  one chosen storage/transport; that is a separate owner delivery subsystem.
- **Contributions:** select when a real extension point must change membership
  without rebuilding its prepared Host. The estimate includes named identities,
  explicit deterministic order, duplicate/partial-registration refusal, finite
  inventories and contributor-scope cleanup. Observation can publish **plain
  metadata only**; it rejects functions/class instances/Map, so executable ports
  never live in its store. A separate typed acquisition/invocation facade retains
  calls. Removal immediately fences new calls, drains held work before release
  and cannot revive a stale handle when the same display ID is registered again.
  Test add/remove races, explicit ordering, stale generation/handle, retained
  invocation and failed cleanup. `many()` stays static and the compiled graph
  stays immutable; no generic lookup registry. Data-only contributions without
  executable calls/drain reduce the mechanism to about 350-650 production lines.
- **Plugin Host:** select when enabling/disabling/replacing one plugin family
  without a Host restart has a concrete product use. The estimate includes inert
  whole-selection validation before imports, attempt custody, candidate readiness,
  single-flight replacement and atomic routing, typed call admission/rechecks,
  quiesce/drain/retire/close and retained recovery. Test failed candidate preserving
  the old route, retirement across await, late acquisition and cleanup retry.
  Use shared mechanisms rather than modifying Core/Assembly into a manager; the
  private kernel requires explicit qualification/adoption or release if selected.
  Trusted code can still perform arbitrary JavaScript effects: this is not a
  security boundary or ESM unloading. Artifact distribution/signatures, OS sandbox,
  cross-process RPC and persisted generation recovery are excluded. Full terminal
  streams can add 400-800 production and 600-1,100 test lines if existing TEST
  blocks cannot be reused. One selected isolated backend with an existing trusted
  artifact-admission system can add 3-6k production, 0.7-1.5k integration and 4-8k
  test lines; building trust/distribution/OS containment is not included or
  credibly priced without that actual product scope.

The material future product choices are delivery persistence/acknowledgement,
data-only versus executable contributions, and trusted versus isolated plugins.
Resolve them with the first selected consumer, then re-estimate that card.
None is an unanswered requirement of the current rewrite; no owner answer is
needed to continue it. Before adding one, verify its current package/API state
again and update the owning scoped standard/adoption rather than implementing
a consumer-local copy of a shared module mechanism.

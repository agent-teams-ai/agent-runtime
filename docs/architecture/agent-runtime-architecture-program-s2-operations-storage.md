---
id: runtime.architecture.architecture-program-s2
type: architecture
status: active
owner: architecture
summary: Implementation brief for provider-neutral operations and PostgreSQL storage in architecture program version 3.
---

# Architecture program v3: S2 operations and storage

This is the active planning brief, not an implementation or qualification receipt.
Its repository home is this indexed S2 brief.
The program rewrites ordinary execution inside this repository by bounded slices,
ports valuable existing behavioral tests first, and switches consumers when the replacement works.
Contained-turn remains frozen permanently; its eventual removal is never a dependency.
Breaking 0.x APIs are allowed, with migration notes; persisted data and recovery obligations remain protected.

## Scope and decisions

S2 delivers all three libraries: public `@agent-teams/ordinary-operations`, public
`@agent-teams/runtime-store-postgres`, and private `@agent-teams/runtime-storage-conformance`.
It includes the S3-SECURITY owner responsibility in the same storage/owner activation
checkpoint and cuts over ordinary Host storage. S3 describes that owner feature once;
there is no intermediate security rewrite followed by a second capability-feature rewrite.
It absorbs STORE-0, STORE-1a, STORE-2-core/execution/security/access, ENGINE-0/1,
the storage portion of STORE-3, VERSION-1 format work, OWNER-LOSS and GAP-G2 port work.
Provider Access grant persistence ships in the first complete store release.
Provider auth capture/broker redesign belongs to S3, execution bindings to S4,
and public Host/API restructuring to S5. Their forced port adaptations land with S2 cutover.

Follow the [native-team ownership contract](agent-runtime-architecture-program-plan.md#native-team-coordination-contract-native-integration).
The engine/store remain TypeScript and independent of keeper wire DTOs. S1/S4
implement the consumer-owned execution port over the native-owned generic client;
S2 never introduces a Docker wrapper, native inventory journal or TS custodian.
Persist only the owner-reviewed operation-to-native-attempt/recovery reference
needed for reconciliation, with exact immutable profile/attempt identity. The
native resource journal remains native-owned, not mirrored as a second authority.
Allocate the opaque native correlation key once and persist it in the acknowledged
operation before any attempt-owned native acquisition/helper/broker launch. Include
it in subsequent preparation/claim digests; stable child-purpose keys are known
before requests. Returned native handles do not replace this durable lookup key.
No replay/new candidate allocates another native attempt without owned admission;
the internally generated correlation key is not part of the caller's command
fingerprint. Native enforces exclusive live-owner versus cleanup-recovery custody
through its client; uncertain exclusion leaves debt and never permits cleanup of
another live attempt. S2 records references/outcomes, not a second native lock.
Native acceptance, lost acknowledgement, program exit, stream EOF/delivery,
container absence and complete inventory cleanup are different facts. Unknown
DB claim never authorizes workload execution; query of an already admitted native attempt
cannot authorize another launch. Native cleanup-only recovery never decides a
provider retry or operation outcome. The new Linux+Docker receipt/profile/codec
successor must be explicit before activation: do not map container absence to
the old `process_group_closed` receipt or reinterpret Darwin/contained records.
Develop S2 against the shared contract fixture while artifacts are pending;
only the native-dependent profile cutover requires real native E2E.

The three former S2 questions are resolved:

- Host receives verified owner capabilities, never a pool or a Postgres adapter class.
- Ordinary tables use `ordinary_execution`, `ordinary_security` and `ordinary_provider_access`.
  Permanent contained schemas and materialization objects retain their existing owner.
- Preserve each valuable #231 behavioral assertion while adapting calls to narrowed ports.
  Byte-identical copying is not an acceptance requirement for an intentional contract change.

The superseded S3/S5 draft's Host `pool` branch and TODO until CONTAINED-REMOVAL are replaced.
Provider Access owns the shared materialization factory and its permanent typed adapter.
Storage composition calls that factory over the same borrowed pool as the grant adapters.
This is a real ownership boundary with ongoing tests, not a compatibility shim awaiting deletion.
No additional database implementation, event framework, manager or plugin system is in scope.

## Verified baseline and authority

All Agent Runtime paths in this brief refer to commit
`efd3348f361fa6af84953325af5c0d2d8677d14a`, abbreviated **AR** below.
A citation `R1:71` means the exact source path@SHA in the source ledger, line 71.
The older 2026-10-15 draft's `2fda5ffd` measurements and storage probes are historical evidence.
They do not establish current source counts, installed Drizzle behavior or production qualification.
Current source inspection for this brief was read-only; no tests, installs or migrations were run.

The organization Engineering Quality Standard governs deliberate library evolution and data safety.
The current Get Modular document was inspected at
`3dd68a6b26f42159714a4640b613534a55c2c6aa` (**GM**).
AR's consumer profile still pins CMS commit `81063add7de50ffe2b91cc74bf7271b298624c21`
and document SHA-256 `49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`.
Planning against current guidance does not silently advance that consumer pin.
The owning Get Modular adoption change must review the complete pin delta and enforce its scope.

Current guidance requires own function properties, narrow declared inputs, per-run resources,
flat composition files, mirrored tests, and explicit contract revision changes.
It forbids application/domain imports of contracts and Get Modular outside composition/tests.
Configuration and release facts enter factories as immutable snapshots; the factory does not watch
configuration, wait for a sibling's future or emit an operation notification during construction.
Module communication follows calls by default, one writer, explicit upward command/signal ports,
and subscriber-owned lifetimes. The released Observation package does not gate
pure S2 engine/store work; its selected live-summary adapter lands with OBS-ADOPT.

| Source | Verified behavior or gap |
| --- | --- |
| R1:16-20,71-99 | Unqualified legacy table, unique scoped command, CAS, unknown-accept readback inside adapter; G1 missing |
| R1:103-119 | Prepare checks time before acquiring row lock; claim acknowledges ownership or returns unknown |
| R2:33-39,83-99 | Terminal readback never grants launch; unknown claim never launches |
| R2:120-187,257-269 | Physical cleanup, durable settlement and retryable disposal debt are distinct |
| R3:14-31,45-81 | Host storage type derives from Postgres; factory construction migrates three owners |
| R4:14-34 | Provider grant port already exists, one-shot consume and selective owner readback are explicit |
| R5:57-116 | PA transactions verify schema; row lock, database expiry window and request counter transitions |
| R6:4-63 | PA grants/requests, immutable identity triggers, ordinary registry component and migration lock |
| R7:71-115,143-147,189-193,226-253 | Port owner, grant-before-materialization, retire/settle readback, mixed pool composition |
| R8:30-56 | Shared materialization owns only `pa-m1`; migration has its own existing advisory lock |
| R9:26-80; R10:100-128 | Security owner readback, stored policy equality and guard limits currently coupled to current policy |
| R11:11-48 | Failed preparation retains root and adapter state but returns no cleanup-only handle to engine |
| R12:1-192 | Fifteen independent store cases use whole aggregates and request a byte-identical move |
| R13:6-16,24-41,51-74 | PostgreSQL gate has exact file/name obligations and disposable socket allowlist |
| R14:23-38 | Product evidence still contains a six-package literal and eight shard identities |

A fresh raw-line census at AR (approximate counted LOC excludes blank/comment-only lines):

| Bounded implementation set | Files | Raw / counted LOC |
| --- | ---: | ---: |
| AE engine, ports, model, validation, store, codec, factory | 7 | 763 / 735 |
| RS owner, grant port, policy, store, runner, factory | 6 | 359 / 326 |
| PA grant port/store/schema and mixed owner composition | 4 | 466 / 423 |
| ER Host, assembly and owner ACL | 3 | 237 / 228 |

This census excludes the remaining PA domain/contracts and shared materialization, which stay owned there.
It is a scope measurement, not a deletion total: ports/owners are replaced or adapted at their slice seam.
The ordinary model imports contained authority/kernel types and ordinary validation/codec
import contained canonical primitives. S2 gives ordinary its own owned primitives with golden vectors.
Contained retains its copies and tests. Shared materialization is intentionally still active.
Permanent freeze is not permission to disable its relevant tests or alter its durable format.

## Package graph and public surfaces

```text
ordinary-operations -> no database, Host, provider or Get Modular runtime dependency
runtime-security -> owner domain and grant ports; never store/conformance
provider-access -> owner domain, grant/materialization ports; never store/conformance
runtime-store-postgres -> ordinary-operations + runtime-security + provider-access + drizzle-orm + pg
runtime-storage-conformance -> three owner public implementer surfaces (test support only)
agent-execution -> ordinary-operations (implements workspace/process/provider ports)
embedded-runtime -> ordinary-operations + owner capabilities (composition)
store/Host test runners -> runtime-storage-conformance (dev only)
```

Both public libraries live under `packages/platform/` and expose `.` and `./composition`.
`.` is the curated consumer contract; `./composition` exposes factories and explicit implementer types.
Public entrypoints never expose Drizzle inferred types, query builders or internal paths.
Host storage contracts belong to Host composition and refer to owner ports, not the store package.
The store package implements that structural shape without depending on Embedded Runtime.
The adapter is a supported concrete Postgres choice; the core's storage agnosticism is a dependency rule.
It does not claim databases are interchangeable or require speculative stores.

The private conformance package is test support, including its reusable fakes and oracle parts.
Its tests mirror feature paths; it is never a public package or production dependency.
Current local workspace checking assumes every package under reviewed containers is a production module.
The governance prerequisite must admit an exact governed test-support package/root and export,
with negative fixtures rejecting production imports. Do not manufacture domain/application layers
for fakes just to satisfy the old checker, or exclude the package from dependency governance.
Conformance depends on owners; owners do not devDepend back on conformance.
Joined owner+store tests run from the adapter/conformance/Host test roots to avoid a build graph cycle.

Minimal target layout (only directories containing real files are created):

```text
packages/platform/ordinary-operations/
  package.json  tsconfig.json  README.md
  src/index.ts  src/composition.ts
  src/features/operation-lifecycle/
    README.md  index.ts  internal.ts
    contracts/operations-api.ts  operations-error.ts
    domain/operation-model.ts  operation-profile.ts  operation-view.ts
    domain/canonical-value.ts  digest-preimage.ts  command-fingerprint.ts  text-limits.ts
    domain/input-validation.ts  operation-validation.ts  receipt-validation.ts
    domain/operation-codec.ts  accept-decisions.ts  transition-decisions.ts
    domain/row-identity.ts  terminal-status.ts  cleanup-order.ts
    application/ports/operation-store.ts  authority-grants.ts  execution-bindings.ts
    application/ports/runtime-clock.ts  operation-signals.ts  digest.ts
    application/models/flight-registry.ts
    application/policies/authority-deadline.ts  cancellation-watch.ts
    application/use-cases/submit-operation.ts  observe-operation.ts  cancel-operation.ts
    application/use-cases/acquire-authorities.ts  prepare-dispatch.ts  claim-dispatch.ts
    application/use-cases/execute-provider-turn.ts  close-flight.ts  dispose-operations.ts
    adapters/outbound/node-digest.ts
    composition/create-operations.ts
  tests/features/operation-lifecycle/*.test.ts
  tests/package/public-surface.test.ts
packages/platform/runtime-store-postgres/
  package.json  tsconfig.json  README.md
  src/index.ts  src/composition.ts
  src/features/postgres-storage/
    README.md  index.ts  internal.ts
    contracts/storage-api.ts  storage-error.ts
    domain/journal-verification.ts
    adapters/outbound/runtime/transaction-runner.ts  sanitized-error.ts  advisory-lock.ts
    adapters/outbound/migrations/migration-runner.ts  journal-reader.ts  legacy-guard.ts
    adapters/outbound/operations/operation-table.ts  operation-row.ts  operation-store.ts
    adapters/outbound/security/grant-table.ts  grant-row.ts  grant-store.ts
    adapters/outbound/provider-access/grant-tables.ts  grant-row.ts  grant-store.ts
    composition/open-postgres-storage.ts  migrate-postgres-storage.ts  verify-postgres-storage.ts
  migrations/{execution,security,provider-access}/<ordered-name>/migration.sql
  scripts/drizzle-{execution,security,provider-access}.config.ts
  tests/features/postgres-storage/{transaction-runner,journal-verification,sanitized-error}.test.ts
  tests/features/postgres-storage/storage.postgres.test.ts
  tests/package/{declaration-surface,packed-migrations}.test.ts
packages/platform/runtime-storage-conformance/
  package.json  tsconfig.json  README.md
  testing.ts
  tests/features/storage-conformance/{operation,security,provider-access}-store-cases.ts
  tests/features/storage-conformance/{operation,security,provider-access}-store-fake.ts
  tests/features/storage-conformance/fixtures.ts  disposable-database.ts  suites.test.ts
packages/contexts/runtime-security/src/features/operation-security/
  README.md  index.ts  internal.ts
  contracts/security-grant-api.ts
  domain/grant-record.ts  grant-identity.ts  grant-decisions.ts  secret-guard.ts
  domain/record-codec.ts  exact-record.ts
  application/ports/grant-store.ts  grant-runtime.ts
  application/models/grant-registry.ts
  application/use-cases/resolve-and-consume-grant.ts  observe-grant.ts  settle-grant.ts
  application/use-cases/register-secrets.ts  dispose-grants.ts
  composition/create-security-owner.ts
```

The conformance `testing.ts` is private workspace test support, not a new public SDK subpath.
Its compiler includes the mirrored test-support sources; packaging never becomes a runtime edge.
After N2 adopts FMS v1.1, new PA/AE capability features use their accepted nested parent/child layout.
Real independently owned store children may nest under postgres-storage when that boundary exists.
Do not pre-split table/row helpers into graph nodes or force a restructuring before the pin migration.
Each feature card records purpose, parent, publishes, consumes, modules, growth and split signals.
The engine has nine cohesive use cases and one operation aggregate; no new Assembly nodes are required.

## Operations contracts and decisions

Ports use function-typed readonly properties; no `ReturnType` or `Parameters` contract inference.
Domain decisions take current data and explicit `{now, newId}` and return `write | keep | reject`.
The adapter locks, samples time after the lock, invokes the decision and conditionally writes.
Domain/application never import pg, Drizzle, filesystem, provider DTOs or contained modules.
Use cases export one function `(deps, input) => result` with the smallest cohesive dependency record.
Limits remain 300 counted lines/file, 60/function, four parameters and 80/module wiring file.

```ts
interface OperationStore {
  readonly insertIfAbsent: (candidate: Operation) => Promise<InsertOutcome>;
  readonly read: (ref: OperationRef) => Promise<Operation | undefined>;
  readonly prepare: (ref: OperationRef, revision: number, preparation: Preparation) => Promise<Transition>;
  readonly claim: (ref: OperationRef, revision: number) => Promise<ClaimOutcome>;
  readonly cancel: (ref: OperationRef) => Promise<Operation | undefined>;
  readonly append: (ref: OperationRef, attemptId: string, output: OutputChunk) => Promise<Transition>;
  readonly finish: (ref: OperationRef, attemptId: string, receipts: readonly Receipt[]) => Promise<Transition>;
  readonly reconcile: (ref: OperationRef, attemptId: string, receipts: readonly Receipt[]) => Promise<Transition>;
}
// InsertOutcome: inserted | existing; existing includes the persisted operation.
// Transition: applied | unchanged | rejected(reason). ClaimOutcome: claimed | not_claimed | unknown.
```

The engine creates the candidate, compares an existing command fingerprint, and owns duplicate/conflict policy.
`insertIfAbsent` uniqueness is `(tenant, project, commandId)`, not candidate operation ID.
A read by candidate ref after unknown acceptance can only establish that candidate's durable identity.
Positive readback returns observation/duplicate, never a right to run; missing/failed readback is potential acceptance.
A collision with a different existing candidate must not be reported as a proved rejection or dispatch ownership.
No acceptance, claim or mutation is retried automatically by the adapter.

Prepare/claim require the caller's expected revision. Cancel/append/finish/reconcile operate on the locked
current row; append and terminal additionally require matching attempt identity.
Every operation returned by any path validates key columns, commandId and revision against decoded payload (G1).
Writes use locked row keys and a previous revision predicate; affected row count must be exactly one.
Caller mutation cannot alter persisted data or decoded/frozen snapshots.
Claim receipt binds preparation digest, reservation, attempt and committed revision.
Preparation and claim retain the authority deadline window: beyond now+10 s, no later than now+60 s.
Both checks run after acquiring the row lock, closing the current pre-lock prepare timing gap.

`submit-operation` validates and accepts; only acknowledged inserted ownership creates a local flight.
`prepare-dispatch` acquires authorities, workspace, credentials and reservation before durable preparation.
Preparation helper/broker launches have their own bounded PA/RS authorization,
purpose key and deadline. They may precede dispatch claim, but cannot execute the
workload; otherwise credentials-before-claim and helper-after-claim would deadlock.
`claim-dispatch` checks selected provider release against recorded preparation immediately before claim.
`execute-provider-turn` launches only after acknowledged claim and admits output before durable append.
`close-flight` closes process/drain, snapshots/admission/publish, retires credentials, settles owners,
and removes workspace only when closure is truthful and uncertainty is absent.
`dispose-operations` closes admission, durably cancels owned work, joins it and retries retained cleanup debts.
Observe and cancel remain available through their narrow facade and return discriminated results.

## Durable format, owner loss and G2

Format v1 is an exact envelope `{format: "ordinary.operation/1", payload, digest}` with 8 MiB budget.
Digest input is canonical ordinary-owned data; text persistence preserves exact codec bytes.
Binding records profile identity/revision separately from concrete provider release.
Preparation includes the bounded release ID, included in the claim's preparation digest.
Provider terminal references use neutral `sessionRef`/`turnRef`; the adapter maps provider vocabulary.
Operation adds epoch-ms `acceptedAt`; receipt union adds `workspace_retained {workspaceId}`.
The retained Darwin receipt set grows from nine to ten; this is not the native
profile's universal cap or kind union. Before native-dependent codec/adapter
freeze, AE/RS/PA/Host accept that profile's own finite required-kind set, cap,
typed facts and closed codec/validation/digest mapping. Unknown profile/kind or
missing required evidence rejects; do not loosen the Darwin validator globally
or manufacture `process_group_closed` from native container absence. Runtime
terminalization for this profile waits for all required authority/output/resource facts; old
vectors and records retain their exact semantics. Immutable per-kind merging
stays strict within each selected profile.
Golden vectors pin canonical SHA-256, command fingerprint, preparation digest and full envelope.

Security reads compare durable identity fields and validate recorded policy integrity, rather than require
byte equality with today's numeric limits. Consumed guards and settlement use the record's limits.
New grant admission still uses the current trusted policy snapshot; it cannot rewrite an old grant's policy.
No secret inventory enters state text, snapshots, SQL errors or journal observations.
Canonical serialization/preimage construction stays pure in domain. SHA-256 is supplied
through the application digest port and Node adapter; do not import node:crypto into
domain/application or write a second handwritten SHA implementation to satisfy layering.
The row adapter verifies the exact serialized bytes before handing a validated record inward.
Profile revisions are explicit owner identities mapped at Host ACL; do not equate CMS descriptor revision,
profile revision, durable envelope version, provider release and npm package SemVer.

Owner loss is a conservative read projection, not a lease or proof of remote process death.
An unowned local nonterminal record past its bound projects `reconcile_required`, reason `owner_lost`.
Unprepared bound is `acceptedAt + 120000 ms` (chosen policy, not an existing measured constant).
Prepared bound is the recorded earliest authority expiry; local owned flights are never projected lost.
Observation and duplicate paths apply the same rule without writes, auto-claim or relaunch.
A remote flight may still be closing: the projection never authorizes cleanup of its resources.
Terminal records retain their actual durable status. Clock effects are covered with deterministic tests.

Workspace prepare returns `prepared` or `retained {workspaceId, release}`.
The retained `release` is cleanup-only: release adapter memory/handles, retain directory bytes.
Engine records `workspace_retained` and requests reconciliation; it never snapshots, launches or deletes it.
If persistence is unavailable, retain the cleanup capability and safe journal identity as unresolved debt.
Releasing memory is not evidence that the durable receipt committed; final reporting keeps both facts.
S4 updates the filesystem adapter when this contract changes, in the same cutover delivery.

## Transaction outcomes and readback ownership

Errors carry stable `code` and static `is(value)` checks; callers never parse messages.
Semantic refusal is a typed rejected result or owner denial, not a database availability error.
Sanitized storage errors retain owner, safe phase and allowlisted SQLSTATE only, with no raw cause.

| Mutation | Unknown commit handling | Owner response |
| --- | --- | --- |
| Operation insert | throw commit-unknown | one candidate read; observation or potential acceptance; never dispatch |
| Operation claim | return unknown | never launch; read only to establish settlement disposition |
| Prepare/cancel/append | throw commit-unknown | stop flight effects, attempt physical cleanup, preserve reconciliation debt |
| Finish/reconcile | throw commit-unknown | one read may prove terminal outcome; no relaunch; bounded explicit reconciliation uses current row |
| Security insert/settle | throw commit-unknown/unavailable | one observe; accept only matching identity and requested disposition |
| PA insertGrant | throw | refuse and retire capture; no second grant and no readback granting consumption |
| PA retire/settle | throw | one observe may establish requested already-retired/settled fact |
| PA begin/endRequest | throw | broker closes admission; no request replay |

The terminal fallback may explicitly write reconciliation after a nonterminal read, as R2:33-39 does.
This is not a blind retry of finish, receipt regeneration or new dispatch.
Any readback failure remains uncertainty. A domain denial never triggers readback as an availability fallback.
PA insert stays one-shot forever even after settlement. Retire waits for all started requests to end;
settlement requires retirement; request sequence is monotonic, one in flight, at most 64, unique body digest.
Security repeat consume is the same grant only within TTL and before settlement.

Drizzle is the concrete query/table adapter, not the transaction or domain authority.
Use one real `PoolClient`: manual BEGIN, timeout configuration, journal check, body, manual COMMIT.
Any failure once COMMIT was sent is conservatively unknown; discard that client without replay.
Before COMMIT, roll back; discard when rollback cannot be proved. Release each client once.
Bound acquisition, query, lock and idle time; late acquisition releases its client without running the body.
Storage close prevents new work, aborts/discards active clients and returns cleanup facts without ending the pool.
A borrowed pool never receives `end()`. Retain pending physical cleanup facts instead of force-exit success.

Carry current owner budgets into typed runner policy: execution 5 s acquisition/query/statement,
3 s lock and 10 s idle; security 10 s total, 5 s query/statement, 3 s lock (new) and 10 s idle;
PA 1 s acquisition, 2 s statement and 4 s transaction. These are adapter deadlines, not clock-derived permissions.
Reads are bounded and verify the expected journal identity too, including cancellation polling.
Runtime role cannot mutate journals or DDL; journal trust does not prove catalog integrity against an administrator.
Full open verification checks exact ordered migration names/hashes; transaction checks detect journal-head drift.
Catalog tests independently assert actual constraints, indexes and triggers rather than trust generated metadata.

## Drizzle selection and storage composition

Official npm metadata read on 2026-10-19 reports `drizzle-orm` stable/latest `0.45.4`,
`drizzle-kit` stable/latest `0.31.11`, and both `rc` tags `1.0.0-rc.4`.
`rc5` still names a hash prerelease. `pg` latest is `8.23.1`.
S2 retains exact `1.0.0-rc.4` for ORM and kit as the explicitly selected, historically probed candidate,
not as a claim that it is latest/stable. First adapter implementation verifies those exact artifacts
against the current Node 26.11.1 and Node 24.21.0 contracts and pg 8.23.1.
Any version change replaces those facts and rechecks the affected adapter contract; no floating rc tags.
The historical report demonstrates rc.4 risks: COMMIT ambiguity, missing migration lock/hash checks,
parameter-bearing error messages, query `(config, values)` behavior and declaration failures.
Keep the six adaptations: manual transactions, locked verified migrations, sanitized errors,
real-client parameter forwarding, package-local declaration workaround if still needed, text state.
A declaration test rejects Drizzle imports/types escaping the public library surface.
Do not assume `skipLibCheck` fixes consumer declarations or make it repository-wide.

```ts
openPostgresStorage({pool, policy}, signal?): Promise<PostgresStorage>;
migratePostgresStorage({pool}, signal?): Promise<MigrationReport>;
verifyPostgresStorage({pool}, signal?): Promise<VerifyOutcome>;
// PostgresStorage: operations, security, providerAccess:{grants,materialization}, close.
// Returned capabilities are usable only after full verification; open never migrates.
```

Migration/verify/close outcomes are discriminated facts with safe owner/reason fields.
Cancellation is last in these adapter APIs; durable mutations remain bounded transactions.
The embedder owns storage lifetime. Host borrows only ports, registers no storage cleanup,
and never closes storage on construction failure, disposal or cancellation.
Storage close follows completed Host disposal; incomplete Host cleanup retains storage for retries.
A Host using independently verified fake capabilities is valid; it need not emulate a pg pool.
Public host options do not refer to PostgresStorage or require its class/brand identity.

Provider Access exports `createPostgresOrdinaryPaMaterialization({pool})` in its composition surface.
It owns factory, shared schema verification/migration, and per-operation materialization lifetime.
Storage composes its `stores`, `verify`, `migrate`, `close` over the same borrowed pool.
Per-operation owners are drained by Provider Access before storage close; close never closes the pool.
The shared factory preserves `pa-m1`, schema digest and rendering/authorization semantics.
Any mapping into S3's `credential-materialization` port lives with Provider Access, is explicitly typed,
and maps refusal to its owner error. Host does not import materialization repository implementation.
The old `createPostgresOrdinaryProviderAccessOwner` mixed grant/pool branch is replaced at cutover.

The Host module's dependencies remain declared owner ports plus immutable configuration snapshot.
An explicit `OperationSignals` port carries accepted/revision/terminal facts upward after acknowledged state.
It is passed as a typed run input/declared dependency; no captured global bus or implicit parent.
The Host adapts it to its journal command; journal failure follows the existing evidence failure policy.
Signals do not authorize state mutation, acquire dispatch ownership or turn unknown commit into success.
Factories never emit them. Optional caller `onAccepted` retains its exact existing
failure semantics. In the ordinary baseline, its throw on a newly owned submission
cancels durably and aborts, while a duplicate callback throw is ignored. Do not
replace either path with a deferred subscriber or unify it with frozen contained
callback handling.

OBS-ADOPT adds an owner-local plain summary publication port, separate from the
acknowledged journal command and critical caller callback. It carries only the
operation identity, durable revision and confirmed status after a successful
owner transition; reuse one pure summary mapper. Domain/application and storage
code import no Get Modular types. The outer composition adapter owns the store
writer and publishes that aggregate; the Host consumes its read-only contract.
Guard publication by the durable operation revision: lower is ignored, equal
matching data is a no-op and equal conflicting data is reported without a write.
Independent commit acknowledgements arriving out of order cannot regress status.
An unknown commit retains uncertainty and permits no confirmed success or new
dispatch. A failed projection is reported safely, never compensated by cancelling,
retrying or rolling back an already acknowledged command. No journal, SQL mutation,
grant, process launch or raw output becomes `watch`/`load` delivery. Durable
`observe` remains authoritative; the new view covers only locally owned live work.
The main plan's OBS-ADOPT contract and S5 define scope, admission and disposal.

## Migration and recovery contract

Each ordinary owner gets a schema, immutable migration directory, journal and migration lock.
No cross-owner foreign keys. PA grants/requests retain their same-owner FK and immutability triggers.
Baseline uses explicit CREATE, not IF NOT EXISTS that silently adopts an unknown table shape.
Custom migrations own trigger SQL; generated snapshots are review artifacts, not independent authority.
Released migration bytes never regenerate in place. Pending owner migrations apply transactionally.
A later owner's failure does not undo an already committed earlier owner: reports retain partial progress.
Shared materialization migration is Provider Access's own operation with its existing lock and journal.
Do not claim one all-owner atomic transaction across independently owned migration runners.

Choose a documented two-key advisory-lock namespace for ordinary migration owners, disjoint from
existing single-key contained/materialization locks; reserve the exact integers in code and tests.
Use one dedicated client per migration lock, bounded acquisition and lock wait, unlock in finally.
Discard if unlock fails. Before applying, verify the journal is an exact expected prefix;
a missing suffix is pending work, while extra/changed/out-of-order history refuses. Require full equality afterward.
The historical rc.4 migrator must run on that same client under the owned lock; never double-BEGIN it.
Newer history, missing entries and changed hashes produce explicit fail-closed outcomes.
A lost migration COMMIT acknowledgment requires read-only journal/catalog reconciliation, never blind rerun.

A whole-cutover preflight inspects all legacy owners before the first empty-table cleanup.
Find exact legacy operation/security table names across every namespace, independent of search_path.
PA legacy tables are specifically `provider_access.ordinary_grant` and `ordinary_request`.
Lock discovered tables while checking rows; quote identifiers and reject unknown dependencies/shapes.
A populated table produces `legacy_data_present`, leaves rows untouched and stops activation.
No `CASCADE`, blind DROP, truncation or test-only override belongs to the migration API.
Empty cleanup drops only verified legacy ordinary tables/functions and component `ordinary-pa-v1`.
Never change `pa-m1`, materialization receipts/owners, contained fences or contained migration history.
A same-name unrelated table is a refusal, not permission to delete it.

The first migrator supports fresh/empty ordinary installations and refuses every populated legacy case.
This restriction is explicit product behavior, not a proposed operator permission gate.
For a populated installation, retain exact legacy state, journals/evidence, workspace/artifact references,
the pinned readable release and a verified restorable backup. Its ordinary path stays on that release.
Drain/reconcile existing obligations there; ordinary activation on the new path remains refused while rows exist.
Do not tell an operator to delete rows to satisfy the guard, copy to a new database and replay command IDs,
or mark nonterminal work terminal because it was archived, expired or copied.
No automatic v3-to-v1 conversion, fabricated acceptedAt, receipt authority or release evidence is promised.
A later populated-data migration must preserve command identities/idempotency and implement retained read/recovery
before it can replace this explicit refusal; it is not silently included in the empty-baseline migration.
The shipping runbook rehearses backup/restore and this refusal path, so old data/recovery remain usable.
If actual deployment evidence proves ordinary tables empty, the standard empty cutover proceeds immediately.

Cutover order: close old ordinary admission, drain or retain unresolved recovery, prove old writers stopped,
verify legacy tables empty without deleting retained data, run migrations, open verified storage,
construct new Host, admit operations. Populated legacy data follows the retained-release path above.
Database/runtime permissions must prevent a stale old binary from recreating or writing old ordinary tables.
Removing the PA registry alone is insufficient: R1 and security currently recreate unqualified tables.
Apply ordinary-only writer fencing without disturbing permanently retained contained access.
For a shared old role, separate new/old ordinary credentials or keep old executable stopped under deployment custody;
do not revoke a contained role or pretend advisory migration locks fence legacy runtime writers.
Rollback before any new accepted operation restores the retained release/data under that same writer fence.
After new writes, do not downgrade into unaware code: stop admission, retain both datasets and repair forward,
or use a rehearsed data-preserving restore with explicit reconciliation of effects since the restore point.
Publication and API break allowance never authorize data erasure or replay of uncertain work.

## Tests first and acceptance

Port existing behavior before the replacement implementation, then add focused rejecting cases.
A store-only suite no longer owns command-conflict policy: expose a test harness facade combining
new candidate/accept decisions with the narrowed store so the original observable assertions stay meaningful.
Run low-level mechanical CAS tests directly against the store; do not weaken assertions to match a mock.
Shared decision helpers may build fakes, but expected results remain independent outcome tables.

| Existing oracle at AR | Target and preservation rule |
| --- | --- |
| AE `tests/features/contained-agent-turn/ordinary-core.test.ts` | operation-lifecycle codec, submit/flight/close/cancel/dispose suites; retain behavior; record deliberate v1 field changes |
| AE `ordinary-core-postgres.test.ts` | adapter storage.postgres subtests plus bounded runner fault cases; restart, scope and pool borrowing retained |
| ER support `ordinary-store-cases.ts` | private mirrored operation cases; preserve 15 case identities/assertions via narrowed-port harness |
| ER fake and store contract runners | rebuild fake from decisions; runners keep distinct fake/Postgres evidence |
| RS `ordinary-security-grant-{owner,policy,store,transactions}.test.ts` and `ordinary-security-postgres.test.ts` | fresh feature owner/policy suites plus conformance/adapter integration; recorded-policy compatibility intentionally changes |
| PA `ordinary-pa-{grant-decisions,owner-port,owner-races,owner-disposal,postgres}.test.ts` | keep owner tests; adapter tests cover grant SQL and joined real materialization |
| AE `ordinary-composed.test.ts` | stays as real execution-binding integration; import replacement engine |
| ER `tests/package/ordinary-{runtime-assembly,host-disposal}.test.ts` | borrow storage, failure custody, owners-before-journal and no construction migration |

New rejection coverage is selected for real data/effect risk:

- G1 tamper each identity/revision column; reject read, duplicate and mutation without cross-row writes.
- Eight concurrent accepts/claims yield one winner; stale prepare and foreign-attempt append/finish reject.
- Unknown COMMIT per mutation follows the outcome table; process-start count remains zero after unknown claim.
- Independent digest/codec vectors, byte and receipt limits, contradictory receipt rejection and release mismatch.
- Post-lock deadline edges, owner loss before/at/after bounds and clock changes, with no writes or relaunch.
- G2 retained workspace releases adapter state, retains bytes and durable debt when receipt persistence fails.
- PA retire vs beginRequest race, failed request, 65th request and one-shot grant after uncertain consume.
- Security record policy changes preserve recorded limits; forged policy/authority and persisted secrets reject.
- Parallel migrations serialize; guard failure, changed hash, newer journal and lost migration ACK retain safe state.
- Populated non-default legacy namespace, unrelated same-name table, permissions, partial owner progress and restore.
- Actual constraints/triggers, immutable grants, safe SQL errors, late acquisition release, close during transaction.
- Host failure never closes borrowed storage; storage outlives incomplete cleanup; no DDL on Host creation.
- Packed migrations are present; emitted declarations expose no Drizzle; public install has no private conformance edge.

### First-public-release implementer usability

Ports and types required by a published public factory, including the selected
`./composition`, are supported implementer contracts for its declared profile
from its first release. The [ecosystem choice](agent-runtime-foundation-decisions-and-review.md)
concerns additional families/kits/support commitments; it cannot defer these
already selected inputs. Document ownership, failure/unknown and lifetime
semantics; independently compile a packed caller and required-port implementer,
and reuse necessary independent boundary cases. Internal ports remain private;
the joined storage-conformance package remains private and test-only. Intentional
implementer breaks follow the current 0.x minor/migration policy.

The first-publication record names the actual consuming runtime adapter/source
and its contract exercise. If that consumer is not yet delivered, finish that
concrete integration before publication; a fake-only suite or packed import is
not the real consumer. This need not wait for the full S2-E Host switch, native
activation or fleet qualification: a dependency-complete pure library and its
real consuming source can be exercised before effectful activation.

### Greenfield review refinements

The [foundation invariants](agent-runtime-greenfield-foundation-plan.md#invariants)
refine this selected profile without changing its one-shot dispatch or native
ownership. Add the following rejecting cases to their existing owner suites:

- **F08 encoded state:** every admitted state roundtrips within the 8 MiB encoded
  UTF-8 envelope, including escaping and bounded compatible terminal/reconcile
  growth. Reject an oversized candidate before mutation SQL; prior state stays
  readable. Static headroom plus independent boundary vectors is sufficient;
  this does not mandate a second reserve subsystem or physical storage split.
- **F05 acceptance:** the actual Host/engine boundary reserves its future owned
  obligation before durable acceptance. Cover delayed/lost acceptance ACK and
  close races; unknown never becomes unaccepted overload. Duplicate lookup is
  bounded separately and creates no second execution slot. A future accepted
  durable backlog is a separate C0-C3 contract, not a new S2 outcome here.
- **F06 actual acquisition:** an acquisition token survives the caller timeout
  until underlying resolution/rejection or proven dequeue. A late client executes
  no body and releases once. Test repeated timeout waves, not only one late
  acquire. The owner accounts for all consumers of a shared pool; store-local
  limits alone do not prove a deployment-wide bound.
- **F07 progress:** finite aggregate pending/owned/closing/read/poll work leaves
  bounded control/settlement progress under saturation. DB outage may prevent
  durable cancellation; independent physical cutoff and retained debt remain
  truthful. No dedicated semaphore is required where existing caps prove the bound.
- **F01 portability:** inspect concrete engine/binding signatures against a
  bounded in-process async harness. Reuse P599 independent cases; add a tiny
  structural fixture only if they miss a process assumption. No fake PID or
  physical drain fact, and no second production provider prerequisite.
- **F14 retirement:** include restore to before acceptance after an external
  effect, and attempted retirement of the last supported recovery path with
  unresolved obligations. Preserve the current migration/recovery contract;
  no generic workflow or recovery engine is introduced.

Use one disposable database per relevant case, not search_path isolation against shared journals.
The existing PostgreSQL runner retains no-skip file/name obligations and approved disposable environment.
Update the roster once when new entry files land and once at removal; do not alter a frozen job to hide failures.
Keep handle guards where they detect physical resources; forced exit alone never proves cleanup.
Every scope is closed. Pure decisions use fake clocks, not sleeps or provider processes.
Contained-only files/tests stay frozen; shared materialization tests remain active permanently.

Documentation acceptance: this brief has valid architecture metadata, reachability, source ledger,
resolved decisions, exact pending dependencies and no claim of implementation readiness from prose.
Code acceptance: all owner ports implemented, oracle/rejection suites pass, empty cutover/populated refusal/restore rehearsed,
public declarations/packages qualify, profiles/registries enforce boundaries and final required gates pass.
A plan, fake suite, build, merge or npm publication alone proves none of durable adapter qualification.

## Split cards, integration and minimal checks

| Card | Cohesive delivery | Dependencies and completion |
| --- | --- | --- |
| S2-A | domain/format library with decision/codec oracle | governance roots/test-support route; current CMS delta recorded; publish useful implementer surface |
| S2-B | engine use cases/fake port integration | S2-A; claim/cleanup/owner-loss/G2 tests; ordinary-operations usable without Postgres |
| S2-C | manual runner, execution adapter, immutable migrations and conformance package | S2-A/B ports; PostgreSQL routing and exact candidate artifacts verified |
| S2-D | fresh security owner, security/PA adapters and provider-owned materialization composition | S2-C; coordinate S3 owner file ownership; three complete adapters and grants tests |
| S2-E | Host/ACL/adapters switch and replaced ordinary deletion | S2-B/D plus S4 forced port edits; storage verification and recovery runbook pass |

Group the cards into three natural PR checkpoints: operations (A/B), all-owner storage (C/D),
and coordinated consumer cutover/deletion (E). This checkpoint has an atomic routing
switch only; independently committed owner migrations are explicitly not all-owner atomic. Subdivide only where review size requires a coherent seam.
S2-A's decision documentation accompanies the first substantive package, not a separate approval gate.
A successor decision explicitly replaces ADR-0090 codec/reader-compatibility clauses and the old mixed-pool
interim design; accepted ADR bytes remain historical authority and are not silently rewritten.
Target about 2,000 changed lines per coherent PR; if S2-B or cutover exceeds it, retain the invariant
and explain the bounded overrun instead of splitting unknown-commit or ownership behavior across releases.
The new library may merge before Host switch only when its released surface and tests are useful and coherent.
There is one production path after cutover; delete replaced ordinary implementation in the same switch delivery.
Contained exports lose only mechanically obsolete ordinary references; contained copies remain untouched.
Update all affected public exports, source-policy roots/edges, quality projects, FMS/CMS profiles,
Postgres roster, test runners and baseline removal entries once per delivery boundary.
Do not hide ordinary source from a basename census by renaming it to escape enforcement.

P7a/P7b own the composition layout and central pin migration. Coordinate by exact files and base SHA;
never merge S2's old layout between their consecutive transition steps.
After N2 adoption, new features follow the nested layout where a real parent/child boundary exists.
GOV/CI work must replace or extend current six-package assumptions and admit test support before package delivery.
Existing source-policy reversal/frozen obligations need the program's explicit successor, not blanket exclusions.
No fictitious `registries:write` or new Foundation version is assumed installed.
AR declares Foundation 1.7.2; current registry Foundation is 1.10.0, a separate identity from that manifest pin.
The governance lane owns the minimal current upgrade and generator-first route; baseline pruning uses its CLI,
never an invented configuration capability key. No S2 registry generator is implemented independently.

Publication graph is inspected before manifests land. Public store runtime dependencies are the three owner packages;
none may depend back on store, Embedded Runtime or private conformance.
Conformance is never published. It may depend on owner packages in the workspace without becoming a public dependency.
Publish ordinary-operations once S2-B's intended public contract is coherent, then publish required owner versions,
then store and public consumers in topological order through the program release route.
Do not publish a store tarball with unresolved `workspace:*`, unavailable owner versions or missing migrations.
If owner publication still depends on S5 public-surface cleanup, complete that bounded prerequisite in the same train;
do not leave the store indefinitely unpublished or ship an execution-only placeholder as the full adapter.
0.x breaks get minor releases, changelog and migration guide. Existing provider authentication requirements apply
at the actual release step; this planning task creates no new owner-permission barrier.

Verified script names at AR are `pnpm check:changed`, `pnpm check:fast`, `pnpm check`,
`pnpm docs:check`, `pnpm docs:protocol:check`, `pnpm product:build` and `pnpm lint:typed`.
This brief does not assert that they passed or that new package scripts already exist.
During implementation use changed feedback and the affected package's real test script;
run fast checks before handoff and the authoritative full `pnpm check` before opening/merging a PR,
as repository instructions require. The disposable Postgres contract remains a required separate runner.
Run a focused failure diagnosis after failure; repeat successful checks only after changed inputs/new risk.
Do not execute runtime/provider/live-agent commands to validate storage planning.
For governed docs, use the existing authoring skill/info/find/preview/apply flow and reported index;
this indexed planning document does not hand-edit accepted ADRs or transaction evidence.

## Estimate and concrete pending dependencies

These are planning ranges, not measured future LOC or percentage completion.
Basis: current compact engine/store/owner implementations, fresh readable rules-compliant code,
ported behavioral suites, migration fault/recovery coverage and package/adoption changes.

| Work | New/edited production | Tests/support | Manifests/profiles/docs | Effort |
| --- | ---: | ---: | ---: | ---: |
| S2-A/B operations | 1,400-2,000 | 850-1,300 | 200-350 | 4-6 days |
| S2-C PostgreSQL core/conformance | 1,000-1,500 | 700-1,050 | 250-400 | 3-5 days |
| S2-D owners/materialization | 1,000-1,450 | 500-850 | 150-250 | 3-4 days |
| S2-E cutover/recovery | 500-850 | 450-800 | 300-550 | 3-5 days |
| Total | 3,900-5,800 | 2,500-4,000 | 900-1,550 | 13-20 days |

Total changed additions/edits: roughly 7,300-11,350; ordinary deletions roughly 2,300-2,900,
subject to exact cutover census. Generated snapshots/lockfile churn are counted separately.
Populated-data conversion beyond the conservative retained-archive route is not included.
Estimate confidence 4/10; reliability depends on the migration and unknown-commit fault matrix.
No extra review ceremony or calendar waiting is included.

Concrete remaining implementation dependencies are current CMS/FMS adoption and test-support admission,
package-aware CI routing, current artifact compatibility evidence, S3/S4 ownership coordination,
populated-legacy refusal/recovery plus old-writer fencing, and publication of transitive owner packages.
These have chosen technical paths above; they are work items, not unresolved routine owner choices.
A populated installation with unresolved effects cannot activate the new schema safely until its
specific recovery obligation is settled or retained under a supported recovery path.

## Source ledger

Every row identifies a source path@AR and an immutable GitHub link; line anchors support facts above.

- R1: [`packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/postgres/ordinary-postgres-store.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/postgres/ordinary-postgres-store.ts#L71).
- R2: [`packages/contexts/agent-execution/src/features/contained-agent-turn/application/ordinary-engine.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/contexts/agent-execution/src/features/contained-agent-turn/application/ordinary-engine.ts#L33).
- R3: [`packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-agent-runtime-host.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-agent-runtime-host.ts#L26).
- R4: [`packages/contexts/provider-access/src/features/contained-turn-access/application/ports/outbound/ordinary-pa-grant-store.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/contexts/provider-access/src/features/contained-turn-access/application/ports/outbound/ordinary-pa-grant-store.ts#L14).
- R5: [`packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/postgres/ordinary-pa-store.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/postgres/ordinary-pa-store.ts#L57).
- R6: [`packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/postgres/ordinary-pa-schema.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/postgres/ordinary-pa-schema.ts#L4).
- R7: [`packages/contexts/provider-access/src/features/contained-turn-access/composition/ordinary-provider-access-owner.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/contexts/provider-access/src/features/contained-turn-access/composition/ordinary-provider-access-owner.ts#L226).
- R8: [`packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-schema.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/contexts/provider-access/src/features/contained-turn-access/adapters/outbound/postgres/materialization-postgres-schema.ts#L30).
- R9: [`packages/contexts/runtime-security/src/features/contained-turn-dispatch-authority/application/ordinary-security-owner.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/contexts/runtime-security/src/features/contained-turn-dispatch-authority/application/ordinary-security-owner.ts#L26).
- R10: [`packages/contexts/runtime-security/src/features/contained-turn-dispatch-authority/domain/ordinary-security-policy.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/contexts/runtime-security/src/features/contained-turn-dispatch-authority/domain/ordinary-security-policy.ts#L100).
- R11: [`packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/ordinary-filesystem/node-ordinary-workspace.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/ordinary-filesystem/node-ordinary-workspace.ts#L11).
- R12: [`packages/apps/embedded-runtime/tests/features/ordinary-session-runtime/support/ordinary-store-cases.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/packages/apps/embedded-runtime/tests/features/ordinary-session-runtime/support/ordinary-store-cases.ts#L1).
- R13: [`scripts/ci/run-ordinary-postgres.mjs@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/scripts/ci/run-ordinary-postgres.mjs#L6).
- R14: [`scripts/ci/package-execution.ts@efd3348f361fa6af84953325af5c0d2d8677d14a`](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/scripts/ci/package-execution.ts#L23).
- [Current CMS and test-code placement](https://github.com/agent-teams-ai/get-modular/blob/3dd68a6b26f42159714a4640b613534a55c2c6aa/docs/architecture/common-assembly.md#feature-layout-and-implementation-form); [AR retained consumer pin](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/architecture/get-modular/consumer-profile.json#L5).
- [Current authoring placement/metadata](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/architecture/foundation/document-authoring.yaml#L46); [current scripts](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/package.json#L14).
- [Historical storage probe, not a new test run](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/research/architecture-critique-2026-10/storage-verification/storage-report.md#L39).
- Official current package metadata: [drizzle-orm](https://registry.npmjs.org/drizzle-orm), [drizzle-kit](https://registry.npmjs.org/drizzle-kit), [pg](https://registry.npmjs.org/pg).

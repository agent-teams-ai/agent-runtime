---
id: runtime.architecture.architecture-program-execution-brief
type: architecture
status: active
owner: architecture
summary: Self-contained execution brief for the remaining cards of the Agent Runtime architecture program, with preconditions, card instructions, review checklists and stop conditions.
---

# Agent Runtime Architecture Program: Execution Brief

Version 3, 2026-10-19. Execute one card from the
[program plan](agent-runtime-architecture-program-plan.md), using its exact
[S1](agent-runtime-architecture-program-s1-libraries.md),
[S2](agent-runtime-architecture-program-s2-operations-storage.md) or
[S3-S5](agent-runtime-architecture-program-s3-s5-features-host.md) contract.
This brief replaces the October 11 move-first instructions. It does not authorize
live provider runs, alter accepted ADR bytes or claim the program implemented.

## 1. Assignment contract

Give an executor the following bounded input, filled from the selected card:

- Card ID, concrete result, owning package/feature and allowed files.
- Exact base commit and actual dependency commits/artifact identities.
- Narrow required input/output ports and the slice's relevant invariants.
- Existing behavioral case names to preserve, changed risks to test, applicable
  package commands and final required repository/CI evidence.
- The integrator responsible for profiles, lockfile, Host wiring, exports and
  accepted-decision metadata; name any externally owned overlapping branch.
- Exact cutover/rollback boundary, including who retains incomplete cleanup and
  how nonempty legacy data refuses without loss.

The executor is not alone. Do not revert another lane or edit its reserved
files. A library is mechanism; product permissions and recovery remain with
consumers. No new adjacent feature, framework, universal manager, duplicate
process package or silent replacement of a pinned contract.

Only report a blocker when a concrete prerequisite prevents this card's dependent
step. Continue independent work. Routine design/placement choices inside these
contracts are resolved by the executor; do not create new owner questionnaires.

## 2. Bounded start check

Record the actual source head, `git status`, package manager, Node pin and changed
inputs since the cited plan baseline. Use full Git history when repository
checks read historical commits. Read the target AGENTS and pinned authority
before editing; compare the current CMS/FMS pin with the reviewed successor.
Only re-read a card's cited code if it changed or its contract is uncertain.

At this plan's snapshot, agent-runtime is `efd3348f361fa6af84953325af5c0d2d8677d14a`,
Node 26.11.1 and pnpm 11.18.0. Pinned Foundation remains 1.7.2 and Get Modular
Core/Assembly 0.3.0. Released upstream versions are separate facts: Foundation
1.10.0, FMS package 0.1.1 and the 0.5.0 Get Modular train.
Do not change the toolchain/dependencies merely because a newer version exists.
A dependency addition verifies current official metadata and its actual target
compatibility, then pins the reviewed choice through the repository policy.

Useful read-only start commands from the repository root:

```sh
git status --short --branch
git rev-parse HEAD
cat .node-version
node --version
node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager'
gh pr view 230 --repo agent-teams-ai/agent-runtime --json state,headRefOid,updatedAt
gh api repos/agent-teams-ai/agent-runtime/rules/branches/main
```

Inspect required checks and the relevant test scripts from the current source.
Do not blindly recreate v2's frozen six-package inventory or historical check
names. #232/#234 and earlier train/test-debt delivery are already merged.
Existing #230 is separately owned; reading it is not authorization to message,
modify or merge it.

## 3. Work order and ownership

1. Governance preparation: coordinate CI recovery ownership; CI-CONTRACT-1;
   released Foundation/baseline adoption; one registry generator; scoped ADR
   successors. P7-now's docs/named-port work may start independently.
2. P7-now -> P7a -> P7b -> N2 for shared consumer/profile files. P7a/b own Host
   roots/modules/groups and ordinary-session composition until merged.
3. S1 mechanisms, S2 engine/store and S5 release data can develop in parallel,
   with concrete dependencies in the main plan. Codex protocol borrows a byte
   channel and does not wait for the external interactive process implementation.
4. Security may cut over once its owner/store contracts and P7b are ready.
   Provider Access and Agent Execution wait for N2 and land nested directly.
5. The S2 state/store/owner contract activation is one coherent cutover. S5 wires
   its Host responsibility there, not in a second mandatory migration PR.
6. Public operations/Host and packed consumers follow the owners. Publish each
   dependency-complete qualified package when ready; do not wait for all slices.

Integrator-owned files: root manifests/lockfile/workflows and AGENTS;
`architecture/**`; shared architecture/CI/docs tooling; accepted-decision
registry/index; all package public barrels; Embedded Runtime Host/composition.
Workers own explicitly assigned feature/package source and mirrored tests.
Reassign a bounded file before concurrent edits; there is no generic prohibition
on parallel workers or independent tests.

## 3.1 Retained supporting deliveries

The main plan sections 5.1-5.4 own ACTIVE-SUPPORT, PUBLISH-NATIVE, conditional
shared-tooling/library-first standard work and the full Codex bump contract.
Assign those cards explicitly along with S1-S5; no module-config/setup lane,
filesystem-custody publication or accepted tooling task is implicitly cancelled
by the new slice sequence. ACTIVE-SUPPORT uses existing behavioral tests before
writing its target layout; it does not add a new Claude execution feature.
Do not publish custody without its matched prebuilt native artifact and packed
qualification, or approve a bump without exact-tag defaults/config/refresh checks.

## 4. Tests first and acceptance

Copy the relevant behavioral cases to the target test owner before replacing the
implementation. Adapt API call shape once; retain case purpose and meaningful
assertions. Do not generate expected answers from new production code, assert
source strings instead of behavior, or add test-only hooks to satisfy coverage.
New tests address changed risks: money/authority, credentials, data loss,
unknown commit, concurrency, process lifetime and confirmed regressions.

| Changed boundary | Minimum evidence beyond ordinary type/build checks |
| --- | --- |
| Process/session/JSONL | bounded bytes/backpressure, aborted-before-send zero writes, partial-send ambiguity, one start, clean EOF vs truncation, truthful group/close facts, no leaked handles |
| Engine/owner ports | independent transition/readback table, CAS races, unknown claim never dispatches, G1 mismatch rejects, G2 retains cleanup, owner-loss projection never relaunches |
| Postgres/migrations | borrowed pool, one-client locks, concurrent/partial migration, exact name/hash prefix, unknown commit, nonempty legacy intact, old-writer fence, owner-specific conformance |
| Auth/capture/broker | strict secret byte handling, account/file identity, cumulative secret guard, actual sandbox fake helper rewrite permissions, stdin-first grace and bounded refusal |
| Module adoption | reviewed content pin, structural layout/import checks, shared rejecting FMS fixtures, independent wiring oracle, smoke/isolate cleanup and own-property ports |
| Host/API/package | exact replay/scope/uncertainty outcomes, failure/disposal recovery, verify-only/no DDL, public union parity and isolated tarball runtime/type imports |

Physical adapter claims need real disposable adapters. Tests never use the user's
real projects or credentials. A separately permitted pinned-binary TEST run is
not replaced by a mock, nor automatically repeated after an uncertain outcome.
Frozen contained code still builds/typechecks. Ordinary and shared tests stay
selected even when some contained-only tests are deliberately disabled.

## 5. Verification without check loops

During editing run the affected package/risk suite and `pnpm check:changed`.
Run documented `pnpm check:fast` at the final local checkpoint. The authoritative
`pnpm check` and the full expected required CI roster prove the final candidate;
keep exact SHA/run/attempt evidence. Follow project-specific required commands.
Do not separately repeat build/typecheck/lint phases already covered by a
successful stronger gate unless a changed input or unresolved risk requires it.

Docs changes follow `docs:info`, `docs:find`, dry-run/apply for new documents,
manual index update, `docs:check` and `docs:protocol:check`. Preserve frontmatter,
sidecar custody and accepted immutable bytes. A new plan is not code E2E evidence.

Registry commands are planned deliverables until GOV-REGISTRIES lands. Thereafter
use its `registries:write` once and its read-only `--check`; do not hand-edit the
same five projections in a loop. Foundation baseline is currently a CLI module:
`agent-teams-foundation baseline check --config <owned-config> --consumer .`.
It is not yet a key in `foundation.config.yaml`. Do not weaken either lint route
or add automatic baseline expansion. Prune only proven fixed entries.

One final meaningful review; delta fixes receive an appropriate delta review.
Review scope, source SHA and results stay honest. Use available reviewers without
making quota or another human account an artificial prerequisite. Repository
protection and unresolved substantial findings still bind delivery.

For final CI, record required checks from the actual rules and workflow source.
Start one official `gh ... --watch` for the existing PR/run and retain its handle.
A timeout limits observation, not command lifetime or provider effects. After
completion, verify both full roster and current head. A skipped/missing check is
not success unless the repository's accepted input-proof contract says so.

## 6. Cutover and rollback

Before the single state/storage activation, stop admission and prove old ordinary
writers are fenced while contained access remains intact. Advisory migration
locks alone do not fence legacy code that never takes them. S2 defines exact
supported fresh/empty data preconditions; populated legacy rows and recovery
obligations remain readable on the retained old release and are never deleted
as a workaround. Do not invent acceptedAt or declare old grants harmless.

Switch consumers with the new owner ports, storage, tests and registry diff in
one coherent checkpoint. Delete only replaced active ordinary files after all
references are accounted for; never delete frozen siblings, shared materialization
or historical evidence. The new Host does not migrate on construction.

Rollback closes admission, drains/reconciles existing work, retains incomplete
cleanup and verifies which prior code/data combination is safe. Do not downgrade
into a schema/record version that the old release cannot read, or call process
absence proven because the observer timed out. Publication rollback follows
actual immutable package/distribution behavior, never tag manipulation as data
recovery.

## 7. Handoff and remaining execution-time decisions

A card handoff states its concrete result, exact source/artifact identities,
checks actually run, unresolved debts and next dependent action. Separate code
ready, tests passed, package published, installed, active and live-qualified.
No percentage is inferred from LOC, file count, a plan or an unobserved CI run.

No new owner answer is needed for this plan. Existing requirements remain when
those actions are actually reached: provider-required npm authentication,
permission for the first real Codex bump TEST run, and a separately supported
migration if real nonempty legacy data requires one. They do not block preparing
code, offline comparison, review or the other slices. The owner approved the
process-runtime repository / node-or-bun extension on October 19 (decision 58);
execute its bounded PROCESS-DUPLEX card with its named owner, tests and release.
No repeat scope confirmation is required for that card.

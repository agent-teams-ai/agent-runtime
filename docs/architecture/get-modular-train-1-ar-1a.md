---
id: runtime.architecture.get-modular-train-1-ar-1a
type: architecture
status: active
owner: architecture
summary: "Brief for AR-1a: Consumer Module Standard pin and Core and Assembly 0.3.0."
---

# Get Modular Train 1 AR-1a

AR-1a: Core and Assembly 0.3.0; verify the existing Consumer Module Standard pin `81063ad` (get-modular #142). PR
title `build(deps): adopt Get Modular 0.3.0 Core and Assembly`, branch `build/get-modular-0.3.0` from fresh
`origin/main`, after npm publication (R-1b). Two commits A1 and A2. Estimated diff without retained archives:
+120 / -20 (code, tests, profile, docs).

## 0. Handoff inputs (the owner fills these through the handoff-inputs docs PR; do not start with a placeholder left)

| Input | Value |
|---|---|
| `REL_SHA`: the merged get-modular release commit (40 hex); used for the release link and package facts, not as the pin | `<fill>` |
| get-modular release PR number | `<fill>` |
| R-1a bundle `get-modular-0.3.0-train-r1a`: location and fetch command (release question Q3) | `<fill>` |
| Bundle source commit from `release-intent.md` (the final head of the release PR before its merge) | `<fill>` |
| `SHA256SUMS` lines for `get-modular-core-0.3.0.tgz` and `get-modular-assembly-0.3.0.tgz` | `<fill>` |
| `INTEGRITY` lines for the same two archives | `<fill>` |
| Closed draft PR URL (pre-publication evidence) | `<fill>` |

## 1. Facts you need (verified at agent-runtime `44846323`, get-modular `81063ad`)

- Consumer Module Standard (CMS) = get-modular `docs/architecture/common-assembly.md#consumer-module-standard`. The
  pin migration of this train is already done: agent-runtime #201 (squash commit `8e0a98d8`, 2026-10-04) moved both
  profiles to get-modular `81063add7de50ffe2b91cc74bf7271b298624c21` (the merge commit of #142 that defines this
  standard revision; the same pin as the TEST consumer), SHA-256
  `49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`, 47402 bytes. Retained evidence:
  `architecture/get-modular/evidence/consumer-module-standard.md` (current bytes),
  `consumer-module-standard-9c722ce.md` (predecessor), `smart-ci-cms-pin-delta.diff` (17 hunks, +432/-31) and
  `smart-ci-cms-pin-review.json`. `scripts/architecture/check-cms-pin.mjs:20` points at that review;
  `verifyCmsPin` also runs `scripts/ci/cms-pin-review.ts`, which regenerates the exact delta and requires, among
  others, `successorProductionConformance: "not-established"`, `consumerBehaviorChanged: false` and the current
  adoption states. `scripts/architecture/check-get-modular-adoption.mjs:181-185` verifies the current step through
  `verifyCmsPin`; `scripts/ci/measure.ts:67-75` fingerprints these inputs. AR-1a only verifies this pin; it does not
  migrate or edit it.
- The review's `outstandingWork` lists what the train still owes the standard: raw compatibility literals,
  `owner.authority` labels, one implementation ID with two slot sets (closed by AR-1b), module contract suites and
  per-root conformance-kit checks (smoke in AR-1c, the store suite in issue #189 brief 07), and contained-turn,
  dynamic Host and SDK authority (unchanged owners). That review is the evidence of the pin step: never edit it;
  conformance progress is recorded in `docs/architecture/get-modular-adoption.md` (A2 below).
- The R-1a bundle `get-modular-0.3.0-train-r1a` (archives, `SHA256SUMS`, `INTEGRITY`, `release-intent.md`) was packed
  from the final head of the release PR before its merge (release question Q2, decided by the owner on 2026-10-08:
  option A). The package archives come from that bundle. The release PR does not touch the standard, so the bytes at
  the bundle source commit, at `REL_SHA` and at current get-modular `main` must all equal the pinned bytes.
- Packages: catalog `pnpm-workspace.yaml:32-33` `'@get-modular/core': 0.2.0`, `'@get-modular/assembly': 0.2.0`;
  `minimumReleaseAgeExclude` lines 44-45 list both at 0.2.0, and `scripts/docs/consumer-migration.test.mjs:52-60`
  asserts that exact list. Profile `packages` at `consumer-profile.json:6290-6302`. The schema enum
  `consumer-profile.schema.json:137` and the exact pair check `check-get-modular-adoption.mjs:39` already cover Core
  and Assembly.
- Assembly 0.3.0 changes that touch this repository (its changelog): new codes `assembly.prepare.input-handles` and
  `assembly.run.invalid-inputs` (failed phase `"inputs"`); `FactoryContext` gains `scope`; handles are invariant only
  in the capabilities they use. Core 0.3.0 has no API or behavior change. The only compile break here is the
  exhaustive map `packages/apps/embedded-runtime/src/composition/agent-runtime-host-creation-error.ts:45-60`.
- Retained 0.1.0 and 0.2.0 archives stay: disabled C0 (`scripts/architecture/validate-ar-c0-profile-migrations.mjs:170-175`),
  L0 inputs and `docs/spikes/runtime-setup-assembly-adoption-v2-node26-*-successor-evidence.json` reference them.
- CI since 2026-10-05: the required `check` aggregates five lanes (the product lane now fans out by package and file);
  the required `runtime-macos` aggregates `macos-product`, eight macOS package shards (15 minutes each). Required
  checks are unchanged: `check`, `docs-protocol / docs-protocol-check`, `postgres-durability`, `runtime-macos`,
  `commit-author-identity`.

## 2. Re-verify before start

```sh
git fetch origin && git log --oneline -5 origin/main
cat .node-version; grep -n '"packageManager"\|"@agent-teams/engineering-foundation"' package.json   # 24.21.0, pnpm@11.18.0, 1.7.2
grep -n "@get-modular\|minimumReleaseAge" pnpm-workspace.yaml
gh pr list --repo agent-teams-ai/agent-runtime --state open
git log --oneline 44846323..origin/main -- architecture/get-modular architecture/consumer-module-standard scripts/architecture scripts/ci/cms-pin-review.ts packages/apps/embedded-runtime/src/composition pnpm-workspace.yaml scripts/docs/consumer-migration.test.mjs
node -p "JSON.stringify(require('./architecture/get-modular/consumer-profile.json').standard)"   # commit 81063add..., sha256 49d08b6d...
grep -n "cmsPinReviewPath =" scripts/architecture/check-cms-pin.mjs                                # smart-ci-cms-pin-review.json
pnpm test:consumer-modules && pnpm architecture:consumer-modules && pnpm architecture:get-modular-adoption   # each exit 0 on origin/main
npm view @get-modular/core@0.3.0 dist.integrity
npm view @get-modular/assembly@0.3.0 dist.integrity
```

If the pin is no longer `81063add...`, or another review path is current, stop: someone moved the pin, and this
brief must be re-planned. Each `dist.integrity` must equal the line for that archive in the bundle's `INTEGRITY`.
Then download the published tarballs (`npm pack <name>@<version>` downloads from the registry; it does not pack from
source): `d=$(mktemp -d); (cd "$d" && npm pack @get-modular/core@0.3.0 @get-modular/assembly@0.3.0)` and check them
with the bundle's `SHA256SUMS` (`cd "$d" && grep -E 'core-0.3.0|assembly-0.3.0' <bundle>/SHA256SUMS | shasum -a 256 -c`).
Any difference: stop, registry bytes are not the reviewed bytes. Never re-pack from source to compare. If a commit in
the `git log` above touched these paths, re-read the changed lines before editing and stop if a step no longer fits.

In a disposable get-modular clone (`git fetch origin` and `git fetch origin pull/<release PR>/head`), with
`REL_SHA` and `BUNDLE_SOURCE` (the bundle source commit) set from section 0:

```sh
for c in 81063add7de50ffe2b91cc74bf7271b298624c21 "$BUNDLE_SOURCE" "$REL_SHA" origin/main; do
  printf '%s ' "$c"; git show "$c:docs/architecture/common-assembly.md" | shasum -a 256
done                                   # all four print 49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7
git merge-base --is-ancestor 81063add7de50ffe2b91cc74bf7271b298624c21 "$REL_SHA" && echo ancestor
```

Also `git rev-parse "$REL_SHA^{tree}"` equals the tree of the bundle's source commit (or the release owner recorded
why not). If any byte set differs, stop and ask: the standard changed upstream (workspace rule "Consumer Module
Standard maintenance"), and the owner decides on a pin step before this PR.

Environment: Node from `.node-version`; pnpm 11.18.0 through corepack without changing shared global shims; local
checks with `GIT_CONFIG_GLOBAL` pointing at a file that holds only `[user] name = iliya, email = iliyazelenkog@gmail.com`
(a global git hook breaks fixture tests); `git config user.email` prints `iliyazelenkog@gmail.com` before the first commit.

Local full gates (run after committing; several tests read committed files and git history). Export the
identity-only git config first (`export GIT_CONFIG_GLOBAL=<file with only [user] name = iliya, email = iliyazelenkog@gmail.com>`;
a global git hook on developer machines breaks fixture tests).

- Linux: `pnpm check:fast` and `pnpm check`, both exit 0.
- macOS: `test:sdk-growth:source` fails there on unmodified `origin/main` (it reads `/proc/self/fd`; 9 failures). This
  is a known pre-existing macOS failure that this PR does not fix; confirm it once on `origin/main`. Because the
  chains use `&&`, every later step would be skipped, so run every step except that one, stopping at the first
  failure, as a script file (`bash local-gates.sh`) or a quoted heredoc (`bash <<'EOF' ... EOF`); not
  `bash -c '...'`, because the loop contains single quotes. Each step must exit 0:

  ```sh
  for chain in check:fast check:ci:quick check:ci:foundation check:ci:architecture check:ci:docs check:ci:product; do
    for s in $(node -p "require('./package.json').scripts['$chain'].replaceAll('pnpm ', '').split(' && ').join(' ')"); do
      [ "$s" = test:sdk-growth:source ] && continue
      pnpm "$s" || { echo "FAILED: $chain -> $s"; exit 1; }
    done
  done
  ```

  CI on Linux (the required `check`) remains the authority for `test:sdk-growth:source`.

## 3. Scope and non-goals

In scope: Core and Assembly 0.3.0 with retained archives; the two new error codes; one source of Get Modular names and
versions in the packed consumer test; the adoption record and the train's conformance status table.

Non-goals: the Consumer Module Standard pin (already at `81063ad`, done by #201; never edit its review, delta or
retained bytes); module identities, builder, root shape (AR-1b); resources, conformance, ADR-0024 (AR-1c); Provider
Access (AR-2); package.json scripts, workflows, rulesets; re-enabling AR-0 or AR-S gates (their restore conditions are a
new AR decision for C0, a regression missed by `runtime-macos`/`postgres-durability` or cheaper receipts for L0, a full
history proof for the CMS chain, and the generated SDK surface report for the SDK freeze; none is met by this PR).

## 4. Decisions (facts)

- Pin (planning decision 2026-10-04, implemented by #201): the standard's accepting commit `81063ad` (#142), one pin for
  both consumers; the release commit changes no standard byte. The wording "the release commit" in the description
  of get-modular #142 is superseded.
- Release timing (owner decision 2026-10-08, get-modular release question Q2 option A): the bundle comes from the
  final head of the open release PR; the owner merges the release PR after signing off the consumer checks, so
  `REL_SHA` exists when AR-1a starts.
- Order: AR-1a, then AR-1b, AR-1c, AR-2. No open questions remain for this brief.

## 5. Commits

### A1 `build(deps): adopt Get Modular Core and Assembly 0.3.0`

| File | Change |
|---|---|
| `pnpm-workspace.yaml` | catalog `'@get-modular/core': 0.3.0`, `'@get-modular/assembly': 0.3.0`; in `minimumReleaseAgeExclude` replace the two `@0.2.0` entries with `@0.3.0` |
| `scripts/docs/consumer-migration.test.mjs:52-60` | the same two entries in the exact list |
| `pnpm-lock.yaml` | `pnpm install` against the registry, then `pnpm install --frozen-lockfile`; `packages['@get-modular/core@0.3.0'].resolution.integrity` and Assembly's equal the bundle's `INTEGRITY` lines |
| `architecture/get-modular/evidence/get-modular-core-0.3.0.tgz`, `get-modular-assembly-0.3.0.tgz` | the downloaded tarballs that passed the bundle's `SHA256SUMS` |
| `architecture/get-modular/consumer-profile.json` `packages` | version `0.3.0`, `archiveSha256`, `archivePath` for both |
| `packages/apps/embedded-runtime/src/composition/agent-runtime-host-creation-error.ts` | two map rows, below |
| `packages/apps/embedded-runtime/tests/package/assembly-packed-consumer.test.ts` | GM names and versions from the profile, below |

```ts
// agent-runtime-host-creation-error.ts, inside assemblyErrorCodes
  "assembly.prepare.input-handles": "invalid_composition", // Agent Runtime binds no run inputs
  "assembly.run.invalid-inputs": "internal_failure",       // unreachable without inputs: an internal defect
```

```ts
// assembly-packed-consumer.test.ts: one source of Get Modular names and versions (top-level await is fine in ESM)
const gmPins: ArchivePin[] = JSON.parse(await readFile(join(repositoryRoot,
  "architecture/get-modular/consumer-profile.json"), "utf8")).packages;
// line 48:  for (const name of gmPins.map(pin => pin.name))
// line 93:  minimumReleaseAgeExclude: gmPins.map(pin => `${pin.name}@${pin.version}`)
// line 129: if (name.startsWith("@get-modular/")) { assert.equal(manifest.version, gmPins.find(pin => pin.name === name)?.version); }
// line 278: assert.deepEqual(Object.keys(dependencies).toSorted(), gmPins.map(pin => pin.name).toSorted());
// line 287: for (const name of gmPins.map(pin => pin.name))
```

No new tests: the adoption gate compares lock SRI with the retained bytes, and `satisfies` makes the code map
complete at compile time. A test expectation that changes between 0.2.0 and 0.3.0 (for example the hostile signal
accessor tests in `runtime-setup-assembly.test.ts:32-110`) may change only with a quoted line of the Assembly 0.3.0 or
0.2.0 changelog in the commit message; otherwise stop, it is a Get Modular finding.

Gates for A1 (each exit 0): `pnpm install --frozen-lockfile`, `pnpm typecheck`,
`pnpm --filter "@agent-teams/embedded-runtime..." run build`, `pnpm --filter @agent-teams/embedded-runtime test`,
`pnpm architecture:get-modular-adoption`, `pnpm test:get-modular-adoption`, `pnpm docs:qualification`,
`pnpm foundation:check`, `node scripts/ci/audit-node-engine-compatibility.mjs --check`.

### A2 `docs(architecture): record the 0.3.0 adoption and the train conformance status`

`docs/architecture/get-modular-adoption.md`:

- "Status and authority": the release table (line 134) to 0.3.0 with the new SHA-256 values; "The profile
  retains the approved published Core and Assembly 0.3.0 archives"; one sentence with `REL_SHA` as the release commit,
  the bundle name `get-modular-0.3.0-train-r1a` and its source commit, and a link to the closed draft PR as
  pre-publication evidence (no local paths or machine names).
- New final section "Train 0.3.0 conformance status": one table, one row per norm of the pinned standard, with the
  state that is true at each PR head. AR-1a writes `met` only for rows closed by #201 or by itself; every other row is written as
  `pending: <closing PR>`, and that PR switches its rows in place to the final state below. It complements the
  "Reviewed Smart CI prerequisite successor checkpoint" section and the review's `outstandingWork`, which stay as the
  pin step's evidence.

| norm | state written by AR-1a | final state, written by the closing PR | closedBy |
|---|---|---|---|
| Authority and identity: document pin, accepting ADR-0026, profile | met (pin `81063ad` since #201) | met | agent-runtime #201 |
| Scoped acceptance and evidence: pins, package and archive identities, blocking commands | met for Core and Assembly 0.3.0 | met (resources added in AR-1c) | AR-1a, AR-1c |
| New composition boundaries: descriptors own IDs and revisions; no hand-written compatibility; no `any`, `as never` or double casts in wiring | pending: AR-1b | met | AR-1b |
| Identity and namespaces, rules 1-7 | pending: AR-1b | met | AR-1b |
| Module packages and contracts | pending: AR-1b | met for a private host-app package: descriptors and declarations live with the composition; module factories are members of a frozen record built per Host attempt from Host constructors and bound by the root; a separate contract package is revisited in the package publication lane | AR-1b |
| Module packages list Get Modular packages only as peers | not applicable | not applicable while Agent Runtime packages are private and export no Get Modular modules; revisit in the package publication lane | none |
| Dynamic instances (templates, inputs) | not applicable | not applicable: no prepared assembly serves more than one run; compile, bind and prepare run once per Host attempt | none |
| Module resource scopes, author rules 1-13 | pending: AR-1c, AR-2 | met for the security, Provider Access and Codex owners; rule 7 holds: the Provider Access retirement protocol (broker close, rendering, capture and guard disposal, store retire) stays inside one cleanup | AR-1c, AR-2 |
| Host rules: `scoped()`, one scope per run, close after `run()` settles, one package copy | pending: AR-1c | met (the passive profile has no owning factories, so its runs need no scope) | AR-1c |
| Host rule: outer scope for a provider that cleanups need; drain before closing | pending: AR-1c | met: journal in the outer scope; Host drain with the turn owner handoff before owners close | AR-1c |
| Host rule: one deadline at the root (escalate, then abandon) | outstanding | outstanding by decision of 2026-10-04: release of the resource owners keeps today's behavior without a deadline; added when an owner's release can block without its own bound, or on owner request; prepared values grace 5000 ms, abandon 5000 ms | none yet |
| Host rule: `order: "concurrent"` only for independent peers | pending: AR-2 | met: Provider Access grants | AR-2 |
| Errors identified by code | pending: AR-1c, AR-2 | met | AR-1c, AR-2 |
| Testing 1 and 2: named module factories, typed fakes | pending: AR-1b | factories met for the ordinary feature; fakes this train touches are typed, but package test files are not type-checked yet; remaining work tracked in issue #189 | AR-1b, AR-1c; rest per #189 |
| Testing 3: contract suites | outstanding | outstanding; covered by issue #189 brief 07 after AR-2 (planning decision 2026-10-04): one suite for `agent-runtime/ordinary/store`, owned by the ordinary feature, run against an in-memory fake and the PostgreSQL store, moved unchanged into STORE-2-core as its compatibility suite (never copied or imported from embedded-runtime); every other contract recorded as "no second implementation" | #189 brief 07 |
| Testing 4: `isolate` | pending: AR-1c | met for one scoped owner module | AR-1c |
| Testing 5: roots as functions of Assembly, one `smoke` per root | pending: AR-1b, AR-1c | met for the passive and ordinary profiles | AR-1b, AR-1c |
| Testing 6: independent binding oracle | pending: AR-1b | met: literal compiled-plan oracle | AR-1b |
| Testing 7 and 8: `guardHandles`, close every scope, no sleeps | pending: AR-1c | 8 met for new tests; 7 not adopted in this train, tracked in issue #189 | AR-1c; 7 per #189 |
| Optional dynamic Host lifecycle candidate | not adopted | not adopted | none |

- `docs/architecture/agent-runtime-architecture-program-plan.md:292`: replace "Today the pin `9c722ce` still matches"
  with "Since agent-runtime #201 the pin is `81063ad` (get-modular #142)". If agent-runtime #216 (program plan version
  2) merged first, update its equivalent pin sentence, or skip when it no longer states a pin.

Gate: `pnpm docs:protocol:check`.

Final gates: the local full gates of section 2 after the last commit.

## 6. Risks and stop conditions

- Registry bytes differ from the bundle (`SHA256SUMS`, `INTEGRITY`), or the CMS at `REL_SHA` differs from `81063ad`: stop.
- The pin, its review or `scripts/ci/cms-pin-review.ts` changed after `44846323`: stop and re-plan.
- Another PR merged into `architecture/get-modular/**` or `scripts/architecture/check-*` after `44846323`: rebase,
  re-read, and stop if a step no longer fits.
- A test outside the files listed here starts failing on the package change: stop and report the file and assertion;
  do not extend this brief silently.
- A macOS package shard of `runtime-macos` above 12 minutes (limit 15): report to the owner.

## 7. Must not

Edit the CMS pin, `smart-ci-cms-pin-review.json`, its delta, the retained standard bytes or any historical review;
delete 0.1.0 or 0.2.0 archives; change `consumer-module-standard-pin.mjs`; add `as never`, `any` or double casts;
change package.json scripts or workflows; follow a moving get-modular main; add co-author trailers or text about how
the change was produced.

## 8. Done

Required checks green on the PR head (`check`, `docs-protocol / docs-protocol-check`, `postgres-durability`,
`runtime-macos`, `commit-author-identity`); independent review clean and re-run after fixes; owner merges.

## 9. Review checklist (owner's reviewer)

1. `git diff origin/main --stat -- architecture/get-modular/evidence architecture/consumer-module-standard scripts/architecture/check-cms-pin.mjs scripts/ci/cms-pin-review.ts`
   lists only the two new archives (the pin is untouched).
2. `npm view @get-modular/core@0.3.0 dist.integrity` equals `packages['@get-modular/core@0.3.0'].resolution.integrity`
   in `pnpm-lock.yaml` and the SHA-512 of the committed archive (same for Assembly); both archives pass the bundle's
   `SHA256SUMS`.
3. In `docs/architecture/get-modular-adoption.md`, section "Train 0.3.0 conformance status", every row whose state cell
   is exactly `met` names only #201 or AR-1a in `closedBy`; the row "Scoped acceptance and evidence" says
   `met for Core and Assembly 0.3.0` until AR-1c; every other row says `pending: <PR>`, `outstanding` or
   `not applicable`, true at this PR head.
4. Mutations, each in a scratch clone at the PR head, each committed on a detached HEAD (several checks read git),
   each started again from the PR head; each must make the named command exit non-zero:
   - remove the `"assembly.run.invalid-inputs"` row: `pnpm typecheck`;
   - profile `archiveSha256` of Core changed by one hex digit: `pnpm architecture:get-modular-adoption`;
   - catalog `'@get-modular/core'` back to `0.2.0` without a lock update: `pnpm install --frozen-lockfile`.
5. `git diff origin/main -- '*.ts' '*.mjs' | grep -c '^+.*as never'` is 0.

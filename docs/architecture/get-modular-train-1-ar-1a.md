---
id: runtime.architecture.get-modular-train-1-ar-1a
type: architecture
status: active
owner: architecture
summary: "Brief for AR-1a: Consumer Module Standard pin and Core and Assembly 0.3.0."
---

# Get Modular Train 1 AR-1a

AR-1a: Consumer Module Standard pin to `81063ad` (get-modular #142), Core and Assembly 0.3.0. PR title
`build(deps): adopt Get Modular 0.3.0 Core and Assembly`, branch `build/get-modular-0.3.0` from fresh `origin/main`, after npm publication (R-1b). Three commits A1, A2, A3. Estimated diff without retained bytes:
+180 / -40 (code, tests, profiles, docs), plus about 47 KB of retained standard bytes and a 30 KB delta file.

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

## 1. Facts you need (verified at agent-runtime `0ace1cce`, get-modular `81063ad`, 2026-10-04)

- Consumer Module Standard (CMS) = get-modular `docs/architecture/common-assembly.md#consumer-module-standard`.
  Current AR pin: commit `9c722ceff4ede307d06d7a4b63fdebe615f54c53`, SHA-256
  `33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`, 24312 bytes, held in
  `architecture/get-modular/consumer-profile.json` (`standard`, lines 6-14) and
  `architecture/consumer-module-standard/contained-turn-profile.json` (`authority.consumerModuleStandard`, lines 5-11).
- Target: get-modular `81063add7de50ffe2b91cc74bf7271b298624c21`, the merge commit of #142 that defines this standard
  revision; the same pin as the TEST consumer. Its CMS bytes: SHA-256
  `49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7`, 47402 bytes. The release PR does not touch the
  standard, so the bytes at the bundle source commit, at `REL_SHA` and at current get-modular `main` must all equal
  these (check all three). The R-1a bundle `get-modular-0.3.0-train-r1a` (archives, `SHA256SUMS`, `INTEGRITY`,
  `release-intent.md`) was packed from the final head of the release PR before its merge (release question Q2,
  decided by the owner on 2026-10-08: option A); the package archives come from that bundle, the standard pin does
  not. Rationale: the pin names the commit that defines the standard revision, so it does not depend on when the
  release PR merges, and both consumers pin the same identity.
  `git diff 9c722ce 81063ad -- docs/architecture/common-assembly.md`: 17 hunks, 432 added, 31 removed lines.
- The current pin step is verified by `scripts/architecture/check-cms-pin.mjs` (`verifyCmsPin`, review path at
  line 17: `architecture/get-modular/evidence/creation-cleanup-cms-pin-review.json`). `verifyCmsPin` requires: both
  profiles agree; SHA-256 of the retained bytes equals the pin; the review's `repository/path/anchor` and
  `after.commit/sha256/evidencePath` equal the passive profile; the delta path differs from the retained standard; the
  delta bytes hash to `review.delta.sha256`.
- AR-0 (#187, owner decision 2026-10-02) disabled the hardcoded pin chain in `check-consumer-module-standard.mjs` and
  `check-sdk-growth-profile.mjs`, but `scripts/architecture/check-get-modular-adoption.mjs:180-181` still compares the
  profile with the historical review `runtime-profile-cms-pin-review.json` (`after.commit` = `9c722ce`). Migrating the
  pin without the change in A1 step 8 makes `pnpm architecture:get-modular-adoption` fail.
- `scripts/ci/measure.ts:67-71` fingerprints the inputs of the CMS pin check in every CI phase (`cmsInputPaths`,
  including `creation-cleanup-cms-pin-review.json` and `creation-cleanup-cms-pin-delta.diff`). It keeps passing after
  the migration but would fingerprint stale files; A1 step 8b updates it.
- `scripts/architecture/check-get-modular-adoption.test.mjs` tests at lines 403-452 and 466-488 read the current
  retained bytes `architecture/get-modular/evidence/consumer-module-standard.md` and assert they are the 9c722ce
  bytes; the disk fixture at lines 143-161 copies them. They are adapted in A1 step 9.
- Packages: catalog `pnpm-workspace.yaml:32-33` `'@get-modular/core': 0.2.0`, `'@get-modular/assembly': 0.2.0`;
  `minimumReleaseAgeExclude` lines 44-45 list both at 0.2.0, and `scripts/docs/consumer-migration.test.mjs:52-60`
  asserts that exact list. Profile `packages` at `consumer-profile.json:6290-6302`. The schema enum
  `consumer-profile.schema.json:137` and the exact pair check `check-get-modular-adoption.mjs:38` already cover Core
  and Assembly.
- Assembly 0.3.0 changes that touch this repository (its changelog): new codes `assembly.prepare.input-handles` and
  `assembly.run.invalid-inputs` (failed phase `"inputs"`); `FactoryContext` gains `scope`; handles are invariant only
  in the capabilities they use. Core 0.3.0 has no API or behavior change. The only compile break here is the
  exhaustive map `packages/apps/embedded-runtime/src/composition/agent-runtime-host-creation-error.ts:45-60`.
- Retained 0.1.0 and 0.2.0 archives stay: disabled C0 (`scripts/architecture/validate-ar-c0-profile-migrations.mjs:170-175`),
  L0 inputs and `docs/spikes/runtime-setup-assembly-adoption-v2-node26-*-successor-evidence.json` reference them.

## 2. Re-verify before start

```sh
git fetch origin && git log --oneline -5 origin/main
cat .node-version; grep -n '"packageManager"\|"@agent-teams/engineering-foundation"' package.json
grep -n "@get-modular\|minimumReleaseAge" pnpm-workspace.yaml
gh pr list --repo agent-teams-ai/agent-runtime --state open
git log --oneline 0ace1cce..origin/main -- architecture/get-modular architecture/consumer-module-standard scripts/architecture packages/apps/embedded-runtime/src/composition pnpm-workspace.yaml scripts/docs/consumer-migration.test.mjs
npm view @get-modular/core@0.3.0 dist.integrity
npm view @get-modular/assembly@0.3.0 dist.integrity
```

Each `dist.integrity` must equal the line for that archive in the bundle's `INTEGRITY`. Then download the published
tarballs (`npm pack <name>@<version>` downloads from the registry; it does not pack from source):
`d=$(mktemp -d); (cd "$d" && npm pack @get-modular/core@0.3.0 @get-modular/assembly@0.3.0)` and check them with the
bundle's `SHA256SUMS` (`cd "$d" && grep -E 'core-0.3.0|assembly-0.3.0' <bundle>/SHA256SUMS | shasum -a 256 -c`).
Any difference: stop, registry bytes are not the reviewed bytes. Never re-pack from source to compare. If a commit
in the `git log` above touched these paths, re-read the changed lines before editing and stop if a step no longer fits.

In a disposable get-modular clone (`git fetch origin` and `git fetch origin pull/<release PR>/head`), with
`REL_SHA` and `BUNDLE_SOURCE` (the bundle source commit) set from section 0. `verifyCmsPin` reads only its own fields
of the review JSON, so the extra keys `releaseCommit` and `releaseBundleSourceCommit` of A1 step 4 are allowed:

```sh
for c in 81063add7de50ffe2b91cc74bf7271b298624c21 "$BUNDLE_SOURCE" "$REL_SHA" origin/main; do
  printf '%s ' "$c"; git show "$c:docs/architecture/common-assembly.md" | shasum -a 256
done                                   # all four print 49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7
git merge-base --is-ancestor 81063add7de50ffe2b91cc74bf7271b298624c21 "$REL_SHA" && echo ancestor
```

Also `git rev-parse "$REL_SHA^{tree}"` equals the tree of the bundle's source commit (or the release owner recorded
why not). If any byte set differs, stop and ask (never follow a moving main silently). The draft branch
pinned `81063ad` as well, so A1 is the same commit there and here.

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

In scope: the pin migration with its evidence and gates; Core and Assembly 0.3.0 with retained archives; the two new
error codes; one source of GM names and versions in the packed consumer test; adoption documentation.

Non-goals: module identities, builder, root shape (AR-1b); resources, conformance, ADR-0024 (AR-1c); Provider Access
(AR-2); package.json scripts, workflows, rulesets; re-enabling AR-0 or AR-S gates (their restore conditions are a new
AR decision for C0, a regression missed by `runtime-macos`/`postgres-durability` or cheaper receipts for L0, a full
history proof for the CMS chain, and the generated SDK surface report for the SDK freeze; none is met by this PR).

## 4. Decisions (facts)

- Pin target (planning decision 2026-10-04): the standard's accepting commit `81063ad` (#142), one pin for both
  consumers and one migration for the train; the release commit changes no standard byte. The wording "the release
  commit" in the description of get-modular #142 is superseded.
- Release timing (owner decision 2026-10-08, get-modular release question Q2 option A): the bundle comes from the
  final head of the open release PR; the owner merges the release PR after signing off the consumer checks, so
  `REL_SHA` exists when AR-1a starts.
- AR-0 decision: the current pin step is proved by `check-cms-pin.mjs` (no commit literals); historical reviews stay as
  immutable history. A1 step 8 applies the same decision to the third reader.
- Order: AR-1a, then AR-1b, AR-1c, AR-2. No open questions remain for this brief.

## 5. Commits

### A1 `docs(architecture): migrate the Consumer Module Standard pin to get-modular 81063ad (0.3.0 standard)`

1. Keep the prior bytes: `git show HEAD:architecture/get-modular/evidence/consumer-module-standard.md > architecture/get-modular/evidence/consumer-module-standard-9c722cef.md`;
   `shasum -a 256` must print `33b41d5b...`, `wc -c` 24312.
2. New bytes (path unchanged, `check-consumer-module-standard.mjs` requires it):
   `git -C <gm-clone> show 81063add7de50ffe2b91cc74bf7271b298624c21:docs/architecture/common-assembly.md > architecture/get-modular/evidence/consumer-module-standard.md`;
   SHA-256 `49d08b6d...`, 47402 bytes.
3. Delta, with a git config free of diff customizations:
   `GIT_CONFIG_GLOBAL=<identity-only file> GIT_CONFIG_NOSYSTEM=1 git -C <gm-clone> diff --no-color --no-ext-diff 9c722ceff4ede307d06d7a4b63fdebe615f54c53 81063add7de50ffe2b91cc74bf7271b298624c21 -- docs/architecture/common-assembly.md > architecture/get-modular/evidence/train-030-cms-pin-delta.diff`.
   Count hunks (`grep -c '^@@'`), added and removed lines (`git diff --numstat`): expected 17, 432, 31. Different
   counts: stop and ask.
4. `architecture/get-modular/evidence/train-030-cms-pin-review.json` (two-space JSON, trailing newline):

   ```json
   {
     "schemaVersion": 1,
     "reviewedOn": "<YYYY-MM-DD>",
     "repository": "agent-teams-ai/get-modular",
     "path": "docs/architecture/common-assembly.md",
     "anchor": "consumer-module-standard",
     "before": {"commit": "9c722ceff4ede307d06d7a4b63fdebe615f54c53", "sha256": "33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd", "byteLength": 24312},
     "after": {"commit": "81063add7de50ffe2b91cc74bf7271b298624c21", "sha256": "49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7", "byteLength": 47402, "evidencePath": "architecture/get-modular/evidence/consumer-module-standard.md"},
     "sourceMainCommit": "<get-modular origin/main at review time>",
     "sourceMainDocumentCommit": "<last commit touching the file on that main, expected 81063add7de50ffe2b91cc74bf7271b298624c21>",
     "releaseCommit": "<REL_SHA>",
     "releaseBundleSourceCommit": "<bundle source commit>",
     "sourceMainSha256": "49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7",
     "delta": {"path": "architecture/get-modular/evidence/train-030-cms-pin-delta.diff", "sha256": "<sha256 of the diff file>", "hunks": 17, "removedLines": 31, "addedLines": 432,
       "summary": "Revision for the 0.3.0 train: builder and contract descriptors, module resource scopes, dynamic instances with run inputs, module packages and contracts, identity and namespaces, testing with the conformance kit."},
     "behavioralContractChange": true,
     "scopeDisposition": "Passive and ordinary composition stay active; contained-turn stays pending under ADR-0016; no dynamic or plugin scope is admitted. Package adoption: Core and Assembly 0.3.0 in AR-1a, resources 0.1.0 and conformance 0.1.0 in AR-1c. Norm-by-norm state is in normDisposition.",
     "adoption": {"passiveAndOrdinary": "active", "containedTurn": "pending", "sdkExternalAuthority": "pending-authority-qualification"},
     "historicalReview": "architecture/get-modular/evidence/creation-cleanup-cms-pin-review.json",
     "historicalReviewDisposition": "Preserved as history, not current upstream authority and is not used for this pin. Its exact prior document bytes are retained separately in consumer-module-standard-9c722cef.md.",
     "normDisposition": [ "... rows of the table below, as objects {norm, state, closedBy} ..." ],
     "checks": ["pnpm test:get-modular-adoption", "pnpm architecture:get-modular-adoption", "pnpm test:consumer-modules", "pnpm architecture:consumer-modules"]
   }
   ```

   `normDisposition` rows record the state that is true at each PR head. AR-1a writes `met` only for rows it closes;
   every other row is written as `pending: <closing PR>`, and that PR switches its rows in place to the final state
   below (no new pin). Objects `{norm, state, closedBy}`:

   | norm | state written by AR-1a | final state, written by the closing PR | closedBy |
   |---|---|---|---|
   | Authority and identity: document pin, accepting ADR-0026, profile | met | met | AR-1a |
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
5. Profiles: `consumer-profile.json` `standard.commit` = `81063add7de50ffe2b91cc74bf7271b298624c21`, `standard.sha256` = `49d08b6d...`;
   `contained-turn-profile.json` `authority.consumerModuleStandard.gitCommit` and `.sha256` the same values.
6. `scripts/architecture/check-cms-pin.mjs:17`: `cmsPinReviewPath = "architecture/get-modular/evidence/train-030-cms-pin-review.json"`.
7. Do not edit `consumer-module-standard-pin.mjs` or any historical review or delta file.
8. `scripts/architecture/check-get-modular-adoption.mjs`: keep lines 172-179 (they validate immutable history).
   Comment out lines 180-181 with this note:

   ```js
     // AR-0 (owner decision 2026-10-02), applied here at the train 0.3.0 pin step: the current pin is
     // proved by check-cms-pin.mjs below, which holds no commit literals; the history above stays validated.
     // Restore the literal comparison only if the whole pin history must be proved again.
     // assert.equal(profile.standard.commit, current.after.commit, 'reviewed current CMS commit drift');
     // assert.equal(profile.standard.sha256, current.after.sha256, 'reviewed current CMS bytes drift');
   ```

   and add, directly after `const result = verifyAdoption(...)` (lines 224-225 at base, so the existing
   `verifyAdoption` messages such as `central bytes drift` still fire first and the existing rejecting cases keep
   their expected patterns):

   ```js
     const pin = verifyCmsPin(await loadCmsPinInputs(consumerRoot));
     assert.equal(pin.commit, profile.standard.commit, 'reviewed current CMS commit drift');
     assert.equal(pin.sha256, profile.standard.sha256, 'reviewed current CMS bytes drift');
   ```

   Import `{ loadCmsPinInputs, verifyCmsPin }` from `./check-cms-pin.mjs`.
8b. `scripts/ci/measure.ts:70-71`: replace the two `creation-cleanup-cms-pin-*` paths in `cmsInputPaths` with
   `architecture/get-modular/evidence/train-030-cms-pin-review.json` and
   `architecture/get-modular/evidence/train-030-cms-pin-delta.diff`. Gate: `pnpm test:ci`.
9. `scripts/architecture/check-get-modular-adoption.test.mjs`:
   - Test "current standard pin preserves dynamic Host and A3 history and rejects drift" (403-452): read `bytes` from
     `consumer-module-standard-9c722cef.md`; replace the two `pending.standard` assertions (437-438) with: the new review
     (`train-030-cms-pin-review.json`) has `before.commit === current.after.commit` and `before.sha256 === current.after.sha256`.
     All other assertions stay.
   - Test "current candidate-only pin rejects prior identities and prior complete bytes" (466-488): same two changes
     (bytes from the historical copy; lines 478-479 become the history-chain assertion against the new review).
   - `diskFixture` (143-161): set `profile.standard = structuredClone(pending.standard)` (all fields), write the
     retained current bytes to `pending.standard.evidencePath`, copy `train-030-cms-pin-review.json`,
     `train-030-cms-pin-delta.diff` and `architecture/consumer-module-standard/contained-turn-profile.json` into the
     fixture next to the files it already copies.
   - The existing disk-fixture case "retained central bytes" (`:169`) keeps `/central bytes drift/`: with the step 8
     placement `verifyAdoption` reports it before `verifyCmsPin` runs. Run it explicitly after the change.
   - New rejecting tests on the disk fixture: a review whose `after.commit` differs from the profile rejects with
     `/review must end at the pinned standard/`; a contained-turn pin that differs rejects with `/pins must agree/`;
     deleting the new review rejects with `ENOENT`.
10. Docs: `docs/architecture/get-modular-adoption.md` "Status and authority" (lines 109-121): link, commit and SHA-256
    of the new pin; replace the "not yet reviewed" paragraph from the briefs docs PR; new final section
    "Train 0.3.0 standard pin review" with the delta summary and the `normDisposition` table. Update the sentences
    that state the current pin in `docs/architecture/foundation-adoption.md` (around lines 221-227) and
    `docs/architecture/contained-turn-consumer-module-standard-adoption.md` (lines 24-26); historical statements stay.
    Below the headings "Current standard and dependency pin review" (line 935) and "Current candidate-only standard
    pin review" (line 1004) of `get-modular-adoption.md`, add one line each: superseded by "Train 0.3.0 standard pin
    review" (keep the headings, anchors may be referenced). In `docs/architecture/agent-runtime-architecture-program-plan.md:292`
    replace "Today the pin `9c722ce` still matches" with the new pin and the date.

Gates for A1 (each exit 0): `pnpm test:consumer-modules`, `pnpm architecture:consumer-modules`,
`pnpm test:get-modular-adoption`, `pnpm architecture:get-modular-adoption`, `pnpm sdk-growth:profile`,
`pnpm test:ci`, `pnpm docs:protocol:check`.

### A2 `build(deps): adopt Get Modular Core and Assembly 0.3.0`

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

Gates for A2 (each exit 0): `pnpm install --frozen-lockfile`, `pnpm typecheck`,
`pnpm --filter "@agent-teams/embedded-runtime..." run build`, `pnpm --filter @agent-teams/embedded-runtime test`,
`pnpm architecture:get-modular-adoption`, `pnpm test:get-modular-adoption`, `pnpm docs:qualification`,
`pnpm foundation:check`, `node scripts/ci/audit-node-engine-compatibility.mjs --check`.

### A3 `docs(architecture): record the 0.3.0 adoption`

`docs/architecture/get-modular-adoption.md` "Status and authority": the release table (around line 133) to 0.3.0 with
the new SHA-256 values; "The profile retains the approved published Core and Assembly 0.3.0 archives"; one sentence
with `REL_SHA` as the release commit, the bundle name `get-modular-0.3.0-train-r1a` and its source commit, and a link to
the closed draft PR as pre-publication evidence (no local paths or machine names).
Gate: `pnpm docs:protocol:check`.

Final gates: the local full gates of section 2 after the last commit.

## 6. Risks and stop conditions

- Registry bytes differ from the bundle (`SHA256SUMS`, `INTEGRITY`), or the CMS at `REL_SHA` differs from `81063ad`: stop.
- Another PR merged into `architecture/get-modular/**`, `scripts/architecture/check-*` or the CMS evidence after
  `0ace1cce`: rebase, re-read, and stop if a step no longer fits.
- A test outside the files listed here starts failing on the pin change: stop and report the file and assertion; do not
  extend this brief silently.
- `runtime-macos` above 12 minutes: report to the owner.

## 7. Must not

Delete or edit historical review, delta or retained standard files other than the steps above; delete 0.1.0 or 0.2.0
archives; change `consumer-module-standard-pin.mjs`; add `as never`, `any` or double casts; change package.json
scripts or workflows; follow a moving get-modular main; add co-author trailers or text about how the change was produced.

## 8. Done

Required checks green on the PR head (`check`, `docs-protocol / docs-protocol-check`, `postgres-durability`,
`runtime-macos`, `commit-author-identity`); independent review clean and re-run after fixes; owner merges.

## 9. Review checklist (owner's reviewer)

1. `shasum -a 256 architecture/get-modular/evidence/consumer-module-standard.md` = `49d08b6d...`; the same as
   `git -C <gm> show 81063add7de50ffe2b91cc74bf7271b298624c21:docs/architecture/common-assembly.md | shasum -a 256`
   and the same for `REL_SHA`;
   `consumer-module-standard-9c722cef.md` = `33b41d5b...`.
2. Delta: regenerate it as in A1 step 3 and `cmp` with the committed file; review `delta.sha256` equals its SHA-256.
3. Read the new CMS sections "Module resource scopes", "Dynamic instances", "Module packages and contracts",
   "Identity and namespaces" and "Testing modules" against the `normDisposition` rows; only rows closed by AR-1a say
   `met`, every other row says `pending: <PR>`, `outstanding` or `not applicable`, true at this PR head.
   `node -p "require('./architecture/get-modular/evidence/train-030-cms-pin-review.json').normDisposition.filter(r => r.state === 'met').map(r => r.closedBy)"`
   lists only `AR-1a`.
4. Mutations, each in a scratch clone at the PR head, each committed on a detached HEAD (several checks read git),
   each started again from the PR head; each must make the named command exit non-zero:
   - profile `standard.commit` back to `9c722ce...`: `pnpm architecture:get-modular-adoption` and `pnpm architecture:consumer-modules`;
   - one byte appended to `consumer-module-standard.md`: both;
   - contained-turn `gitCommit` changed: `pnpm architecture:consumer-modules` (`pins must agree`);
   - remove the `"assembly.run.invalid-inputs"` row: `pnpm typecheck`;
   - profile `archiveSha256` of Core changed by one hex digit: `pnpm architecture:get-modular-adoption`.
5. `npm view @get-modular/core@0.3.0 dist.integrity` equals `packages['@get-modular/core@0.3.0'].resolution.integrity`
   in `pnpm-lock.yaml` and the SHA-512 of the committed archive (same for Assembly).
6. The lines replaced in `check-get-modular-adoption.mjs` keep a comment with reason and restore condition, and the
   historical validators still run (`grep -n "validateParallelStandardMigrations" scripts/architecture/check-get-modular-adoption.mjs`).
7. `git diff origin/main -- '*.ts' '*.mjs' | grep -c '^+.*as never'` is 0.

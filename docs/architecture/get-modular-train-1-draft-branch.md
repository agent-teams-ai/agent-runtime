---
id: runtime.architecture.get-modular-train-1-draft-branch
type: architecture
status: active
owner: architecture
summary: Draft branch that proves the whole Get Modular train 1 migration before the pull requests.
---

# Get Modular Train 1 Draft Branch

Draft branch on the retained R-1a archives, never merged. Purpose: prove the whole Agent Runtime migration (AR-1a, AR-1b, AR-1c, AR-2) against the exact archives that will be
published, before npm publication. npm versions are immutable. A Get Modular defect found here is fixed in
get-modular, not worked around in Agent Runtime.

Branch `draft/gm-train-030`, pushed with a draft PR titled
`draft: Get Modular 0.3.0 train on retained archives (do not merge)`; it is never marked ready, never merged, and is
closed by the owner after npm publication.

## 1. Handoff inputs (the owner fills these; do not start with a placeholder left)

The release work (get-modular step R-1a) produces one bundle directory named `get-modular-0.3.0-train-r1a` with
exactly: `get-modular-core-0.3.0.tgz`, `get-modular-assembly-0.3.0.tgz`, `get-modular-resources-0.1.0.tgz`,
`get-modular-conformance-0.1.0.tgz`, `SHA256SUMS` (`shasum -a 256` format), `INTEGRITY` (lines
`<file> sha512-<base64>`), and `release-intent.md` (source commit and tree, CI runs, per-archive bytes, SHA-256 and
SHA-512, packed-manifest facts, registry state). This branch uses all four archives: Core, Assembly and resources in
production code, conformance as the development-only test kit of AR-1c.

| Input | Value |
|---|---|
| Owner answer, release question Q3 (where the bundle lives) and how to fetch it | `<fill: get-modular path and commit, or another location>` |
| `SOURCE_SHA`: the bundle's source commit from `release-intent.md` (the final head of the open release PR) | `<fill>` |
| `SHA256SUMS` and `INTEGRITY` contents (copied from the bundle) | `<fill>` |
| Release PR number in get-modular | `<fill>` |

Cross-check values from release rehearsal #3 (packed on get-modular `81063ad`; if get-modular `main` did not change
`packages/`, `architecture/`, `pnpm-lock.yaml` or `package.json` before the release, the bundle has the same values):
Core 50039 bytes, SHA-256 `bd84c087c7d6842907d08a1a2f6dc0afd250e297f9456e0f77b87630e0f5093e`; Assembly 20633 bytes,
`3a4312465485269971db08efb10759fb3a3d4d23266c7f5d9fe8069b4bb411c8`; resources 13816 bytes,
`1172c89d9f863d0e1763293eb6153d0835c609fc01ea730004fcee293872cc7a`. Conformance bytes are not reproducible (pnpm
writes its `peerDependencies` keys in a varying order), so compare conformance only against the bundle's
`SHA256SUMS`. The bundle's own `SHA256SUMS` is authoritative; a difference from these cross-check values is not an
error by itself, but report it.

Owner decisions (2026-10-08): release question Q2 is option A (the release PR stays open, the bundle is packed from
its final head after review and CI, the owner merges it after signing off these checks; the release branch is updated
without force pushes), and the publication gate below is option 1 of three.

Publication gate (decided by the owner on 2026-10-08): milestones M1 to M4 green locally (the local full gates of
section 3); on the M4 head the draft PR's required checks (`check`, `docs-protocol / docs-protocol-check`, `postgres-durability`,
`runtime-macos`, `commit-author-identity`) and the job `install-build-runtime (Node 26.10.0)` of workflow
`Node 26 Compatibility` are green; that job is reported as the "Node 26.10+ consumer" result for Agent Runtime.
Blocking findings (any one stops publication): (a) a public type of Core, Assembly, resources or conformance that
forces a cast, `any`, `as never` or an explicit `prepare<R>()` argument, or infers wrongly; (b) a runtime defect in
Assembly, resources or conformance reproduced with a minimal case (outcome, cleanup order, close and retry,
`scoped()`, `smoke` or `isolate` verdicts); (c) a packaging defect (dependencies, peers, engines, exports, files; an
install failure under `--strict-peer-dependencies` or `--engine-strict`; a Node 26.10 install, build or test failure
caused by the archives); (d) any integrity mismatch between bundle, lockfile and retained copy. Not blocking npm: a
defect in the standard's text (it blocks the AR-1a pin until a standard revision), an Agent Runtime defect (fixed
here and in its brief), a CI failure that passes on one re-run and is recorded.

## 2. Re-verify before start (stop on any mismatch that touches a file this branch edits)

Facts at agent-runtime `0ace1cce` (2026-10-04):

```sh
git fetch origin && git log --oneline -3 origin/main
cat .node-version                                  # 24.21.0
node -p "JSON.stringify(require('./package.json').engines)"   # {"node":">=24.21.0 <25 || >=26.10.0 <27","pnpm":"11.18.0"}
grep -n '"packageManager"\|"@agent-teams/engineering-foundation"' package.json   # pnpm@11.18.0, 1.7.2
grep -n "catalogMode\|strictPeerDependencies\|minimumReleaseAge:\|@get-modular" pnpm-workspace.yaml
#   catalogMode: strict, strictPeerDependencies: true, minimumReleaseAge: 0,
#   '@get-modular/core': 0.2.0, '@get-modular/assembly': 0.2.0, excludes @get-modular/{core,assembly}@0.2.0
gh api repos/agent-teams-ai/agent-runtime/rules/branches/main \
  --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
gh pr list --repo agent-teams-ai/agent-runtime --state open   # at base: #180 (draft, provider-access), #72
grep -n "9c722ce\|33b41d5" architecture/get-modular/consumer-profile.json architecture/consumer-module-standard/contained-turn-profile.json
grep -n "cmsPinReviewPath =" scripts/architecture/check-cms-pin.mjs   # creation-cleanup-cms-pin-review.json
```

The bundle (in its own directory, never inside a repository checkout):

```sh
shasum -a 256 -c SHA256SUMS                       # every line OK
for f in *.tgz; do printf '%s sha512-%s\n' "$f" "$(openssl dgst -sha512 -binary "$f" | openssl base64 -A)"; done | diff - INTEGRITY   # no output
for f in *.tgz; do tar -xOzf "$f" package/package.json | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(m.name, m.version, JSON.stringify(m.dependencies||{}), JSON.stringify(m.peerDependencies||{}), JSON.stringify(m.engines))'; done
```

Expected manifests: Assembly depends on exactly `"@get-modular/core": "0.3.0"`; conformance has peers
`@get-modular/assembly ^0.3.0`, `@get-modular/core ^0.3.0`, `@get-modular/resources ^0.1.0` (in any key order);
resources and conformance have no dependencies; every `engines.node` is `>=24.18.0 <25 || >=26.10.0 <27`. Never
re-pack an archive to verify it: the first retained bytes are authoritative.

In a disposable get-modular clone (`git fetch origin` and `git fetch origin pull/<release PR>/head`):

```sh
git cat-file -e "$SOURCE_SHA^{commit}" && echo present
git show "$SOURCE_SHA:docs/architecture/common-assembly.md" | shasum -a 256
#   expected 49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7 (bytes of 81063ad, 47402 bytes);
#   the release PR does not touch this file
test "$(git rev-parse "$SOURCE_SHA:docs/architecture/common-assembly.md")" = "$(git rev-parse 81063ad:docs/architecture/common-assembly.md)" && echo same
```

If the standard bytes at `SOURCE_SHA` differ from `81063ad`, stop and ask: the release would ship with a standard
revision other than the one both consumers pin.

## 3. Environment

- Work in your own fresh clone of agent-runtime (or a worktree of a checkout you own), never in a checkout another
  session uses. Free disk at least 4 GB before `pnpm install`; on ENOSPC stop.
- Node from `.node-version` (24.21.0, official build). pnpm 11.18.0 through corepack without touching shared global
  shims and without files inside the clone: `T="$(mktemp -d)"; corepack enable --install-directory "$T/bin" && export PATH="$T/bin:$PATH"`.
  (`openssl base64 -A` is used for SRI strings below because GNU `base64` wraps lines on Linux.)
- Node 26.10 or newer is not installed on the owner's machine (only 26.9.0 on 2026-10-04). Do not install or
  upgrade a shared Node. Node 26.10 coverage comes from the agent-runtime workflow `Node 26 Compatibility`
  (`install-build-runtime (Node 26.10.0)`: engine audit, strict install, build and package tests) on the draft PR, or,
  without a draft PR, from a hosted worker or an official Node 26.10.x tarball checked against its `SHASUMS256.txt` in
  a private directory.
- A global git hook on developer machines breaks git fixture tests. Run local checks with a git config that holds
  only the identity, kept outside the clone: `printf '[user]\n\tname = iliya\n\temail = iliyazelenkog@gmail.com\n' > "$T/gitconfig-user-only"`
  and prefix checks with `GIT_CONFIG_GLOBAL="$T/gitconfig-user-only"`.

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
- Before the first commit: `git config user.name` prints `iliya` and `git config user.email` prints
  `iliyazelenkog@gmail.com`. If not, set exactly these values in the clone's local config (the same values the
  owner's checkout uses). Never pass `-c` overrides.

## 4. How the branch consumes the archives, and publicity

Mechanism (decided): the four archives are committed under `architecture/get-modular/evidence/` (the existing place
for retained Get Modular archives) and installed through a `pnpm-workspace.yaml` `overrides` block with
repository-relative `file:` paths. Reasons: GitHub CI can install them with `pnpm install --frozen-lockfile`; the
lockfile then records the archives' SHA-512, which is exactly the value npm will report; the real AR-1a commits the
Core and Assembly archives at the same paths, so the adoption gate checks the same bytes. Absolute paths to a
location outside the repository would break CI and fresh clones; a tarball URL would add a network dependency and
still needs the retained copy for the adoption gate.

Publicity: agent-runtime is a public repository, so pushing this branch makes the pre-release archives public before
npm publication. Owner decision (2026-10-02): the draft branch is a draft PR on GitHub, closed after publication; the
get-modular release plan records the resulting publicity as accepted. Consequences:

- If the release PR is regenerated after a finding (same version numbers, new bytes), two different byte sets of
  "0.3.0" exist publicly: the superseded one in this branch's history and the published one on npm. Nobody installs
  from this branch, and every consumer verifies by checksum, so the practical risk is confusion only. On
  regeneration, rebuild D0 on a fresh branch and say in the draft PR description which bundle `SOURCE_SHA` is current.
- Under release question Q3-A the bundle is already public in get-modular, so this branch exposes nothing new.

Only if the owner withdraws that decision before handoff: do not push the branch. Run the macOS milestones locally,
and the Linux and PostgreSQL parts (`postgres-durability` steps of `.github/workflows/ci.yml`, the `Node 26 Compatibility` steps) on an
isolated hosted worker with its own directories and ports, then report in the release intent record instead of a PR
description.

## 5. Scope and non-goals

In scope: commit D0 (draft-only consumption of the archives), then the commits of AR-1a, AR-1b, AR-1c and AR-2 exactly
as their briefs describe them (`docs/architecture/get-modular-train-1-ar-1a.md`, `-ar-1b.md`, `-ar-1c.md`,
`-ar-2.md`), with the differences listed in section 6.

Non-goals: merging anything; changing get-modular; publishing; changing `.github/workflows/*`, rulesets or package.json
scripts; re-enabling the gates disabled by AR-0 and AR-S; working around a Get Modular type or runtime defect in Agent
Runtime.

## 6. Steps

### D0 `chore(draft): consume retained R-1a archives through overrides (never merge)`

1. Copy the four archives into `architecture/get-modular/evidence/` and verify each against `SHA256SUMS` and
   `INTEGRITY` of the bundle:

   ```sh
   cd architecture/get-modular/evidence
   shasum -a 256 get-modular-core-0.3.0.tgz get-modular-assembly-0.3.0.tgz get-modular-resources-0.1.0.tgz get-modular-conformance-0.1.0.tgz
   for f in get-modular-core-0.3.0.tgz get-modular-assembly-0.3.0.tgz get-modular-resources-0.1.0.tgz get-modular-conformance-0.1.0.tgz; do
     printf '%s sha512-%s\n' "$f" "$(openssl dgst -sha512 -binary "$f" | openssl base64 -A)"; done
   ```

   One mismatch: stop.
2. `pnpm-workspace.yaml`, append:

   ```yaml
   # DRAFT ONLY (branch draft/gm-train-030, never merge): retained R-1a archives before npm publication.
   overrides:
     '@get-modular/core': file:architecture/get-modular/evidence/get-modular-core-0.3.0.tgz
     '@get-modular/assembly': file:architecture/get-modular/evidence/get-modular-assembly-0.3.0.tgz
     '@get-modular/resources': file:architecture/get-modular/evidence/get-modular-resources-0.1.0.tgz
     '@get-modular/conformance': file:architecture/get-modular/evidence/get-modular-conformance-0.1.0.tgz
   ```

   The override is needed because Assembly 0.3.0 depends on exactly `@get-modular/core@0.3.0`, which is not on npm yet.
3. Teach two readers the override lock shape, each change marked `// DRAFT ONLY (draft/gm-train-030, never merge)`.
   Verified with pnpm 11.18.0 (`catalogMode: strict`, `strictPeerDependencies: true`, an override to a `file:`
   tarball, also through an exact transitive dependency and a peer): the lock has no `catalogs` entry for the
   package; the importer has `specifier: file:../../../architecture/get-modular/evidence/<archive>` and
   `version: file:architecture/get-modular/evidence/<archive>`; `packages` has the key
   `'<name>@file:architecture/get-modular/evidence/<archive>'` with
   `resolution: {integrity: sha512-<base64>, tarball: file:architecture/get-modular/evidence/<archive>}` and
   `version: <x.y.z>`; the integrity is the SHA-512 of the archive bytes; `lock.overrides[<name>]` equals the
   workspace value.
   - `scripts/architecture/check-get-modular-adoption.mjs`, `readPackageArtifact` (lines 134-152 at the base): at the
     top, when `lock.overrides?.[pkg.name] === 'file:' + pkg.archivePath`, require `specifier === 'catalog:'`,
     `workspace.catalog[pkg.name] === pkg.version`, importer `version === 'file:' + pkg.archivePath`,
     `lock.packages['<name>@file:<archivePath>'].version === pkg.version`, and the SHA-512 of the retained bytes equal to
     that entry's integrity, throwing `lock archive integrity drift: <name>` on a mismatch (the message the registry
     path uses); return the same record as today. The registry path stays unchanged.
   - `packages/apps/embedded-runtime/tests/package/assembly-packed-consumer.test.ts`, `withVerifiedArchives`
     (lines 56-59): also accept the entry `  '${name}@file:${pin.archivePath}':` and the resolution regex with an
     optional `, tarball: file:[^}]+` before `}`. The SHA-512 comparison stays.
4. `pnpm install` (not frozen; only Get Modular entries may change), then `pnpm install --frozen-lockfile`.
   `grep -n "get-modular" pnpm-lock.yaml` must show the shape above and integrities equal to `INTEGRITY`.

D0 alone is expected to be red (the current code does not compile against Assembly 0.3.0). Only the milestone gates
below count on this branch.

### Milestones

After D0, apply the commits of each brief in order. Differences from the real PRs:

- Archives are already in place from D0. The real AR-1a and AR-1c download the published tarballs with
  `npm pack <name>@<version>` (a download, not a pack from source) and compare them with the bundle by `SHA256SUMS`.
- AR-1a commit A1 pins the Consumer Module Standard to `81063ad` (get-modular #142), exactly as the real AR-1a will
  (planning decision 2026-10-04: the pin names the commit that defines the standard revision, independent of when the
  release PR merges); the check in section 2 proves the bytes at `SOURCE_SHA` are the same. In the review JSON set
  `releaseBundleSourceCommit` to `SOURCE_SHA` and leave out `releaseCommit` (the release PR is still open); the real
  AR-1a adds it.
- ADR-0024 (AR-1c commit C1) stays `proposed` on this branch: do not set it accepted and do not run the baseline
  promotion; acceptance happens only in the real AR-1c after the owner approves the text.
- The registry steps of the four briefs' "Re-verify before start" (`npm view ... dist.integrity`, `npm pack`) are
  skipped here: before publication they return E404, and section 2 of this brief replaces them. The AR-2 check
  `... some(d => d.id === 'ADR-0024')  # true` prints `false` here, as expected (ADR-0024 stays proposed). The CMS
  upstream comparison of AR-1b, AR-1c and AR-2 compares get-modular `main` with the standard pinned by A1 (`81063ad`).
- AR-1a commit A3 links this open draft PR; the real AR-1a links it after the owner closed it.
- AR-1a section 0 (handoff inputs) and the `REL_SHA` lines of AR-1a section 2 (the byte loop entry for `REL_SHA`, the
  `merge-base` check, the tree check) do not apply here; section 1 of this brief supplies `SOURCE_SHA`, and section 2
  of this brief checks it.
- The lockfile is regenerated with the overrides block. Real PRs follow "Porting a draft commit" below.

| Milestone | Commits | Local gates, each must exit 0 | Push |
|---|---|---|---|
| M1 | AR-1a A1, A2, A3 | `pnpm install --frozen-lockfile`, the local full gates of section 3 | push, wait for draft PR CI |
| M2 | AR-1b B1 to B5 | same | same |
| M3 | AR-1c C1 to C6 | same, plus `pnpm --filter @agent-teams/embedded-runtime test` twice in a row (flake probe) | same |
| M4 | AR-2 P1 to P3 | same, plus `pnpm --filter @agent-teams/provider-access check` | same |

Run each milestone's local full gates in a fresh clone of the head as well, because some tests read committed files
and git history.

Expected draft-only findings, and how to treat them:

- None. Foundation 1.7.2 rejects `overrides` only for the Foundation package itself, and its registry assertion
  checks only Foundation, so the Get Modular overrides pass `pnpm foundation:check`. If it fails anyway, stop and
  report the exact message; do not change Foundation configuration (a red `foundation` lane makes the required
  `check` red, so the publication gate cannot be met until the owner decides).

### Porting a draft commit to a real PR branch

Start the real PR branch from fresh `origin/main`. Some commits differ by design and are re-done from their brief
instead of picked: A2 and C2 (archives come from the registry download, the lockfile from the registry), A3 (link to
the closed draft PR), C1 (ADR-0024 accepted after the owner approved the text). A1 is picked, then the review JSON gets
`releaseCommit: <REL_SHA>` and refresh `reviewedOn`, `sourceMainCommit` and `sourceMainDocumentCommit` to the values at
the real review (the byte checks of AR-1a section 2 must pass again); amend the picked commit before the first push
(the branch is unshared). For every other
draft commit of that PR (never D0):

1. `git cherry-pick -x <draft commit>`.
2. On a conflict in `pnpm-workspace.yaml`, keep the `origin/main` side around the conflict and take only the brief's
   own lines (catalog entries, `minimumReleaseAgeExclude`); the overrides block never enters a real branch.
3. On a conflict in `pnpm-lock.yaml`, or whenever the commit changed dependencies, run `pnpm install` against the
   registry (pnpm resolves lockfile conflicts by re-resolving and drops the `file:` entries once the overrides block
   is absent), then `pnpm install --frozen-lockfile`, and `git add` the result.
4. Never use `git checkout --`, `git restore`, `git reset --hard` or `git clean -f` to resolve anything. If a
   conflict cannot be resolved this way, abort with `git cherry-pick --abort` and re-implement that commit from the
   brief.
5. Before pushing: `git diff origin/main -- pnpm-lock.yaml pnpm-workspace.yaml | grep -c 'file:architecture'` prints 0,
   and `git log -S"DRAFT ONLY" origin/main..HEAD` is empty.

### Report and findings

Open the draft PR after M1 (own PR, English, plain) and keep its description updated with one table:
milestone, head SHA, bundle `SOURCE_SHA`, each gate with exit code and duration, CI run links, findings. Copy the
final result into the "Consumer checks on these bytes" table of the bundle's `release-intent.md` through the release
owner (this brief does not edit get-modular). Classify every finding as "Get Modular" (API, types, runtime behavior,
packaging, standard text) or "Agent Runtime".

- Get Modular finding: stop and report it to the owner with a minimal reproduction. The fix lands on get-modular
  `main` as a normal feature PR, the open release PR is regenerated without a version change, a new bundle is packed,
  and the draft is rebuilt from a new D0 on the branch `draft/gm-train-030-r2` (`-r3` and so on for later rounds) with
  a new draft PR; the owner closes the previous draft PR.
- Agent Runtime finding: fix it on this branch and report it to the planner so the owning brief is corrected before
  its real PR.

## 7. Risks and stop conditions

- Archive mismatch anywhere (bundle `SHA256SUMS`/`INTEGRITY`, evidence copy, lock integrity): stop; reading and
  comparing only. Never re-pack to "fix" or "verify" an archive.
- A type error that only `as never`, a double cast or `any` would silence: stop; it is a Get Modular finding.
- A test expectation that changes between Assembly 0.2.0 and 0.3.0 without an entry in the 0.3.0 changelog
  (`package/CHANGELOG.md` in the archive): stop; Get Modular finding.
- `strictPeerDependencies` refuses the conformance peers: stop; Get Modular packaging finding.
- Any ambiguity in a brief: stop and ask; do not guess.
- `runtime-macos` above 12 minutes: report to the owner (limit 15).

## 8. Must not

Merge, mark ready, or request merge; push to `main`; force-push
anything but this own branch; publish; edit archives; edit workflows, rulesets or scripts in `package.json`;
re-enable gates disabled by AR-0 or AR-S; leave a `DRAFT ONLY` hunk outside D0; commit tool directories or local configs;
put local paths or machine names into commits or the PR description.

## 9. Done

All milestones meet the owner's publication-gate answer; the report is complete; the owner has it. After npm
publication the owner closes the draft PR; the branch stays until AR-2 merges (it is the source of the cherry-picks).
Only the owner deletes `draft/gm-train-030` and any `-rN` retry branches, after AR-2 merges.

## 10. Review checklist (owner's reviewer)

1. `git log --format='%h %s' origin/main..draft/gm-train-030` shows D0 first, then the commits of the four briefs in order.
2. `git log --format=%h -S"DRAFT ONLY" origin/main..draft/gm-train-030` lists only D0.
3. Archives: in the branch's `architecture/get-modular/evidence/`, the four files match the bundle's `SHA256SUMS`
   (`shasum -a 256 -c` with the bundle file) and `INTEGRITY`; the lock integrities equal `INTEGRITY`.
4. Mutation spot-check of the draft reader patch: in a scratch clone at the branch head, append one byte to
   `get-modular-core-0.3.0.tgz` and commit it on a detached HEAD (several checks read git), run
   `pnpm architecture:get-modular-adoption`; it must exit non-zero with `lock archive integrity drift`. Throw the clone
   away afterwards.
5. `git diff origin/main..draft/gm-train-030 -- '*.ts' | grep -c '^+.*as never'` is 0.
6. Every finding in the report has a classification and an owner-visible outcome; the bundle `SOURCE_SHA` in the
   report equals the one in `release-intent.md`.

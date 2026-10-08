---
id: runtime.architecture.test-debt-189-06-fixture-copies
type: architecture
status: active
owner: architecture
summary: "Brief 06 for issue 189: outcome record for the copied fixtures, settled outside the issue."
---

# Test Debt 189 06 Fixture Copies

**Brief 06: copied fixtures under embedded-runtime `support/external` (outcome: settled outside #189)**

Issue: agent-teams-ai/agent-runtime#189, item 2. Decided during planning on 2026-10-04 (decision Q1 of the index, option
A): #189 covers the Get Modular modules only. The 35 fixture copies and the contained-turn casts are settled by the
CONTAINED-REMOVAL decision of the architecture program plan. Nothing in this brief is implemented in #189.

## 1. Why (facts verified on `5ac0d003`)

- `packages/apps/embedded-runtime/tests/package/support/external/**` holds 35 files: 27 from agent-execution, 5 from
  provider-access, 3 from runtime-security.
- Compared with the originals under `packages/contexts/<owner>/tests/**`: 7 byte-identical, 15 identical except import
  lines, 13 drifted (12 by 1 to 7 non-import lines, `agent-execution/contained-turn-kernel-fixtures.ts` by 121 lines:
  copy 236, original 340).
- Every user is a contained-turn test (28 embedded-runtime test files reference `support/external`). Contained-turn is
  not developed further (program plan decision 1).
- The originals import internal compiled paths (`../../../dist/features/...`); the copies import the public
  `@agent-teams/<owner>/composition` subpaths (they date from the curated-composition change `1a262498`, moved by
  `f2340571` and `bea095d1`). Replacing the copies with imports needs owner test packages (program plan decision 16,
  created by STORE-0) and, for some fixtures, exports that the public surface lacks.
- Historical evidence under `docs/spikes/runtime-setup-assembly-adoption-v2-*.json` lists the copies with digests; it
  is retained evidence of a disabled lane and is never edited.

## 2. What happens instead

1. The docs PR of the index records in `docs/architecture/agent-runtime-architecture-program-plan.md` (lane row
   "Issue #189 test debt" in section 4.1, and section 6.4): the copies and the contained-turn casts move to
   CONTAINED-REMOVAL. If contained-turn is removed, they are deleted with it. If the owner keeps contained-turn, a new
   brief moves the fixtures into the owners' private test packages (STORE-0 mechanism), ports the originals' changes
   into the public-import versions, and settles any missing export with the owner.
2. When briefs 01-05 and 07 are merged, the owner closes #189 with a comment that lists them and this deferral (the
   owner posts it).

## 3. Measurement commands (for whoever picks this up later)

Seven copies share a file name with two originals, so a plain file-name match prints 42 lines. Pick the original at
the same relative path under `tests/` when it exists, else the single original with that file name:

```sh
B=packages/apps/embedded-runtime/tests/package/support/external
git ls-tree -r --name-only origin/main -- "$B" | wc -l
for f in $(git ls-tree -r --name-only origin/main -- "$B"); do
  rel=${f#$B/}; owner=${rel%%/*}; rest=${rel#*/}; base=$(basename "$f")
  c="packages/contexts/$owner/tests/$rest"
  git cat-file -e "origin/main:$c" 2>/dev/null || c=$(git ls-tree -r --name-only origin/main -- "packages/contexts/$owner/tests" | grep "/$base\$")
  [ "$(printf '%s\n' "$c" | grep -c .)" = 1 ] || { echo "AMBIGUOUS $rel: $c"; continue; }
  norm() { git show "origin/main:$1" | grep -v -E '^\s*(import|export \{[^}]*\} from)|from "' | shasum | cut -c1-12; }
  if [ "$(git rev-parse "origin/main:$f")" = "$(git rev-parse "origin/main:$c")" ]; then s=IDENTICAL
  elif [ "$(norm "$f")" = "$(norm "$c")" ]; then s=IMPORTS-ONLY; else s=DRIFT; fi
  echo "$s $rel <- $c"
done | sort | awk '{print $1}' | uniq -c
git grep -l "support/external" origin/main -- packages/apps/embedded-runtime/tests | wc -l
```

On `0ace1cce` the classification is 7 identical, 15 imports-only, 13 drift (the import filter is approximate; an
AMBIGUOUS line means the rule above did not find one original and needs a manual look).

## 4. Must not (until CONTAINED-REMOVAL is decided)

- Add new files under `support/external`, or new contained-turn copies elsewhere.
- Edit the historical evidence JSON files.

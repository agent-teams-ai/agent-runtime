import assert from 'node:assert/strict';

// Closed, reviewed full workflow contract. Every job/step/key and shell program
// is checked: additional conditions, permissions, inputs, actions or commands
// fail rather than acquiring authority from the workflow being validated.
// These literal structures are separate from runtime registration metadata.
const foundationContract = {
  "name": "Full Foundation gate",
  "on": {
    "workflow_call": {
      "inputs": {
        "revision": {
          "required": true,
          "type": "string"
        },
        "artifact": {
          "required": true,
          "type": "string"
        }
      }
    }
  },
  "permissions": {
    "contents": "read"
  },
  "jobs": {
    "fixtures": {
      "strategy": {
        "fail-fast": false,
        "matrix": {
          "index": [
            0,
            1,
            2
          ]
        }
      },
      "uses": "./.github/workflows/ci-foundation-shard.yml",
      "with": {
        "revision": "${{ inputs.revision }}",
        "artifact": "${{ inputs.artifact }}",
        "index": "${{ matrix.index }}"
      }
    },
    "remainder": {
      "runs-on": "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork && 'ubuntu-24.04' || vars.CI_LINUX_RUNNER || 'ubuntu-24.04' }}",
      "timeout-minutes": 20,
      "env": {
        "GIT_AUTHOR_NAME": "iliya",
        "GIT_AUTHOR_EMAIL": "iliyazelenkog@gmail.com",
        "GIT_COMMITTER_NAME": "iliya",
        "GIT_COMMITTER_EMAIL": "iliyazelenkog@gmail.com",
        "EXPECTED_REVISION": "${{ inputs.revision }}",
        "ARTIFACT_PREFIX": "${{ inputs.artifact }}"
      },
      "steps": [
        {
          "name": "Checkout exact revision with full history",
          "uses": "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
          "with": {
            "ref": "${{ inputs.revision }}",
            "persist-credentials": false,
            "fetch-depth": 0
          }
        },
        {
          "name": "Guard inputs and retained C0 before repository code",
          "shell": "bash",
          "run": "set -euo pipefail\n[[ \"$EXPECTED_REVISION\" =~ ^[a-f0-9]{40}$ ]]\n[[ \"$ARTIFACT_PREFIX\" =~ ^[a-z][a-z0-9-]{0,60}$ ]]\ntest \"$(git rev-parse HEAD)\" = \"$EXPECTED_REVISION\"\nobject=8e5e859d10981e1623d0617e933afc68a9e8770c\nif ! git cat-file -e \"$object^{commit}\"; then\n  git fetch --no-tags origin \"$object\"\nfi\ntest \"$(git rev-parse \"$object^{commit}\")\" = \"$object\"\ngit fsck --connectivity-only --no-reflogs \"$object\"\n"
        },
        {
          "name": "Setup pinned Node",
          "uses": "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
          "with": {
            "node-version-file": ".node-version"
          }
        },
        {
          "name": "Enable pinned pnpm",
          "run": "corepack enable\ncorepack install --global pnpm@11.18.0\n"
        },
        {
          "name": "Frozen install",
          "run": "pnpm install --frozen-lockfile"
        },
        {
          "name": "Run every original remainder command in serial order",
          "shell": "bash",
          "run": "set -euo pipefail\nmkdir -p \"$RUNNER_TEMP/foundation-evidence\"\nphase() {\n  local label=\"$1\" start end status\n  shift\n  start=$(date +%s%3N)\n  set +e\n  \"$@\"\n  status=$?\n  set -e\n  end=$(date +%s%3N)\n  jq -n --arg revision \"$EXPECTED_REVISION\" --arg phase \"$label\" \\\n    --arg command \"$*\" --argjson exitCode \"$status\" --argjson start \"$start\" --argjson end \"$end\" \\\n    '{revision:$revision,phase:$phase,command:$command,exitCode:$exitCode,start:$start,end:$end}' \\\n    > \"$RUNNER_TEMP/foundation-evidence/remainder-$label.json\"\n  test \"$status\" -eq 0\n}\nphase 0 ./node_modules/.bin/agent-teams-foundation check\nphase 1 node --test scripts/docs/runtime-builtin-permissions.test.mjs scripts/ci/run-ordinary-postgres.test.mjs\nphase 2 pnpm foundation:assert-dev-only\nphase 3 pnpm foundation:assert-registry\nphase 4 pnpm quality:adoption\nphase 5 pnpm foundation:scaffold:check\n"
        },
        {
          "name": "Retain remainder phase evidence even on failure",
          "if": "${{ always() }}",
          "uses": "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          "with": {
            "name": "foundation-${{ env.ARTIFACT_PREFIX }}-remainder-${{ github.run_attempt }}",
            "path": "${{ runner.temp }}/foundation-evidence/remainder-*.json",
            "if-no-files-found": "error",
            "retention-days": 14
          }
        },
        {
          "name": "Publish successful remainder for same-run retries",
          "if": "${{ success() }}",
          "uses": "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          "with": {
            "name": "foundation-${{ env.ARTIFACT_PREFIX }}-remainder-current",
            "path": "${{ runner.temp }}/foundation-evidence/remainder-*.json",
            "if-no-files-found": "error",
            "retention-days": 14,
            "overwrite": true
          }
        }
      ]
    },
    "aggregate": {
      "if": "${{ always() }}",
      "needs": [
        "fixtures",
        "remainder"
      ],
      "runs-on": "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork && 'ubuntu-24.04' || vars.CI_LINUX_RUNNER || 'ubuntu-24.04' }}",
      "timeout-minutes": 5,
      "env": {
        "GIT_AUTHOR_NAME": "iliya",
        "GIT_AUTHOR_EMAIL": "iliyazelenkog@gmail.com",
        "GIT_COMMITTER_NAME": "iliya",
        "GIT_COMMITTER_EMAIL": "iliyazelenkog@gmail.com",
        "EXPECTED_REVISION": "${{ inputs.revision }}",
        "ARTIFACT_PREFIX": "${{ inputs.artifact }}",
        "NEEDS": "${{ toJSON(needs) }}"
      },
      "steps": [
        {
          "name": "Checkout exact revision with full history",
          "uses": "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
          "with": {
            "ref": "${{ inputs.revision }}",
            "persist-credentials": false,
            "fetch-depth": 0
          }
        },
        {
          "name": "Guard inputs and retained C0 before repository code",
          "shell": "bash",
          "run": "set -euo pipefail\n[[ \"$EXPECTED_REVISION\" =~ ^[a-f0-9]{40}$ ]]\n[[ \"$ARTIFACT_PREFIX\" =~ ^[a-z][a-z0-9-]{0,60}$ ]]\ntest \"$(git rev-parse HEAD)\" = \"$EXPECTED_REVISION\"\nobject=8e5e859d10981e1623d0617e933afc68a9e8770c\nif ! git cat-file -e \"$object^{commit}\"; then\n  git fetch --no-tags origin \"$object\"\nfi\ntest \"$(git rev-parse \"$object^{commit}\")\" = \"$object\"\ngit fsck --connectivity-only --no-reflogs \"$object\"\n"
        },
        {
          "name": "Setup pinned Node for aggregate environment",
          "uses": "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
          "with": {
            "node-version-file": ".node-version"
          }
        },
        {
          "name": "Enable pinned pnpm for aggregate environment",
          "run": "corepack enable\ncorepack install --global pnpm@11.18.0\n"
        },
        {
          "name": "Frozen install for aggregate environment",
          "run": "pnpm install --frozen-lockfile"
        },
        {
          "name": "Download every fixture and remainder report",
          "uses": "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
          "with": {
            "pattern": "foundation-${{ env.ARTIFACT_PREFIX }}-*-current",
            "path": "${{ runner.temp }}/foundation-evidence",
            "merge-multiple": false
          }
        },
        {
          "name": "Require complete observed coverage and successful remainder",
          "shell": "bash",
          "run": "set -euo pipefail\njq -en --argjson needs \"$NEEDS\" \\\n  '$needs | keys == [\"fixtures\",\"remainder\"] and all(.[]; .result == \"success\")'\n# This oracle reads the actual original-file registrations, never the helper table.\nexpected=$(sed -n 's/^  test(\"\\([^\"]*\\)\",.*$/\\1/p' scripts/architecture/source-dependency-adapter-boundaries.test.mjs | jq -Rsc 'split(\"\\n\")[:-1]')\nmapfile -t shards < <(find \"$RUNNER_TEMP/foundation-evidence\" -type f -name 'shard-*.json' | sort)\nmapfile -t remainder < <(find \"$RUNNER_TEMP/foundation-evidence\" -type f -name 'remainder-*.json' | sort)\ntest \"${#shards[@]}\" -eq 3\ntest \"${#remainder[@]}\" -eq 6\njq -se --arg revision \"$EXPECTED_REVISION\" --argjson expected \"$expected\" '\n  ($expected | length == 25 and (unique | length == 25)) and\n  (sort_by(.index) | map(.index) == [0,1,2]) and\n  all(.[];\n    .protocol == \"foundation-fixtures/1\" and .revision == $revision and .exitCode == 0 and\n    (.start | type == \"number\") and (.end >= .start) and\n    (.registrations | length == 1) and\n    (.registrations[0] as $r |\n      $r.protocol == \"foundation-fixtures/1\" and $r.index == .index and $r.count == 3 and\n      $r.encountered == $expected and\n      $r.registered == [$expected | to_entries[] | select(.key % 3 == $r.index) | .value] and\n      $r.excluded == [$expected | to_entries[] | select(.key % 3 != $r.index) | .value] and\n      ([.events[] | select(.type == \"test\") | .name] == $r.registered) and\n      ([.events[] | select(.type == \"suite\") | .name] == [\"installed Foundation adapter boundary checks\"]) and\n      (.events | length == ($r.registered | length) + 1) and\n      all(.events[]; .status == \"passed\" and .skip == false and .todo == false and\n        ((.type == \"test\" and .nesting == 1) or (.type == \"suite\" and .nesting == 0))) and\n      (.summaries | length > 0) and all(.summaries[];\n        .success == true and .counts.tests == ($r.registered | length) and\n        .counts.passed == .counts.tests and .counts.suites == 1 and\n        .counts.failed == 0 and .counts.cancelled == 0 and .counts.skipped == 0 and .counts.todo == 0))) and\n  ([.[].registrations[0].registered[]] | sort == ($expected | sort))\n' \"${shards[@]}\"\njq -se --arg revision \"$EXPECTED_REVISION\" '\n  sort_by(.phase) | . as $phases | map(.command) == [\n    \"./node_modules/.bin/agent-teams-foundation check\",\n    \"node --test scripts/docs/runtime-builtin-permissions.test.mjs scripts/ci/run-ordinary-postgres.test.mjs\",\n    \"pnpm foundation:assert-dev-only\", \"pnpm foundation:assert-registry\",\n    \"pnpm quality:adoption\", \"pnpm foundation:scaffold:check\"] and\n  map(.phase) == [\"0\",\"1\",\"2\",\"3\",\"4\",\"5\"] and\n  all(.[]; .revision == $revision and .exitCode == 0 and (.start | type == \"number\") and .end >= .start) and\n  all(range(1;6); . as $i | $phases[$i].start >= $phases[$i - 1].end)\n' \"${remainder[@]}\"\n"
        }
      ]
    }
  }
};

const shardContract = {
  "name": "Foundation fixture partition",
  "on": {
    "workflow_call": {
      "inputs": {
        "revision": {
          "required": true,
          "type": "string"
        },
        "artifact": {
          "required": true,
          "type": "string"
        },
        "index": {
          "required": true,
          "type": "number"
        }
      }
    }
  },
  "permissions": {
    "contents": "read"
  },
  "jobs": {
    "shard": {
      "runs-on": "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork && 'ubuntu-24.04' || vars.CI_LINUX_RUNNER || 'ubuntu-24.04' }}",
      "timeout-minutes": 15,
      "env": {
        "GIT_AUTHOR_NAME": "iliya",
        "GIT_AUTHOR_EMAIL": "iliyazelenkog@gmail.com",
        "GIT_COMMITTER_NAME": "iliya",
        "GIT_COMMITTER_EMAIL": "iliyazelenkog@gmail.com",
        "EXPECTED_REVISION": "${{ inputs.revision }}",
        "ARTIFACT_PREFIX": "${{ inputs.artifact }}",
        "FOUNDATION_FIXTURE_PROTOCOL": "foundation-fixtures/1",
        "FOUNDATION_FIXTURE_INDEX": "${{ inputs.index }}",
        "FOUNDATION_FIXTURE_COUNT": "3"
      },
      "steps": [
        {
          "name": "Checkout exact revision with full history",
          "uses": "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
          "with": {
            "ref": "${{ inputs.revision }}",
            "persist-credentials": false,
            "fetch-depth": 0
          }
        },
        {
          "name": "Guard inputs and retained C0 before repository code",
          "shell": "bash",
          "run": "set -euo pipefail\n[[ \"$EXPECTED_REVISION\" =~ ^[a-f0-9]{40}$ ]]\n[[ \"$ARTIFACT_PREFIX\" =~ ^[a-z][a-z0-9-]{0,60}$ ]]\n[[ \"$FOUNDATION_FIXTURE_INDEX\" =~ ^[012]$ ]]\ntest \"$(git rev-parse HEAD)\" = \"$EXPECTED_REVISION\"\nobject=8e5e859d10981e1623d0617e933afc68a9e8770c\nif ! git cat-file -e \"$object^{commit}\"; then\n  git fetch --no-tags origin \"$object\"\nfi\ntest \"$(git rev-parse \"$object^{commit}\")\" = \"$object\"\ngit fsck --connectivity-only --no-reflogs \"$object\"\n"
        },
        {
          "name": "Setup pinned Node",
          "uses": "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
          "with": {
            "node-version-file": ".node-version"
          }
        },
        {
          "name": "Enable pinned pnpm",
          "run": "corepack enable\ncorepack install --global pnpm@11.18.0\n"
        },
        {
          "name": "Frozen install",
          "run": "pnpm install --frozen-lockfile"
        },
        {
          "name": "Run original boundary file and retain observed results",
          "shell": "bash",
          "run": "set -euo pipefail\nmkdir -p \"$RUNNER_TEMP/foundation-evidence\"\nraw=\"$RUNNER_TEMP/foundation-evidence/raw.json\"\nreport=\"$RUNNER_TEMP/foundation-evidence/shard-$FOUNDATION_FIXTURE_INDEX.json\"\nstart=$(date +%s%3N)\nset +e\nnode --test --test-reporter=tap --test-reporter=./scripts/ci/foundation-fixture-sharding.ts \\\n  --test-reporter-destination=stdout --test-reporter-destination=\"$raw\" \\\n  scripts/architecture/source-dependency-adapter-boundaries.test.mjs\nstatus=$?\nset -e\nend=$(date +%s%3N)\njq --arg revision \"$EXPECTED_REVISION\" --argjson index \"$FOUNDATION_FIXTURE_INDEX\" \\\n  --argjson exitCode \"$status\" --argjson start \"$start\" --argjson end \"$end\" \\\n  '. + {revision:$revision,index:$index,exitCode:$exitCode,start:$start,end:$end}' \"$raw\" > \"$report\"\nexit \"$status\"\n"
        },
        {
          "name": "Retain fixture report even on failure",
          "if": "${{ always() }}",
          "uses": "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          "with": {
            "name": "foundation-${{ env.ARTIFACT_PREFIX }}-shard-${{ env.FOUNDATION_FIXTURE_INDEX }}-${{ github.run_attempt }}",
            "path": "${{ runner.temp }}/foundation-evidence/shard-*.json",
            "if-no-files-found": "error",
            "retention-days": 14
          }
        },
        {
          "name": "Publish successful partition for same-run retries",
          "if": "${{ success() }}",
          "uses": "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          "with": {
            "name": "foundation-${{ env.ARTIFACT_PREFIX }}-shard-${{ env.FOUNDATION_FIXTURE_INDEX }}-current",
            "path": "${{ runner.temp }}/foundation-evidence/shard-*.json",
            "if-no-files-found": "error",
            "retention-days": 14,
            "overwrite": true
          }
        }
      ]
    }
  }
};

export function validateFoundationWorkflows(foundation: unknown, shard: unknown): void {
  assert.deepEqual(foundation, foundationContract, 'Foundation fanout workflow contract drift');
  assert.deepEqual(shard, shardContract, 'Foundation partition workflow contract drift');
}

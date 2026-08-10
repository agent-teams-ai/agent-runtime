import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const runtimeRef = "5da51b7b71b1db9ce531f946ec2bb90411a31300";
const workflow = await readFile(
  resolve(repositoryRoot, ".github/workflows/reviewrouter-interaction.yml"),
  "utf8",
);

test("ReviewRouter interaction remains a pinned least-privilege reusable caller", () => {
  assert.match(workflow, /pull_request_review_comment:\n    types: \[created, edited\]/);
  assert.match(workflow, /issue_comment:\n    types: \[created, edited\]/);
  assert.match(workflow, /  workflow_dispatch:\n/);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, new RegExp(
    `^    uses: 777genius/review-router/\\.github/workflows/reviewrouter-interaction-reusable\\.yml@${runtimeRef}$`,
    "m",
  ));
  assert.match(workflow, new RegExp(`^      runtime_ref: "${runtimeRef}"$`, "m"));
  assert.match(workflow, /      review_workflow_file: reviewrouter-codex\.yml/);
  assert.match(workflow, /      discussion_mode: \$\{\{ vars\.REVIEW_ROUTER_DISCUSSION_MODE \|\| 'off' \}\}/);
  assert.match(workflow, /      discussion_model: \$\{\{ vars\.REVIEW_CODEX_MODEL \|\| 'gpt-5\.5' \}\}/);
  assert.match(workflow, /      discussion_reasoning_effort: \$\{\{ vars\.REVIEW_CODEX_EFFORT \|\| 'xhigh' \}\}/);
  assert.match(workflow, /      discussion_max_per_pr: \$\{\{ vars\.REVIEW_ROUTER_DISCUSSION_MAX_PER_PR \|\| '20' \}\}/);
  assert.match(workflow, /      discussion_max_per_thread: \$\{\{ vars\.REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD \|\| '5' \}\}/);
  assert.match(workflow, /      discussion_timeout_seconds: \$\{\{ vars\.REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS \|\| '60' \}\}/);
  assert.match(workflow, /      REVIEW_ROUTER_LEDGER_KEY: \$\{\{ secrets\.REVIEW_ROUTER_LEDGER_KEY \}\}/);
  assert.match(workflow, /      CODEX_AUTH_JSON: \$\{\{ secrets\.REVIEWROUTER_CODEX_AUTH_JSON \}\}/);

  assert.match(workflow, /    permissions:\n      actions: write\n      contents: read\n      issues: read\n      pull-requests: read\n      id-token: write/);
  assert.doesNotMatch(workflow, /(?:contents|issues|pull-requests): write/);
});

test("ReviewRouter caller contains no copied interaction runtime", () => {
  assert.doesNotMatch(workflow, /^    (?:runs-on|env|steps):/m);
  assert.doesNotMatch(workflow, /\.reviewrouter-runtime|actions\/checkout@|actions\/setup-node@/);
  assert.doesNotMatch(workflow, /dist\/index\.js|npm install|RR_RUNTIME_REF|CODEX_AUTH_JSON_PRESENT/);
});

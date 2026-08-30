import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const runtimeRef = "75cbecab131d74021677fcd1fb21962994d306b8";
const checkoutRef = "d23441a48e516b6c34aea4fa41551a30e30af803";
const setupNodeRef = "249970729cb0ef3589644e2896645e5dc5ba9c38";
const expectedWorkflowSha256 =
  "0997a60c648fcb66e341d011a94ea2721585af9b1611c7e07445c372f0ac5008";
const workflow = await readFile(
  resolve(repositoryRoot, ".github/workflows/reviewrouter-interaction.yml"),
  "utf8",
);

test("ReviewRouter interaction remains the exact audited canonical workflow", () => {
  assert.equal(
    createHash("sha256").update(workflow).digest("hex"),
    expectedWorkflowSha256,
  );
});

test("ReviewRouter interaction remains pinned and least privilege", () => {
  assert.match(workflow, /pull_request_review_comment:\n    types: \[created, edited\]/);
  assert.match(workflow, /issue_comment:\n    types: \[created, edited\]/);
  assert.match(workflow, /  workflow_dispatch:\n/);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.ok(
    workflow.includes(
      "    if: ${{ github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot') }}",
    ),
  );
  assert.match(workflow, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(
    workflow,
    new RegExp(`^      RR_RUNTIME_REF: "${runtimeRef}"$`, "m"),
  );
  assert.match(workflow, /^      REVIEWROUTER_API_URL: "https:\/\/api\.reviewrouter\.site"$/m);
  assert.match(workflow, /^      REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"$/m);
  assert.match(workflow, /^      REVIEWROUTER_RUNTIME_CONFIG_MODE: "oidc"$/m);
  assert.match(workflow, /^      REVIEWROUTER_COMMENT_TOKEN_MODE: "app-oidc"$/m);
  assert.match(
    workflow,
    /^      CODEX_AUTH_JSON_PRESENT: \$\{\{ secrets\.REVIEWROUTER_CODEX_AUTH_JSON != '' && '1' \|\| '0' \}\}$/m,
  );
  assert.match(
    workflow,
    new RegExp(`^        uses: actions/checkout@${checkoutRef}$`, "m"),
  );
  assert.match(workflow, /^          repository: 777genius\/review-router$/m);
  assert.match(workflow, /^          ref: \$\{\{ env\.RR_RUNTIME_REF \}\}$/m);
  assert.match(workflow, /^          persist-credentials: false$/m);
  assert.match(
    workflow,
    new RegExp(`^        uses: actions/setup-node@${setupNodeRef}$`, "m"),
  );
  assert.match(workflow, /^        run: npm install -g @openai\/codex@0\.144\.0$/m);
  assert.match(
    workflow,
    /^        if: \$\{\{ steps\.preflight\.outputs\.needs_discussion == 'true' && env\.CODEX_AUTH_JSON_PRESENT == '1' \}\}$/m,
  );
  assert.match(
    workflow,
    /^          CODEX_AUTH_JSON: \$\{\{ secrets\.REVIEWROUTER_CODEX_AUTH_JSON \}\}$/m,
  );
  assert.match(workflow, /^          GITHUB_TOKEN: \$\{\{ github\.token \}\}$/m);

  assert.match(
    workflow,
    /    permissions:\n      contents: read\n      issues: read\n      pull-requests: read\n      id-token: write/,
  );
  assert.doesNotMatch(workflow, /(?:actions|contents|issues|pull-requests): write/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|secrets\.CODEX_AUTH_JSON/);
});

test("ReviewRouter interaction executes only its pinned checked-out runtime", () => {
  assert.doesNotMatch(
    workflow,
    /uses: 777genius\/review-router\/\.github\/workflows\//,
  );
  assert.equal(
    workflow.match(/run: node \.reviewrouter-runtime\/dist\/index\.js/g)?.length,
    2,
  );
  assert.doesNotMatch(workflow, /npm install(?! -g @openai\/codex@0\.144\.0)/);
});

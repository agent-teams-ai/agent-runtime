import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/reviewrouter-review.yml"), "utf8");

// The caller ABI is stable; server admission independently verifies the exact
// executable producer. Do not restore retired client-side OAuth maintenance.
test("ReviewRouter uses the canonical managed caller", () => {
  assert.equal(createHash("sha256").update(workflow).digest("hex"), "d30c359c172a2d2e6ad8af7b5557894ae8d601f5f4957a87153aa93810966cc4");
  assert.match(workflow, /uses: 777genius\/review-router\/\.github\/workflows\/reviewrouter-runtime\.yml@workflow-v1/);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /    permissions:\n      contents: read\n      pull-requests: read\n      id-token: write/);
  assert.doesNotMatch(workflow, /(?:actions|contents|issues|pull-requests): write/);
  assert.doesNotMatch(workflow, /schedule:|CODEX_AUTH_JSON|secrets:|npm install/);
});

test("ReviewRouter dispatch is bound to the server request and reviewed head", () => {
  for (const name of ["review_request_id", "pr_number", "review_head_sha"]) {
    assert.ok(workflow.includes(`${name}: { required: true, type: string }`));
    assert.ok(workflow.includes(`${name}: ${"${{"} inputs.${name} }}`));
  }
  assert.ok(workflow.includes("group: reviewrouter-request-${{ github.repository_id }}-${{ inputs.review_request_id }}"));
  assert.match(workflow, /cancel-in-progress: false/);
});

test("retired OAuth review and interaction workflows stay absent", async () => {
  for (const name of ["reviewrouter-codex.yml", "reviewrouter-interaction.yml"]) {
    await assert.rejects(readFile(resolve(repositoryRoot, ".github/workflows", name)), { code: "ENOENT" });
  }
});
